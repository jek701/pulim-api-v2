import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { db, FieldValue } from '../config/firebase';
import { AppError } from '../utils/AppError';
import { MONTH_MS, FREE_LIMITS } from '../domain/entitlements';
import { profileRef, getProfile } from '../repositories/profile.repository';
import { buildContextSnapshot, buildForecastPrompt } from '../prompts/buildContext';
import { SYSTEM_PROMPT_BASE } from '../prompts/chatSystem';
import type { Transaction, AiChatMessage } from '../domain/types';

const NINETY_DAYS = 90 * 86_400_000;

export const aiConfigured = (): boolean => Boolean(env.ANTHROPIC_API_KEY);

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError(503, 'AI_UNAVAILABLE', 'AI is not configured on this server.');
  }
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

async function listOwned(collection: string, uid: string): Promise<any[]> {
  const snap = await db.collection(collection).where('userId', '==', uid).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export function selectChatModel(isPremium: boolean): string {
  return isPremium ? env.AI_MODEL_PREMIUM : env.AI_MODEL_FREE;
}

/** Assemble the financial-context snapshot string from the user's own Firestore data. */
export async function assembleSnapshot(uid: string, language: string): Promise<string> {
  const cutoff = Date.now() - NINETY_DAYS;
  const [profile, allTxns, categories, cards, subscriptions, plannedExpenses, debts, savingsGoals] =
    await Promise.all([
      getProfile(uid),
      listOwned('transactions', uid),
      listOwned('categories', uid),
      listOwned('cards', uid),
      listOwned('subscriptions', uid),
      listOwned('planned_expenses', uid),
      listOwned('debts', uid),
      listOwned('savingsGoals', uid),
    ]);
  const transactions = (allTxns as Transaction[]).filter((t) => t.date >= cutoff);
  return buildContextSnapshot({
    profile,
    transactions,
    categories,
    cards,
    subscriptions,
    plannedExpenses,
    debts,
    savingsGoals,
    language,
  });
}

/** Enforce the monthly AI message window for free users; no-op for premium. */
export async function consumeAiMessage(uid: string, isPremium: boolean): Promise<void> {
  if (isPremium) return;
  await db.runTransaction(async (tx) => {
    const ref = profileRef(uid);
    const snap = await tx.get(ref);
    const usage = snap.data()?.usage as { aiMessagesThisPeriod?: number; periodStart?: number } | undefined;
    const now = Date.now();
    const stored = usage?.periodStart;
    if (!stored || now - stored >= MONTH_MS) {
      tx.set(ref, { usage: { aiMessagesThisPeriod: 1, periodStart: now }, updatedAt: now }, { merge: true });
      return;
    }
    const used = usage?.aiMessagesThisPeriod ?? 0;
    if (used >= FREE_LIMITS.aiMessagesPerMonth) {
      throw new AppError(403, 'AI_LIMIT_REACHED', 'Monthly AI message limit reached.');
    }
    tx.set(ref, { usage: { aiMessagesThisPeriod: used + 1, periodStart: stored }, updatedAt: now }, { merge: true });
  });
}

/** Open a streaming chat completion. Caller iterates events and writes SSE. */
export function streamChat(opts: {
  model: string;
  snapshot: string;
  language: string;
  history: ChatTurn[];
  userMessage: string;
  signal: AbortSignal;
}) {
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM_PROMPT_BASE },
    {
      type: 'text',
      text: `Reply in: ${opts.language}.\n\n${opts.snapshot}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
  const messages: Anthropic.MessageParam[] = [
    ...opts.history.map<Anthropic.MessageParam>((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: opts.userMessage },
  ];
  const supportsEffort = opts.model.startsWith('claude-sonnet');
  return anthropic().messages.stream(
    {
      model: opts.model,
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      ...(supportsEffort ? { output_config: { effort: 'medium' as const } } : {}),
      system: systemBlocks,
      messages,
    },
    { signal: opts.signal },
  );
}

/** One-shot month-end budget forecast (Haiku). */
export async function getForecast(uid: string, language: string): Promise<string> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const cutoff = Date.now() - NINETY_DAYS;
  const [profile, allTxns, categories, subscriptions, plannedExpenses, budgetsSnap] = await Promise.all([
    getProfile(uid),
    listOwned('transactions', uid),
    listOwned('categories', uid),
    listOwned('subscriptions', uid),
    listOwned('planned_expenses', uid),
    db.collection('budgets').where('userId', '==', uid).get(),
  ]);
  const txns = allTxns as Transaction[];
  const budgets = budgetsSnap.docs.map((d) => d.data() as { categoryId: string; amount: number });
  const incomeBudget = budgets.find((b) => b.categoryId === '__income__')?.amount ?? 0;

  const prompt = buildForecastPrompt({
    currentMonthTransactions: txns.filter((t) => t.date >= monthStart),
    historicalTransactions: txns.filter((t) => t.date >= cutoff),
    budgets,
    categories,
    incomeBudget,
    profile,
    subscriptions,
    plannedExpenses,
    language,
  });

  const message = await anthropic().messages.create({
    model: env.AI_MODEL_FREE,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = message.content[0];
  return block && block.type === 'text' ? block.text : '';
}

// ── Chat persistence (aiChats) ────────────────────────────────────────────────
const chatsCol = () => db.collection('aiChats');

export async function loadChatHistory(uid: string, chatId: string): Promise<ChatTurn[]> {
  const snap = await chatsCol().doc(chatId).get();
  if (!snap.exists) throw AppError.notFound('Chat not found.');
  const data = snap.data()!;
  if (data.userId !== uid) throw AppError.forbidden('FORBIDDEN', 'Not your chat.');
  return ((data.messages ?? []) as AiChatMessage[]).map((m) => ({ role: m.role, content: m.content }));
}

export async function createChat(uid: string, firstUserMessage: string): Promise<string> {
  const now = Date.now();
  const title = firstUserMessage.trim().slice(0, 60).replace(/\s+/g, ' ') || 'New chat';
  const ref = await chatsCol().add({
    userId: uid,
    title,
    messages: [{ role: 'user', content: firstUserMessage, timestamp: now }],
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

export async function appendUserMessage(chatId: string, content: string): Promise<void> {
  await chatsCol().doc(chatId).update({
    messages: FieldValue.arrayUnion({ role: 'user', content, timestamp: Date.now() }),
    updatedAt: Date.now(),
  });
}

export async function appendAssistantMessage(chatId: string, content: string): Promise<void> {
  await chatsCol().doc(chatId).update({
    messages: FieldValue.arrayUnion({ role: 'assistant', content, timestamp: Date.now() }),
    updatedAt: Date.now(),
  });
}

export async function countChats(uid: string): Promise<number> {
  const snap = await chatsCol().where('userId', '==', uid).count().get();
  return snap.data().count;
}
