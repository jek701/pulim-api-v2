import { asyncHandler } from '../utils/asyncHandler';
import { sendPhoneCode, verifyPhoneCode } from '../services/phoneAuth.service';

export const postSendPhoneCode = asyncHandler(async (req, res) => {
  res.status(200).json(await sendPhoneCode(req.body));
});

export const postVerifyPhoneCode = asyncHandler(async (req, res) => {
  res.status(200).json(await verifyPhoneCode(req.body));
});
