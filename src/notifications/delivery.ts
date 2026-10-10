import { env } from '../config/env';
import { getProfile } from '../repositories/profile.repository';
import { TelegramApiError, sendMessage } from '../telegram/client';
import { normalizeLanguage } from '../telegram/i18n';
import { saveMessage } from '../telegram/messages.repository';
import { logger } from '../utils/logger';
import {
  claimNotification,
  deferNotification,
  finishNotification,
  listDueNotifications,
  markNotificationSent,
  recordDeliveryStat,
  recoverExpiredLeases,
  releaseSafetySlot,
  reserveSafetySlot,
  retryNotification,
} from './queue.repository';
import { isQuietHour, shiftOutOfQuietHours } from './schedule';
import { markTelegramUnavailable } from './settings';
import { renderNotification } from './render/blocks';
import type { QueuedNotification } from './types';
import { exhaustedAttempts, retryDelay } from './backoff';
import { markCampaignTelegramOutcome } from '../communications/repository';

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function telegramUnavailable(error: TelegramApiError): 'blocked' | 'unreachable' | null {
  const description = error.description.toLowerCase();
  const code = error.errorCode ?? error.status;
  if (code === 403 && description.includes('blocked')) return 'blocked';
  if (code === 403 && description.includes("can't initiate conversation")) return 'unreachable';
  if (code === 400 && (description.includes('chat not found') || description.includes('deactivated'))) return 'unreachable';
  return null;
}

async function safeStat(sent: boolean, forbidden: boolean): Promise<void> {
  await recordDeliveryStat(sent, forbidden).catch((error) => logger.warn({ err: error }, 'notify.stats.failed'));
}

