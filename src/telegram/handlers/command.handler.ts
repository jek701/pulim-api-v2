import { getIsPremium } from '../../services/entitlement.service';
import { sendMessage } from '../client';
import { resolveUserContext } from '../context';
import { t } from '../i18n';
import { openAppKeyboard, premiumKeyboard } from '../render';
import { clearSession } from '../sessions.repository';

export async function handleCommand(input: {
  command: string;
  chatId: string;
  telegramId: string;
}): Promise<string | null> {
  const context = await resolveUserContext(input.telegramId, input.chatId);
  if (!context) {
    await sendMessage(input.chatId, t('ru', 'not_linked'), { reply_markup: openAppKeyboard('ru') });
    return null;
  }
  if (input.command === '/cancel') {
    await clearSession(input.chatId);
    await sendMessage(input.chatId, t(context.language, 'cancelled'));
    return context.uid;
  }
  if (!(await getIsPremium(context.uid))) {
    await sendMessage(input.chatId, t(context.language, 'premium_required'), {
      reply_markup: premiumKeyboard(context.language),
    });
    return context.uid;
  }
  await sendMessage(input.chatId, t(context.language, 'welcome'), {
    reply_markup: openAppKeyboard(context.language),
  });
  return context.uid;
}

