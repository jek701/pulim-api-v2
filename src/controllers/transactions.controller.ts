import { asyncHandler } from '../utils/asyncHandler';
import { userScopedRepo } from '../repositories/base.repository';
import * as txService from '../services/transaction.service';

const repo = userScopedRepo('transactions');

export const listTransactions = asyncHandler(async (req, res) => {
  const rows = await repo.list(req.uid);
  // Frontend ordering: date desc, then createdAt desc.
  rows.sort((a, b) => (b.date ?? 0) - (a.date ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
  res.json(rows);
});

export const createTransaction = asyncHandler(async (req, res) => {
  res.status(201).json(await txService.createTransaction(req.uid, req.body));
});

export const updateTransaction = asyncHandler(async (req, res) => {
  res.json(await txService.updateTransaction(req.uid, String(req.params.id), req.body));
});

export const updateTransfer = asyncHandler(async (req, res) => {
  res.json(await txService.updateTransfer(req.uid, String(req.params.id), req.body));
});

export const updateReturn = asyncHandler(async (req, res) => {
  res.json(await txService.updateReturn(req.uid, String(req.params.id), req.body));
});

export const deleteTransaction = asyncHandler(async (req, res) => {
  await txService.deleteTransaction(req.uid, String(req.params.id));
  res.status(204).end();
});

export const clearAllTransactions = asyncHandler(async (req, res) => {
  res.json(await txService.clearAllTransactions(req.uid));
});

export const transfer = asyncHandler(async (req, res) => {
  res.status(201).json(await txService.transfer(req.uid, req.body));
});

export const returnTransaction = asyncHandler(async (req, res) => {
  res.status(201).json(await txService.returnTransaction(req.uid, String(req.params.id), req.body));
});
