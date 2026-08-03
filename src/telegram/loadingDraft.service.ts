import { setTimeout as delay } from 'node:timers/promises';
import type { SupportedLanguage } from './types';
import { editMessageText, sendMessage } from './client';

const PHRASES: Record<SupportedLanguage, string[]> = {
  ru: [
    '🧮 Считаю каждую суму…',
    '🕵️ Ищу, куда убежали деньги…',
    '📊 Сверяю расходы с бюджетом…',
    '✨ Навожу порядок в цифрах…',
  ],
  uz: [
    '🧮 Har bir so‘mni sanayapman…',
    '🕵️ Pullar qayerga ketganini izlayapman…',
    '📊 Xarajatlarni tekshiryapman…',
    '✨ Raqamlarni tartiblayapman…',
  ],
  en: [
    '🧮 Counting every sum…',
    '🕵️ Finding where the money went…',
    '📊 Checking spending against the budget…',
    '✨ Putting the numbers in order…',
  ],
};

const UZBEK_WORDS = /\b(qancha|qanday|xarajat|daromad|pulim|pullar|bugun|kecha|uchun|oyda|bo‘yicha|qayerga|sarfladim)\b/iu;
const UZBEK_CYRILLIC_WORDS = /(қанча|қандай|харажат|даромад|пул|бугун|кеча|учун|ойда|қаерга)/iu;
const ENGLISH_WORDS = /\b(what|how|where|much|expenses?|income|spent|spending|today|yesterday|month|budget|money)\b/iu;

export function detectMessageLanguage(text: string, fallback: SupportedLanguage): SupportedLanguage {
  if (UZBEK_CYRILLIC_WORDS.test(text)) return 'uz';
  if (/[а-яё]/iu.test(text)) return 'ru';
  if (/\b[og][ʻʼ‘’']/iu.test(text) || UZBEK_WORDS.test(text)) return 'uz';
  if (ENGLISH_WORDS.test(text)) return 'en';
  return fallback;
}

export function loadingPhrases(language: SupportedLanguage): readonly string[] {
  return PHRASES[language];
}

export interface BudgetLoadingMessage {
  messageId: number;
  stop(): Promise<void>;
}

/** Sends a real reply immediately, then animates it by editing the same message. */
export async function startBudgetLoadingMessage(input: {
  chatId: string;
  replyToMessageId: number;
  language: SupportedLanguage;
}): Promise<BudgetLoadingMessage> {
  const firstCharacters = Array.from(PHRASES[input.language][0]);
  const sent = await sendMessage(input.chatId, firstCharacters[0], {
    reply_parameters: {
      message_id: input.replyToMessageId,
      allow_sending_without_reply: true,
    },
  });
  const controller = new AbortController();
  const task = (async () => {
    let phraseIndex = 0;
    while (!controller.signal.aborted) {
      const cycleStartedAt = Date.now();
      const characters = Array.from(PHRASES[input.language][phraseIndex]);
      const frameCount = Math.min(7, characters.length);
      for (let frame = 1; frame <= frameCount; frame += 1) {
        const end = Math.ceil(characters.length * frame / frameCount);
        await editMessageText(
          input.chatId,
          sent.message_id,
          characters.slice(0, end).join(''),
          {},
          controller.signal,
        );
        await delay(120, undefined, { signal: controller.signal });
      }
      phraseIndex = (phraseIndex + 1) % PHRASES[input.language].length;
      const remaining = Math.max(0, 3_000 - (Date.now() - cycleStartedAt));
      await delay(remaining, undefined, { signal: controller.signal });
    }
  })().catch(() => undefined);

  return {
    messageId: sent.message_id,
    async stop() {
      controller.abort();
      await task;
    },
  };
}
