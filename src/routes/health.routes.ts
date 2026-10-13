import { Router } from 'express';
import { checkDatabase } from '../db/database';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'pulim-api' });
});
router.get('/live', (_req, res) => {
  res.json({ ok: true, service: 'pulim-api' });
});
router.get('/ready', async (_req, res) => {
  try {
    await checkDatabase();
    res.json({ ok: true, service: 'pulim-api', storage: 'mysql' });
  } catch {
    res.status(503).json({ ok: false, service: 'pulim-api' });
  }
});

export const healthRouter = router;
