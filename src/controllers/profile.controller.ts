import { consentTypeSchema, consentBodySchema, putConsent } from '../services/consent.service';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';
import * as profileService from '../services/profile.service';
import { syncMemberName } from '../services/household.service';
import { getProfile, mergeProfile } from '../repositories/profile.repository';
import { patchNotificationSettings } from '../notifications/settings';

export const postBootstrap = asyncHandler(async (req, res) => {
  const categories = req.body?.categories;
  res
    .status(200)
    .json(
      await profileService.bootstrap(req.uid, req.claims, categories ? { categories } : undefined),
    );
});

export const postStartTrial = asyncHandler(async (req, res) => {
  res.status(200).json(await profileService.startTrial(req.uid));
});

export const getProfileHandler = asyncHandler(async (req, res) => {
  const profile = await profileService.profileWithPushStatus(req.uid);
  if (!profile) throw AppError.notFound('Profile not found.');
  res.json(profile);
});

export const patchProfile = asyncHandler(async (req, res) => {
  await mergeProfile(req.uid, req.body);
  if (req.body.timezone) await patchNotificationSettings(req.uid, { timezone: req.body.timezone });
  if (typeof req.body.name === 'string' && req.body.name.trim()) {
    await syncMemberName(req.uid, req.body.name);
  }
  res.json(await profileService.profileWithPushStatus(req.uid));
});

export const patchHomeWidgets = asyncHandler(async (req, res) => {
  await mergeProfile(req.uid, { homeWidgets: req.body.homeWidgets });
  res.json(await getProfile(req.uid));
});

export const dismissTelegramLink = asyncHandler(async (req, res) => {
  await mergeProfile(req.uid, { telegramLinkPromptDismissed: true });
  res.status(204).end();
});

export const putProfileConsent = asyncHandler(async (req, res) => {
  if (req.claims.firebase?.sign_in_provider === 'anonymous')
    throw AppError.forbidden('ANONYMOUS_NOT_ALLOWED', 'Sign in to record consent.');
  consentTypeSchema.parse(req.params.type);
  await putConsent(req.uid, consentBodySchema.parse(req.body));
  res.status(204).end();
});
