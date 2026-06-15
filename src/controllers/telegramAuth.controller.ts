import { asyncHandler } from '../utils/asyncHandler';
import { authenticateTelegram } from '../services/telegramAuth.service';

export const postTelegramAuth = asyncHandler(async (req, res) => {
  const result = await authenticateTelegram(req.body);
  res.status(200).json(result);
});
