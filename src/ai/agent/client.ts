import OpenAI from 'openai';
import { AppError } from '../../utils/AppError';
let client: OpenAI | null = null;
export function openai(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new AppError(503, 'AI_UNAVAILABLE', 'AI is not configured on this server.');
  }
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}
