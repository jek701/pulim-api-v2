import { asyncHandler } from '../utils/asyncHandler';
import { userScopedRepo } from '../repositories/base.repository';
import * as depositService from '../services/deposit.service';

const repo = userScopedRepo('deposits');

export const listDeposits = asyncHandler(async (req, res) => {
  res.json(await repo.list(req.uid, { field: 'createdAt', dir: 'desc' }));
});

export const createDeposit = asyncHandler(async (req, res) => {
  res.status(201).json(await repo.create(req.uid, req.body, { interestPaidOut: 0, isClosed: false }));
});

export const deleteDeposit = asyncHandler(async (req, res) => {
  await repo.remove(req.uid, String(req.params.id));
  res.status(204).end();
});

export const collectInterest = asyncHandler(async (req, res) => {
  res.json(await depositService.collectInterest(req.uid, String(req.params.id)));
});

export const closeDeposit = asyncHandler(async (req, res) => {
  res.json(await depositService.closeDeposit(req.uid, String(req.params.id), req.body.accountId));
});

export const replenishDeposit = asyncHandler(async (req, res) => {
  res.json(await depositService.replenishDeposit(req.uid, String(req.params.id), req.body.accountId, req.body.amount));
});

export const withdrawDeposit = asyncHandler(async (req, res) => {
  res.json(await depositService.withdrawDeposit(req.uid, String(req.params.id), req.body.accountId, req.body.amount));
});
