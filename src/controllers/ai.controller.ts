import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import { getIsPremium } from '../services/entitlement.service';
import { FREE_LIMITS } from '../domain/entitlements';
import * as ai from '../services/ai.service';

const LANGUAGE_NAMES = {
  en: 'English',
  ru: 'Russian',
  uz: 'Uzbek',
} as const;

const languageName = (language: keyof typeof LANGUAGE_NAMES | undefined): string =>
  LANGUAGE_NAMES[language ?? 'en'];

export const postForecast = asyncHandler(async (req, res) => {
  if (!ai.aiConfigured()) throw new AppError(503, 'AI_UNAVAILABLE', 'AI is not configured on this server.');
  res.json(await ai.getForecast(req.uid, languageName(req.body.language)));
});

export const postFeedback = asyncHandler(async (req, res) => {
  await ai.saveFeedback(req.uid, req.body);
  res.status(204).end();
});

function publicStreamError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 429) return 'AI is temporarily busy. Please try again shortly.';
  return 'AI could not complete the response. Please try again.';
}

export const postChat = asyncHandler(async (req: Request, res: Response) => {
  if (!ai.aiConfigured()) throw new AppError(503, 'AI_UNAVAILABLE', 'AI is not configured on this server.');

  const message: string = req.body.message;
  const language = languageName(req.body.language);
  let chatId: string | undefined = req.body.chatId;
  const isPremium = await getIsPremium(req.uid);

  let history: ai.ChatTurn[] = [];
  if (chatId) {
    history = await ai.loadChatHistory(req.uid, chatId);
  } else if (!isPremium && (await ai.countChats(req.uid)) >= FREE_LIMITS.aiChats) {
    throw AppError.forbidden('LIMIT_REACHED', `The free plan allows ${FREE_LIMITS.aiChats} AI chat.`);
  }

  const snapshot = await ai.assembleSnapshot(req.uid, language);
  const model = ai.selectChatModel(isPremium);
  await ai.consumeAiMessage(req.uid, isPremium);

  try {
    if (chatId) await ai.appendUserMessage(chatId, message);
    else chatId = await ai.createChat(req.uid, message);
  } catch (err) {
    await ai.refundAiMessage(req.uid, isPremium);
    throw err;
  }

  const startedAt = Date.now();

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  send('meta', { chatId });

  const aborter = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) aborter.abort();
  });

  let fullText = '';
  let usage: ai.AiTokenUsage | null = null;
  let incompleteReason: 'max_output_tokens' | 'content_filter' | 'unknown' | null = null;
  let refundRequired = false;
  try {
    const stream = await ai.streamChat({
      uid: req.uid,
      model,
      snapshot,
      language,
      history,
      userMessage: message,
      signal: aborter.signal,
    });
    for await (const event of stream) {
      if (aborter.signal.aborted) break;
      if (event.type === 'response.output_text.delta') {
        fullText += event.delta;
        send('delta', { text: event.delta });
      } else if (event.type === 'response.completed') {
        fullText = event.response.output_text || fullText;
        usage = ai.normalizeUsage(event.response.usage);
      } else if (event.type === 'response.incomplete') {
        fullText = event.response.output_text || fullText;
        usage = ai.normalizeUsage(event.response.usage);
        incompleteReason = event.response.incomplete_details?.reason ?? 'unknown';
        logger.warn(
          {
            uid: req.uid,
            chatId,
            model,
            incompleteReason,
            usage,
            visibleCharacters: fullText.length,
          },
          'OpenAI chat response incomplete',
        );
        if (incompleteReason !== 'max_output_tokens' || !fullText.trim()) {
          refundRequired = true;
          throw new Error(`OpenAI response incomplete: ${incompleteReason}.`);
        }
        break;
      } else if (event.type === 'response.failed') {
        usage = ai.normalizeUsage(event.response.usage);
        refundRequired = true;
        throw new Error(event.response.error?.message || 'OpenAI response failed.');
      } else if (event.type === 'error') {
        refundRequired = true;
        throw new Error(event.message);
      }
    }

    if (aborter.signal.aborted) {
      if (!fullText) await ai.refundAiMessage(req.uid, isPremium);
      await ai.recordAiUsage({
        uid: req.uid,
        feature: 'chat',
        model,
        usage,
        latencyMs: Date.now() - startedAt,
        success: false,
      });
      res.end();
      return;
    }
    if (!fullText.trim()) throw new Error('OpenAI returned an empty response.');

    const incomplete = incompleteReason === 'max_output_tokens';
    if (incomplete) await ai.refundAiMessage(req.uid, isPremium);

    try {
      await ai.appendAssistantMessage(chatId, fullText);
    } catch (err) {
      // The user already received the answer. Do not turn a persistence issue
      // into a failed chat response, but keep enough metadata to investigate it.
      logger.error({ err, uid: req.uid, chatId }, 'AI assistant message persistence failed');
    }
    await ai.recordAiUsage({
      uid: req.uid,
      feature: 'chat',
      model,
      usage,
      latencyMs: Date.now() - startedAt,
      success: !incomplete,
      incompleteReason,
    });
    send('done', { text: fullText, chatId, incomplete });
    res.end();
  } catch (err) {
    const aborted = aborter.signal.aborted || (err as { name?: string }).name === 'AbortError';
    if (refundRequired || !fullText) await ai.refundAiMessage(req.uid, isPremium);
    await ai.recordAiUsage({
      uid: req.uid,
      feature: 'chat',
      model,
      usage,
      latencyMs: Date.now() - startedAt,
      success: false,
      incompleteReason,
    });
    if (!aborted) {
      logger.error({ err, uid: req.uid, chatId, model }, 'AI chat failed');
      send('error', { message: publicStreamError(err) });
    }
    res.end();
  }
});
