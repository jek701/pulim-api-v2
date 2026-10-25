import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import {
  budgetSetSchema,
  householdCardAccessSchema,
  householdCardCreateSchema,
  householdCreateSchema,
  householdGoalContributionSchema,
  householdGoalCreateSchema,
  householdTelegramSchema,
  householdTransactionCreateSchema,
  householdUpdateSchema,
  savingsGoalUpdateSchema,
  transactionUpdateSchema,
} from '../domain/schemas';
import * as household from '../services/household.service';

const router = Router();

router.get('/current', asyncHandler(async (req, res) => {
  res.json(await household.currentHousehold(req.uid));
}));
router.post('/', validate(householdCreateSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await household.createHousehold(req.uid, req.body));
}));
router.patch('/current', validate(householdUpdateSchema), asyncHandler(async (req, res) => {
  res.json(await household.updateHousehold(req.uid, req.body));
}));
router.post('/current/invites', asyncHandler(async (req, res) => {
  res.status(201).json(await household.createInvite(req.uid));
}));
router.get('/current/invites/:token', asyncHandler(async (req, res) => {
  res.json(await household.inviteStatus(req.uid, String(req.params.token)));
}));
router.post('/current/invites/:token/pick', validate(householdTelegramSchema), asyncHandler(async (req, res) => {
  res.json(await household.prepareInvitePick(req.uid, String(req.params.token), req.body.telegramInitData));
}));
router.post('/current/invites/:token/share', validate(householdTelegramSchema), asyncHandler(async (req, res) => {
  res.json(await household.prepareInviteShare(req.uid, String(req.params.token), req.body.telegramInitData));
}));
router.get('/invites/:token', asyncHandler(async (req, res) => {
  res.json(await household.inviteInfo(String(req.params.token)));
}));
router.post('/invites/:token/accept', asyncHandler(async (req, res) => {
  res.json(await household.acceptInvite(req.uid, String(req.params.token)));
}));

router.get('/current/categories', asyncHandler(async (req, res) => {
  res.json(await household.listHouseholdCategories(req.uid));
}));
router.get('/current/budgets', asyncHandler(async (req, res) => {
  res.json(await household.listHouseholdBudgets(req.uid));
}));
router.put('/current/budgets/:categoryId', validate(budgetSetSchema), asyncHandler(async (req, res) => {
  res.json(await household.setHouseholdBudget(req.uid, String(req.params.categoryId), req.body));
}));

router.get('/current/cards', asyncHandler(async (req, res) => {
  res.json(await household.listHouseholdCards(req.uid));
}));
router.post('/current/cards', validate(householdCardCreateSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await household.createHouseholdCard(req.uid, req.body));
}));
router.patch('/current/cards/:id/access', validate(householdCardAccessSchema), asyncHandler(async (req, res) => {
  res.json(await household.setCardFamilyAccess(req.uid, String(req.params.id), req.body));
}));

router.get('/current/goals', asyncHandler(async (req, res) => {
  res.json(await household.listHouseholdGoals(req.uid));
}));
router.post('/current/goals', validate(householdGoalCreateSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await household.createHouseholdGoal(req.uid, req.body));
}));
router.patch('/current/goals/:id', validate(savingsGoalUpdateSchema), asyncHandler(async (req, res) => {
  res.json(await household.updateHouseholdGoal(req.uid, String(req.params.id), req.body));
}));
router.post('/current/goals/:id/contribute', validate(householdGoalContributionSchema), asyncHandler(async (req, res) => {
  res.json(await household.contributeHouseholdGoal(req.uid, String(req.params.id), req.body.amount, req.body.accountId));
}));
router.delete('/current/goals/:id', asyncHandler(async (req, res) => {
  await household.deleteHouseholdGoal(req.uid, String(req.params.id));
  res.status(204).end();
}));

router.get('/current/transactions', asyncHandler(async (req, res) => {
  res.json(await household.listHouseholdTransactions(req.uid));
}));
router.post('/current/transactions', validate(householdTransactionCreateSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await household.createHouseholdTransaction(req.uid, req.body));
}));
router.patch('/current/transactions/:id', validate(transactionUpdateSchema), asyncHandler(async (req, res) => {
  res.json(await household.updateHouseholdTransaction(req.uid, String(req.params.id), req.body));
}));
router.delete('/current/transactions/:id', asyncHandler(async (req, res) => {
  await household.deleteHouseholdTransaction(req.uid, String(req.params.id));
  res.status(204).end();
}));

export const householdsRouter = router;
