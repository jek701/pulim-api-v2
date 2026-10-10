import { toFile } from 'openai';
import { env } from '../config/env';
import { openai, recordAiUsage, type AiTokenUsage } from '../services/ai.service';
import { downloadFile, getFile } from './client';

// Telegram voice notes are Opus at ~16–32 kbit/s, so a minute stays well below this.
const MAX_VOICE_BYTES = 5 * 1024 * 1024;

const TRANSCRIBE_PROMPT = 'Короткая заметка о личных финансах на русском, узбекском или английском: '
  + 'расходы, доходы, переводы и долги. Суммы: 25 тысяч, 1,5 млн, 45 ming so‘m. '
  + 'Карты и сервисы: Humo, Uzcard, Visa, Payme, Click.';

export async function transcribeVoice(uid: string, fileId: string): Promise<string> {
  const file = await getFile(fileId);
  if (!file.file_path) throw new Error('Telegram returned no file path for the voice note.');
  const audio = await downloadFile(file.file_path, MAX_VOICE_BYTES);
  const model = env.TELEGRAM_TRANSCRIBE_MODEL;
  const startedAt = Date.now();
  try {
    const result = await openai().audio.transcriptions.create({
      file: await toFile(audio, 'voice.ogg', { type: 'audio/ogg' }),
      model,
      prompt: TRANSCRIBE_PROMPT,
    }, { signal: AbortSignal.timeout(env.TELEGRAM_PARSE_TIMEOUT_MS) });
    const usage: AiTokenUsage | null = result.usage?.type === 'tokens'
      ? {
        inputTokens: result.usage.input_tokens,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: result.usage.output_tokens,
        reasoningTokens: 0,
        totalTokens: result.usage.total_tokens,
      }
      : null;
    await recordAiUsage({ uid, feature: 'telegram_voice', model, usage, latencyMs: Date.now() - startedAt, success: true });
    return result.text.trim();
  } catch (error) {
    await recordAiUsage({ uid, feature: 'telegram_voice', model, usage: null, latencyMs: Date.now() - startedAt, success: false });
    throw error;
  }
}
