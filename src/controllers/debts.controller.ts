import { asyncHandler } from '../utils/asyncHandler';
import { userScopedRepo } from '../repositories/base.repository';
import { FieldValue } from '../config/firebase';
import * as debtService from '../services/debt.service';

const repo = userScopedRepo('debts');

export const listDebts = asyncHandler(async (req, res) => {
  res.json(await repo.list(req.uid, { field: 'createdAt', dir: 'desc' }));
});

export const createDebt = asyncHandler(async (req, res) => {
  res.status(201).json(await debtService.createDebt(req.uid, req.body));
});

export const updateDebt = asyncHandler(async (req, res) => {
  // A null field (e.g. a cleared due date) is removed rather than stored as null.
  const patch = Object.fromEntries(
    Object.entries(req.body as Record<string, unknown>).map(([k, v]) => [k, v === null ? FieldValue.delete() : v]),
  );
  res.json(await repo.update(req.uid, String(req.params.id), patch));
});

export const deleteDebt = asyncHandler(async (req, res) => {
  await repo.remove(req.uid, String(req.params.id));
  res.status(204).end();
});

export const payDebt = asyncHandler(async (req, res) => {
  res.json(await debtService.payDebt(req.uid, String(req.params.id), req.body.amount, req.body.accountId));
});
