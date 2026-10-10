import { getProfile } from '../../repositories/profile.repository';
import { findTelegramUser } from '../../repositories/telegramUser.repository';
import { consumeInvitePick, memberName, recordInviteDelivery } from '../../services/household.service';
import { logger } from '../../utils/logger';
import { sendMessage, TelegramApiError } from '../client';
import { resolveUserContext } from '../context';
import {
  inviteDeliveredText,
  inviteExpiredText,
  inviteNotDeliveredText,
  partnerInviteMessage,
  sharedUserName,
} from '../familyInvite';
import { normalizeLanguage } from '../i18n';

export interface SharedTelegramUser {
  user_id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * Sends the invite to a picked partner through the bot. Only works for someone who
 * already uses Pulim in Telegram and has not blocked the bot; any failure is reported
 * as "not delivered" so the inviter falls back to sending the card themselves.
 */
async function notifyPartner(
  partnerTelegramId: string,
  inviterTelegramId: string,
  invite: { token: string; inviterName: string; householdName: string },
): Promise<boolean> {
  if (partnerTelegramId === inviterTelegramId) return false;
  const record = await findTelegramUser(partnerTelegramId, partnerTelegramId);
  const uid = record?.data.profileUid ?? record?.data.uid;
  if (typeof uid !== 'string' || !uid) return false;
  const profile = await getProfile(uid);
  if (!profile) return false;
  const message = partnerInviteMessage(
    normalizeLanguage(profile.language),
    invite.inviterName,
    invite.householdName,
    invite.token,
  );
  try {
    await sendMessage(String(record?.data.chatId ?? partnerTelegramId), message.text, {
      reply_markup: message.reply_markup,
    });
    return true;
  } catch (error) {
    if (error instanceof TelegramApiError) {
      logger.info({ errorCode: error.errorCode }, 'telegram.family_invite.partner_unreachable');
      return false;
    }
    throw error;
  }
}

/** Handles the `users_shared` message produced by the Mini App contact picker. */
export async function handleFamilyInvitePick(input: {
  chatId: string;
  telegramId: string;
  requestId: number;
  users: SharedTelegramUser[];
}): Promise<string | null> {
  const context = await resolveUserContext(input.telegramId, input.chatId);
  const language = context?.language ?? 'uz';
  const reply = (text: string) => sendMessage(input.chatId, text).catch((error: unknown) => {
    logger.warn({ err: error }, 'telegram.family_invite.reply_failed');
  });

  const pick = await consumeInvitePick(input.telegramId, input.requestId);
  const partner = input.users[0];
  if (!pick || !partner) {
    await reply(inviteExpiredText(language));
    return context?.uid ?? null;
  }

  const recipientName = sharedUserName(partner, language);
  const delivered = await notifyPartner(String(partner.user_id), input.telegramId, {
    token: pick.token,
    inviterName: memberName(pick.household, pick.inviterUid),
    householdName: String(pick.household.name ?? ''),
  });
  await recordInviteDelivery(pick.token, { status: delivered ? 'delivered' : 'not_delivered', recipientName });
  await reply(delivered
    ? inviteDeliveredText(language, recipientName, String(pick.household.name ?? ''))
    : inviteNotDeliveredText(language, recipientName));
  return pick.inviterUid;
}
