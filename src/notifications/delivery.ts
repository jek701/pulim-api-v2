import { createHash } from 'node:crypto';
import { env, notificationRecipientAllowed } from '../config/env';
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
  recordChannelDelivery,
} from './queue.repository';
import { markTelegramUnavailable } from './settings';
import { renderNotification } from './render/blocks';
import type { QueuedNotification } from './types';
import { exhaustedAttempts, retryDelay } from './backoff';
import { markCampaignTelegramOutcome } from '../communications/repository';
import { apnsConfigured, classifyApnsResponse, sendApns } from '../push/apns';
import { disableDevice, enabledDevices } from '../push/devices.repository';
import { notificationChannels, quietHoursUntil } from '../push/routing';
import { normalizePushSettings } from '../push/settings';
import { pushPayload, renderPush } from '../push/payload';
import { recordPushLatency } from '../push/latency';
import { scheduledStillRelevant } from '../push/planner';

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
function telegramUnavailable(error: TelegramApiError): 'blocked' | 'unreachable' | null {
  const description = error.description.toLowerCase();
  const code = error.errorCode ?? error.status;
  if (code === 403 && description.includes('blocked')) return 'blocked';
  if (code === 403 && description.includes("can't initiate conversation")) return 'unreachable';
  if (
    code === 400 &&
    (description.includes('chat not found') || description.includes('deactivated'))
  )
    return 'unreachable';
  return null;
}
async function safeStat(sent: boolean, forbidden: boolean): Promise<void> {
  await recordDeliveryStat(sent, forbidden).catch((error) =>
    logger.warn({ err: error }, 'notify.stats.failed'),
  );
}