async function deliver(
  notification: QueuedNotification,
  now: number,
  lastAttemptByChat: Map<string, number>,
): Promise<void> {
  if (now > notification.staleAt) {
    await finishNotification(notification.id, 'skipped', 'stale');
    if (notification.payload.kind === 'campaign') {
      await markCampaignTelegramOutcome(notification.payload.campaignId, notification.userId, 'failed');
    }
    logger.info({ uid: notification.userId, type: notification.type, skipReason: 'stale' }, 'notify.skipped');
    return;
  }
  const claimed = await claimNotification(notification.id, now);
  if (!claimed) return;
  const profile = await getProfile(claimed.userId);
  const settings = profile?.notifications;
  const campaign = claimed.payload.kind === 'campaign';
  const campaignId = claimed.payload.kind === 'campaign' ? claimed.payload.campaignId : null;
  const channelEnabled = campaign ? profile?.communications?.marketing.telegram === true : settings?.enabled === true;
  if (!profile || !channelEnabled || !settings?.telegram.chatId
    || settings.telegram.status === 'blocked'
    || settings.telegram.status === 'unreachable') {
    await finishNotification(claimed.id, 'skipped', 'disabled');
    if (campaignId) await markCampaignTelegramOutcome(campaignId, claimed.userId, 'failed');
    logger.info({ uid: claimed.userId, type: claimed.type, skipReason: 'disabled' }, 'notify.skipped');
    return;
  }
  if (isQuietHour(now, env.NOTIFY_TIMEZONE, env.NOTIFY_QUIET_START_HOUR, env.NOTIFY_QUIET_END_HOUR)) {
    const until = shiftOutOfQuietHours(now, env.NOTIFY_TIMEZONE, env.NOTIFY_QUIET_START_HOUR, env.NOTIFY_QUIET_END_HOUR);
    await deferNotification(claimed.id, until);
    return;
  }
  const deliveryChatId = settings.telegram.chatId;
  const previousAttempt = lastAttemptByChat.get(deliveryChatId) ?? 0;
  const chatDelay = Math.max(0, 1_000 - (Date.now() - previousAttempt));
  if (chatDelay) await wait(chatDelay);
  const reservation = await reserveSafetySlot(claimed.userId, now, campaign);
  if (reservation !== 'ok') {
    await finishNotification(claimed.id, 'skipped', reservation === 'cap' ? 'safety_cap' : 'disabled');
    if (campaignId) await markCampaignTelegramOutcome(campaignId, claimed.userId, 'failed');
    if (reservation === 'cap') logger.error({ uid: claimed.userId, type: claimed.type }, 'notify.safety_cap');
    return;
  }

  const language = normalizeLanguage(profile.language);
  const includeIntro = !campaign && !settings.introSentAt;
  const rendered = renderNotification(claimed.payload, language, includeIntro);
  let sentToTelegram = false;
  try {
    lastAttemptByChat.set(deliveryChatId, Date.now());
    const message = await sendMessage(deliveryChatId, rendered.text, { reply_markup: rendered.keyboard });
    sentToTelegram = true;
    await markNotificationSent(claimed, message.message_id, includeIntro);
    if (campaignId) await markCampaignTelegramOutcome(campaignId, claimed.userId, 'sent');
    await safeStat(true, false);
    await saveMessage({
      userId: claimed.userId,
      chatId: deliveryChatId,
      messageId: message.message_id,
      kind: 'notification',
      items: rendered.items,
      options: null,
      notification: { payload: claimed.payload, introIncluded: includeIntro, completedActions: [] },
    }).catch((error) => logger.error({ err: error, uid: claimed.userId, messageId: message.message_id }, 'notify.message_context.failed'));
    logger.info({ uid: claimed.userId, type: claimed.type, messageId: message.message_id, latencyMs: Date.now() - claimed.runAt }, 'notify.sent');
  } catch (error) {
    if (sentToTelegram) {
      await finishNotification(claimed.id, 'failed', 'post_send_state_failed').catch(() => undefined);
      if (campaignId) await markCampaignTelegramOutcome(campaignId, claimed.userId, 'failed').catch(() => undefined);
      logger.error({ err: error, uid: claimed.userId, type: claimed.type }, 'notify.post_send_state_failed');
      return;
    }
    await releaseSafetySlot(claimed.userId).catch(() => undefined);
    if (error instanceof TelegramApiError) {
      const unavailable = telegramUnavailable(error);
      if (unavailable) {
        await markTelegramUnavailable(claimed.userId, unavailable, error.description);
        await finishNotification(claimed.id, 'cancelled', unavailable);
        if (campaignId) await markCampaignTelegramOutcome(campaignId, claimed.userId, 'failed');
        await safeStat(false, true);
        logger.warn({ uid: claimed.userId, reason: unavailable }, 'notify.blocked');
        return;
      }
      if ((error.errorCode ?? error.status) === 429 && error.retryAfter !== null) {
        await retryNotification(claimed.id, Date.now() + error.retryAfter * 1_000 + Math.floor(Math.random() * 1_001), error.message, true);
        await safeStat(false, false);
        return;
      }
    }
    await safeStat(false, false);
    if (exhaustedAttempts(claimed.attempts, env.NOTIFY_MAX_ATTEMPTS)) {
      await finishNotification(claimed.id, 'failed', error instanceof Error ? error.message : String(error));
      if (campaignId) await markCampaignTelegramOutcome(campaignId, claimed.userId, 'failed');
      logger.error({ err: error, uid: claimed.userId, type: claimed.type, attempts: claimed.attempts }, 'notify.failed');
      return;
    }
    await retryNotification(claimed.id, Date.now() + retryDelay(claimed.attempts), error instanceof Error ? error.message : String(error));
  }
}

export async function runDelivery(now = Date.now()): Promise<number> {
  if (!env.NOTIFICATIONS_ENABLED) return 0;
  const recovered = await recoverExpiredLeases(now);
  if (recovered) logger.warn({ recovered }, 'notify.leases.failed');
  const notifications = await listDueNotifications(now, env.NOTIFY_DELIVERY_BATCH);
  const lastAttemptByChat = new Map<string, number>();
  const globalDelay = Math.ceil(1_000 / env.NOTIFY_SEND_RATE_PER_SEC);
  for (const notification of notifications) {
    await deliver(notification, Date.now(), lastAttemptByChat);
    if (globalDelay) await wait(globalDelay);
  }
  return notifications.length;
}
