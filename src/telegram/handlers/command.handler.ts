import { getIsPremium } from '../../services/entitlement.service';
import { sendMessage } from '../client';
import { resolveUserContext } from '../context';
import { t } from '../i18n';
import { languageKeyboard, openAppKeyboard, premiumKeyboard, welcomeKeyboard } from '../render';
import { clearSession } from '../sessions.repository';

export async function handleCommand(input: {
  command: string;
  chatId: string;
  telegramId: string;
}): Promise<string | null> {
  const context = await resolveUserContext(input.telegramId, input.chatId);
  if (!context) {
    await sendMessage(input.chatId, t('uz', 'not_linked'), { reply_markup: openAppKeyboard('uz') });
    return null;
  }
  if (input.command === '/cancel') {
    await clearSession(input.chatId);
    await sendMessage(input.chatId, t(context.language, 'cancelled'));
    return context.uid;
  }
  if (input.command === '/start' || input.command === '/help') {
    await sendMessage(input.chatId, t(context.language, 'welcome'), {
      reply_markup: welcomeKeyboard(context.language),
    });
    return context.uid;
  }
  if (input.command === '/language' || input.command === '/lang' || input.command === '/til') {
    await sendMessage(input.chatId, t(context.language, 'language_prompt'), {
      reply_markup: languageKeyboard(),
    });
    return context.uid;
  }
  if (!(await getIsPremium(context.uid))) {
    await sendMessage(input.chatId, t(context.language, 'premium_required'), {
      reply_markup: premiumKeyboard(context.language),
    });
    return context.uid;
  }
  await sendMessage(input.chatId, t(context.language, 'welcome'), {
    reply_markup: welcomeKeyboard(context.language),
  });
  return context.uid;
}
