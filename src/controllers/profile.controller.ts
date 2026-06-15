import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import * as profileService from '../services/profile.service';
import { getProfile, mergeProfile } from '../repositories/profile.repository';

export const postBootstrap = asyncHandler(async (req, res) => {
  res.status(200).json(await profileService.bootstrap(req.uid, req.claims));
});

export const getProfileHandler = asyncHandler(async (req, res) => {
  const profile = await getProfile(req.uid);
  if (!profile) throw AppError.notFound('Profile not found.');
  res.json(profile);
});

export const patchProfile = asyncHandler(async (req, res) => {
  await mergeProfile(req.uid, req.body);
  res.json(await getProfile(req.uid));
});

export const patchHomeWidgets = asyncHandler(async (req, res) => {
  await mergeProfile(req.uid, { homeWidgets: req.body.homeWidgets });
  res.json(await getProfile(req.uid));
});

export const dismissTelegramLink = asyncHandler(async (req, res) => {
  await mergeProfile(req.uid, { telegramLinkPromptDismissed: true });
  res.status(204).end();
});
