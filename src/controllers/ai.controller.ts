import type { Request, Response } from 'express';
import type Anthropic from '@anthropic-ai/sdk';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import { getIsPremium } from '../services/entitlement.service';
import { FREE_LIMITS } from '../domain/entitlements';
import * as ai from '../services/ai.service';

export const postForecast = asyncHandler(async (req, res) => {
  const language = req.body.language ?? 'en';
  res.json({ text: await ai.getForecast(req.uid, language) });
});

export const postChat = asyncHandler(async (req: Request, res: Response) => {
  // Fail cleanly (JSON) before any side effects if AI isn't configured.
  if (!ai.aiConfigured()) throw new AppError(503, 'AI_UNAVAILABLE', 'AI is not configured on this server.');

  const message: string = req.body.message;
  const language: string = req.body.language ?? 'en';
  let chatId: string | undefined = req.body.chatId;

  const isPremium = await getIsPremium(req.uid);

  // --- Pre-flight (all failures here return clean JSON, before SSE headers) ---
  let history: ai.ChatTurn[] = [];
  if (chatId) {
    history = await ai.loadChatHistory(req.uid, chatId);
  } else if (!isPremium && (await ai.countChats(req.uid)) >= FREE_LIMITS.aiChats) {
    throw AppError.forbidden('LIMIT_REACHED', `The free plan allows ${FREE_LIMITS.aiChats} AI chat.`);
  }

  await ai.consumeAiMessage(req.uid, isPremium);

  if (chatId) await ai.appendUserMessage(chatId, message);
  else chatId = await ai.createChat(req.uid, message);

  const snapshot = await ai.assembleSnapshot(req.uid, language);
  const model = ai.selectChatModel(isPremium);

  // --- Stream over SSE ---
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('meta', { chatId });

  const aborter = new AbortController();
  req.on('close', () => aborter.abort());

  let fullText = '';
  try {
    const stream = ai.streamChat({ model, snapshot, language, history, userMessage: message, signal: aborter.signal });
    for await (const event of stream) {
      if (aborter.signal.aborted) break;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullText += event.delta.text;
        send('delta', { text: event.delta.text });
      }
    }
    if (aborter.signal.aborted) {
      res.end();
      return;
    }
    const final = await stream.finalMessage();
    const finalText =
      final.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('') || fullText;
    await ai.appendAssistantMessage(chatId, finalText);
    send('done', { text: finalText, chatId });
    res.end();
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      res.end();
      return;
    }
    send('error', { message: (err as Error).message });
    res.end();
  }
});
