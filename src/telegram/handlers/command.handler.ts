import { sendMessage } from '../client';
import { resolveUserContext } from '../context';
import { languageFromTelegram, t } from '../i18n';
import { initialLanguageKeyboard, languageKeyboard, loginKeyboard, welcomeKeyboard } from '../render';
import { clearSession } from '../sessions.repository';
import { setNotificationsEnabled } from '../../notifications/settings';
import { saveMessage } from '../messages.repository';
import { devNotesUids } from '../../config/env';
import { createDevNote } from '../../devNotes/devNotes.repository';

export async function handleCommand(input: {
  command: string;
  argument?: string;
  /** Text after the command with line breaks intact (`argument` collapses whitespace). */
  rawArgument?: string;
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
  // Owner-only: everyone else falls through to the default welcome below.
  if (input.command === '/idea' && devNotesUids.has(context.uid)) {
    const comment = (input.rawArgument ?? '').slice(0, 4_000);
    if (!comment) {
      await sendMessage(input.chatId, '💡 Напиши идею после команды: /idea текст');
      return context.uid;
    }
    const note = await createDevNote({ uid: context.uid, source: 'telegram', comment });
    await sendMessage(input.chatId, `💡 Идея сохранена (#${note.id.slice(0, 6)}). Возьму в работу при следующей обработке.`);
    return context.uid;
  }
  if (input.command === '/cancel') {
    await clearSession(input.chatId);
    await sendMessage(input.chatId, t(context.language, 'cancelled'));
    return context.uid;
  }
  if (input.command === '/stop') {
    await setNotificationsEnabled(context.uid, false);
    const message = await sendMessage(input.chatId, context.language === 'uz'
      ? '🔕 Pulim eslatmalari o‘chirildi. Ularni ilova sozlamalarida qayta yoqishingiz mumkin.'
      : context.language === 'en'
        ? '🔕 Pulim reminders are off. You can enable them again in the app settings.'
        : '🔕 Напоминания Pulim отключены. Включить их снова можно в настройках приложения.', {
      reply_markup: { inline_keyboard: [[{
        text: context.language === 'uz'
          ? '🔔 Qayta yoqish'
          : context.language === 'en'
            ? '🔔 Enable again'
            : '🔔 Включить обратно',
        callback_data: 'v1:notifyon:0',
      }]] },
    });
    await saveMessage({
      userId: context.uid,
      chatId: input.chatId,
      messageId: message.message_id,
      kind: 'notification',
      items: [],
      options: null,
    }).catch(() => undefined);
    return context.uid;
  }
  if (input.command === '/start' && input.argument?.toLowerCase() === 'notify') {
    await setNotificationsEnabled(context.uid, true);
    await sendMessage(input.chatId, context.language === 'uz'
      ? '🔔 Pulim eslatmalari yoqildi. Faqat muhim narsa bo‘lsa yozaman.'
      : context.language === 'en'
        ? '🔔 Pulim reminders are on. I will only message when there is something useful to say.'
        : '🔔 Напоминания Pulim включены. Напишу только когда будет что-то полезное.');
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