async function deliver(
  notification: QueuedNotification,
  now: number,
  lastAttemptByChat: Map<string, number>,
): Promise<void> {
  if (!notificationRecipientAllowed(notification.userId)) return;
  // Claim before every state change: an API kick and the worker may see the same row.
  const claimed = await claimNotification(notification.id, now);
  if (!claimed) return;
  const campaignId = claimed.payload.kind === 'campaign' ? claimed.payload.campaignId : null;
  const outcome = async (sent: boolean) => {
    if (campaignId)
      await markCampaignTelegramOutcome(campaignId, claimed.userId, sent ? 'sent' : 'failed');
  };
  if (now > claimed.staleAt) {
    await finishNotification(claimed.id, 'skipped', 'stale');
    await outcome(false);
    return;
  }
  const profile = await getProfile(claimed.userId);
  if (!profile) {
    await finishNotification(claimed.id, 'skipped', 'disabled');
    return;
  }
  const settings = profile.notifications;
  const preferences = normalizePushSettings(settings, profile.timezone);
  const devices = apnsConfigured() ? await enabledDevices(claimed.userId) : [];
  const language = normalizeLanguage(profile.language);
  let push = pushPayload(claimed.payload, language, preferences.timezone, claimed.createdAt);
  const channels = notificationChannels({
    settings,
    activeDevice: devices.length > 0,
    configured: apnsConfigured(),
    group: campaignId ? undefined : push?.group,
    digest: !push,
    pushOnly: claimed.pushOnly,
  });
  if (campaignId) {
    channels.push &&= profile.communications?.marketing.inApp !== false;
    channels.telegram &&= profile.communications?.marketing.telegram === true;
  }
  if (!channels.push && !channels.telegram) {
    await finishNotification(claimed.id, 'skipped', 'disabled');
    await outcome(false);
    return;
  }
  if (claimed.pushOnly && !(await scheduledStillRelevant(claimed, profile, now))) {
    await finishNotification(claimed.id, 'skipped', 'no_longer_relevant');
    return;
  }
  if (claimed.pushOnly)
    push = pushPayload(claimed.payload, language, preferences.timezone, claimed.createdAt);
  const sensitive = push?.type === 'budget_100' || push?.type === 'apple_billing_failed';
  const quietUntil = sensitive
    ? null
    : quietHoursUntil(now, preferences.timezone, preferences.quietHours);
  if (quietUntil !== null) {
    await deferNotification(claimed.id, quietUntil);
    return;
  }
  const habit = push?.group === 'habit';
  const reservation = claimed.safetyCounted
    ? 'ok'
    : await reserveSafetySlot(claimed.userId, now, false, habit);
  if (reservation !== 'ok') {
    await finishNotification(
      claimed.id,
      'skipped',
      reservation === 'cap' ? 'safety_cap' : 'disabled',
    );
    await outcome(false);
    return;
  }
  let unrecordedSend = false;
  let messageId: number | null = null;
  const includeIntro = !campaignId && !settings?.introSentAt;
  try {
    if (channels.push && push) {
      for (const device of devices) {
        if (claimed.deliveredDevices?.includes(device.id)) continue;
        const sendAt = Date.now();
        const result = await sendApns(device, renderPush(push, language, claimed.id), {
          expiration: Math.floor(claimed.staleAt / 1000),
          collapseId: push.type.startsWith('budget_')
            ? `budget:${createHash('sha256')
                .update(push.entityId ?? '')
                .digest('hex')
                .slice(0, 48)}`
            : claimed.id,
        });
        recordPushLatency({
          type: push.type,
          eventAt: push.eventAt,
          enqueuedAt: claimed.createdAt,
          sendAt,
          responseAt: Date.now(),
          status: result.status,
        });
        const classification = classifyApnsResponse(result);
        if (classification === 'disable') {
          await disableDevice(device.id, result.reason ?? 'Unregistered', device.lastSeenAt);
          continue;
        }
        if (result.retryAt && result.retryAt > Date.now()) {
          if (!claimed.safetyCounted) await releaseSafetySlot(claimed.userId, now, habit);
          await deferNotification(claimed.id, result.retryAt);
          return;
        }
        if (classification !== 'success') {
          if (classification === 'permanent') {
            await finishNotification(claimed.id, 'failed', result.reason ?? 'APNsRejected');
            if (!claimed.safetyCounted) await releaseSafetySlot(claimed.userId, now, habit);
            await outcome(false);
            return;
          }
          throw new Error(`APNs:${result.status}:${result.reason ?? 'Retry'}`);
        }
        unrecordedSend = true;
        await recordChannelDelivery(claimed, device.id);
        claimed.safetyCounted = true;
        unrecordedSend = false;
        claimed.deliveredDevices = [...(claimed.deliveredDevices ?? []), device.id];
      }
      if (!claimed.deliveredDevices?.length) {
        // A terminal token failure falls back immediately, even on the first affected job.
        channels.telegram = notificationChannels({
          settings,
          activeDevice: false,
          configured: apnsConfigured(),
        }).telegram;
        if (campaignId) channels.telegram &&= profile.communications?.marketing.telegram === true;
      }
      if (!claimed.deliveredDevices?.length && !channels.telegram) {
        if (!claimed.safetyCounted) await releaseSafetySlot(claimed.userId, now, habit);
        await finishNotification(claimed.id, 'skipped', 'no_enabled_devices');
        await outcome(false);
        return;
      }
    }
    if (channels.telegram && !claimed.telegramDelivered) {
      const chatId = settings!.telegram.chatId!;
      const chatDelay = Math.max(0, 1000 - (Date.now() - (lastAttemptByChat.get(chatId) ?? 0)));
      if (chatDelay) await wait(chatDelay);
      const rendered = renderNotification(
        push && claimed.payload.kind === 'push' ? push : claimed.payload,
        language,
        includeIntro,
      );
      lastAttemptByChat.set(chatId, Date.now());
      const message = await sendMessage(chatId, rendered.text, { reply_markup: rendered.keyboard });
      unrecordedSend = true;
      messageId = message.message_id;
      await recordChannelDelivery(claimed, undefined, messageId);
      claimed.safetyCounted = true;
      unrecordedSend = false;
      await saveMessage({
        userId: claimed.userId,
        chatId,
        messageId,
        kind: 'notification',
        items: rendered.items,
        options: null,
        notification: {
          payload: claimed.payload,
          introIncluded: includeIntro,
          completedActions: [],
        },
      }).catch((error) =>
        logger.error({ err: error, uid: claimed.userId }, 'notify.message_context.failed'),
      );
    } else if (claimed.telegramDelivered) messageId = claimed.messageId;
    await markNotificationSent(claimed, messageId, channels.telegram && includeIntro);
    await outcome(true);
    await safeStat(true, false);
  } catch (error) {
    if (unrecordedSend) {
      await finishNotification(claimed.id, 'failed', 'post_send_state_failed').catch(
        () => undefined,
      );
      logger.error(
        { err: error, uid: claimed.userId, type: claimed.type },
        'notify.post_send_state_failed',
      );
      return;
    }
    if (!claimed.safetyCounted)
      await releaseSafetySlot(claimed.userId, now, habit).catch(() => undefined);
    if (error instanceof TelegramApiError) {
      const unavailable = telegramUnavailable(error);
      if (unavailable) {
        await markTelegramUnavailable(claimed.userId, unavailable, error.description);
        if (claimed.deliveredDevices?.length) {
          await markNotificationSent(claimed, null, false);
          await outcome(true);
        } else {
          await finishNotification(claimed.id, 'cancelled', unavailable);
          await outcome(false);
        }
        await safeStat(false, true);
        return;
      }
      if ((error.errorCode ?? error.status) === 429 && error.retryAfter !== null) {
        await retryNotification(
          claimed.id,
          Date.now() + error.retryAfter * 1000,
          error.message,
          true,
        );
        return;
      }
    }
    await safeStat(false, false);
    if (exhaustedAttempts(claimed.attempts, env.NOTIFY_MAX_ATTEMPTS)) {
      await finishNotification(
        claimed.id,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      await outcome(false);
      return;
    }
    await retryNotification(
      claimed.id,
      Date.now() + retryDelay(claimed.attempts),
      error instanceof Error ? error.message : String(error),
    );
  }
}
export async function runDelivery(now = Date.now()): Promise<number> {
  if (!env.NOTIFICATIONS_ENABLED || !env.BACKGROUND_JOBS_ENABLED || env.MAINTENANCE_MODE) return 0;
  const { runBudgetChecks } = await import('./planner');
  await runBudgetChecks(now);
  const recovered = await recoverExpiredLeases(now);
  if (recovered) logger.warn({ recovered }, 'notify.leases.failed');
  const notifications = await listDueNotifications(now, env.NOTIFY_DELIVERY_BATCH);
  const lastAttemptByChat = new Map<string, number>();
  const globalDelay = Math.ceil(1000 / env.NOTIFY_SEND_RATE_PER_SEC);
  for (const notification of notifications) {
    try {
      await deliver(notification, Date.now(), lastAttemptByChat);
    } catch (error) {
      logger.error({ err: error, id: notification.id }, 'notify.delivery.job_failed');
    }
    if (globalDelay) await wait(globalDelay);
  }
  return notifications.length;
}
