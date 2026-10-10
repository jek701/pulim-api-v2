import { Router, type Express } from 'express';
import { authenticate } from '../middleware/authenticate';
import { aiLimiter, phoneAuthLimiter, shortcutLimiter, telegramAuthLimiter, telegramWebhookLimiter } from '../middleware/rateLimit';
import { healthRouter } from './health.routes';
import { telegramAuthRouter } from './telegramAuth.routes';
import { phoneAuthRouter } from './phoneAuth.routes';
import { profileRouter } from './profile.routes';
import { settingsRouter } from './settings.routes';
import { categoriesRouter } from './categories.routes';
import { subcategoriesRouter } from './subcategories.routes';
import { cardsRouter } from './cards.routes';
import { budgetsRouter } from './budgets.routes';
import { savingsGoalsRouter } from './savingsGoals.routes';
import { subscriptionsRouter } from './subscriptions.routes';
import { plannedExpensesRouter } from './plannedExpenses.routes';
import { transactionsRouter } from './transactions.routes';
import { debtsRouter } from './debts.routes';
import { depositsRouter } from './deposits.routes';
import { aiRouter } from './ai.routes';
import { aiChatsRouter } from './aiChats.routes';
import { billingInternalRouter } from './billingInternal.routes';
import { telegramWebhookRouter } from './telegramWebhook.routes';
import { notificationSettingsRouter } from './notificationSettings.routes';
import { devNotesRouter } from './devNotes.routes';
import { shortcutRouter } from './shortcut.routes';
import { shortcutTokenRouter } from './shortcutToken.routes';
import { communicationsRouter } from './communications.routes';

/** Mounts every router. Public routes first, then the authenticated `/v1` tree. */
export function mountRoutes(app: Express): void {
  app.use('/health', healthRouter);
  app.use('/auth/telegram', telegramAuthLimiter, telegramAuthRouter);
  app.use('/auth/phone', phoneAuthLimiter, phoneAuthRouter);
  app.use('/internal/v1/billing/events', billingInternalRouter);
  app.use('/telegram/webhook', telegramWebhookLimiter, telegramWebhookRouter);
  app.use('/shortcut/v1', shortcutLimiter, shortcutRouter);

  const v1 = Router();
  v1.use(authenticate);

  v1.use('/profile', profileRouter);
  v1.use('/profile/notifications', notificationSettingsRouter);
  v1.use('/settings', settingsRouter);
  v1.use('/categories', categoriesRouter);
  v1.use('/subcategories', subcategoriesRouter);
  v1.use('/cards', cardsRouter);
  v1.use('/budgets', budgetsRouter);
  v1.use('/savings-goals', savingsGoalsRouter);
  v1.use('/subscriptions', subscriptionsRouter);
  v1.use('/planned-expenses', plannedExpensesRouter);
  v1.use('/transactions', transactionsRouter);
  v1.use('/debts', debtsRouter);
  v1.use('/deposits', depositsRouter);
  v1.use('/ai-chats', aiChatsRouter);
  v1.use('/ai', aiLimiter, aiRouter);
  v1.use('/dev-notes', devNotesRouter);
  v1.use('/communications', communicationsRouter);
  v1.use('/shortcut-token', shortcutTokenRouter);

  app.use('/v1', v1);
}
