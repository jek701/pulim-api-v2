/**
 * LOCAL-ONLY API for developing the offline client without Firebase: the real /v1 routers and
 * services on the local rehearsal MySQL (docker compose -f compose.migration.yaml up -d), with a
 * fake auth middleware (`x-test-uid: <uid>` header instead of a Firebase ID token).
 *
 *   npm run dev:offline-sync        # http://127.0.0.1:3112/v1
 *
 * Refuses to run against anything but 127.0.0.1:3308 / pulim_app_rehearsal. Never deploy this.
 */
import express, { Router } from 'express';

if (
  process.env.MYSQL_HOST !== '127.0.0.1' ||
  process.env.MYSQL_PORT !== '3308' ||
  process.env.MYSQL_DATABASE !== 'pulim_app_rehearsal'
) {
  throw new Error('offline-sync dev server only runs against the local rehearsal DB (127.0.0.1:3308)');
}
// The env module validates production settings at import; placeholders are enough for local routes.
process.env.FIREBASE_PROJECT_ID ??= 'local-dev';
process.env.TELEGRAM_BOT_TOKEN ??= '0:local-dev-placeholder';
process.env.NODE_ENV ??= 'development';

async function main(): Promise<void> {
  const { database, closeDatabase } = await import('../src/db/database');
  const { migrateDatabase } = await import('../src/db/migrate');
  const { initOfflineSync } = await import('../src/db/syncIndex');
  await migrateDatabase();
  const enabled = await initOfflineSync(database());
  const { idempotency } = await import('../src/middleware/idempotency');
  const { errorHandler } = await import('../src/middleware/errorHandler');
  const { profileRouter } = await import('../src/routes/profile.routes');
  const { settingsRouter } = await import('../src/routes/settings.routes');
  const { categoriesRouter } = await import('../src/routes/categories.routes');
  const { subcategoriesRouter } = await import('../src/routes/subcategories.routes');
  const { cardsRouter } = await import('../src/routes/cards.routes');
  const { budgetsRouter } = await import('../src/routes/budgets.routes');
  const { savingsGoalsRouter } = await import('../src/routes/savingsGoals.routes');
  const { subscriptionsRouter } = await import('../src/routes/subscriptions.routes');
  const { plannedExpensesRouter } = await import('../src/routes/plannedExpenses.routes');
  const { transactionsRouter } = await import('../src/routes/transactions.routes');
  const { debtsRouter } = await import('../src/routes/debts.routes');
  const { depositsRouter } = await import('../src/routes/deposits.routes');
  const { syncRouter } = await import('../src/routes/sync.routes');

  const v1 = Router();
  v1.use((req, res, next) => {
    const uid = req.header('x-test-uid');
    if (!uid) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Send x-test-uid.' } });
      return;
    }
    req.uid = uid;
    req.claims = { uid, firebase: { sign_in_provider: 'anonymous' } } as never;
    next();
  });
  v1.use(idempotency);
  v1.use('/profile', profileRouter);
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
  v1.use('/sync', syncRouter);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/v1', v1);
  app.use(errorHandler);
  const port = Number(process.env.PORT || 3112);
  const server = app.listen(port, '127.0.0.1', () =>
    console.log(`offline-sync dev API on http://127.0.0.1:${port}/v1 (offlineSync=${enabled})`),
  );
  const stop = () => server.close(() => void closeDatabase());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
void main();
