import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import { deleteAccount } from '../services/accountDeletion.service';

export const postDeleteAccount = asyncHandler(async (req, res) => {
  if (req.claims.firebase?.sign_in_provider === 'anonymous')
    throw AppError.forbidden('FORBIDDEN', 'Sign in to delete an account.');
  await deleteAccount(req.uid);
  res.status(204).end();
});
