import { Router, type RequestHandler } from 'express';
import { devNotesUids } from '../config/env';
import {
  campaignCreateSchema,
  campaignPatchSchema,
  campaignSendSchema,
  communicationPreferencesPatchSchema,
} from '../communications/domain';
import {
  createCampaign,
  getCommunicationPreferences,
  listCampaigns,
  listInbox,
  patchCommunicationPreferences,
  pauseCampaign,
  recordInAppEvent,
  scheduleCampaign,
  updateCampaign,
} from '../communications/repository';
import { validate } from '../middleware/validate';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();
const requireOwner: RequestHandler = (req, _res, next) => next(devNotesUids.has(req.uid) ? undefined : AppError.notFound());

router.get('/preferences', asyncHandler(async (req, res) => res.json(await getCommunicationPreferences(req.uid))));
router.patch('/preferences', validate(communicationPreferencesPatchSchema), asyncHandler(async (req, res) => {
  res.json(await patchCommunicationPreferences(req.uid, req.body.marketing));
}));
router.get('/inbox', asyncHandler(async (req, res) => res.json(await listInbox(req.uid))));
router.post('/inbox/:id/read', asyncHandler(async (req, res) => res.json(await recordInAppEvent(req.uid, String(req.params.id), 'read'))));
router.post('/inbox/:id/click', asyncHandler(async (req, res) => res.json(await recordInAppEvent(req.uid, String(req.params.id), 'click'))));
router.post('/inbox/:id/dismiss', asyncHandler(async (req, res) => res.json(await recordInAppEvent(req.uid, String(req.params.id), 'dismiss'))));

router.get('/admin/access', (req, res) => res.json({ enabled: devNotesUids.has(req.uid) }));
router.use('/admin', requireOwner);
router.get('/admin/campaigns', asyncHandler(async (_req, res) => res.json(await listCampaigns())));
router.post('/admin/campaigns', validate(campaignCreateSchema), asyncHandler(async (req, res) => res.status(201).json(await createCampaign(req.uid, req.body))));
router.patch('/admin/campaigns/:id', validate(campaignPatchSchema), asyncHandler(async (req, res) => res.json(await updateCampaign(String(req.params.id), req.body))));
router.post('/admin/campaigns/:id/send', validate(campaignSendSchema), asyncHandler(async (req, res) => res.json(await scheduleCampaign(String(req.params.id), req.body.scheduledAt))));
router.post('/admin/campaigns/:id/pause', asyncHandler(async (req, res) => res.json(await pauseCampaign(String(req.params.id)))));

export const communicationsRouter = router;
