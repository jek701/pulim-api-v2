import { sendMessage } from '../client';
import { resolveUserContext } from '../context';
import { languageFromTelegram, t } from '../i18n';
import { initialLanguageKeyboard, languageKeyboard, loginKeyboard, welcomeKeyboard } from '../render';
import { clearSession } from '../sessions.repository';

export async function handleCommand(input: {
  command: string;
  chatId: string;
  telegramId: string;
  languageCode?: string;
}): Promise<string | null> {
  const context = await resolveUserContext(input.telegramId, input.chatId);
  if (!context) {
    const language = languageFromTelegram(input.languageCode);
    if (input.command === '/start' || input.command === '/help') {
      await sendMessage(input.chatId, t(language, 'language_prompt_initial'), {
        reply_markup: initialLanguageKeyboard(),
      });
    } else {
      await sendMessage(input.chatId, t(language, 'not_linked'), {
        reply_markup: loginKeyboard(language),
      });
    }
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
  await sendMessage(input.chatId, t(context.language, 'welcome'), {
    reply_markup: welcomeKeyboard(context.language),
  });
  return context.uid;
}
