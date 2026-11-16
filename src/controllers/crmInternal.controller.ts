import { asyncHandler } from '../utils/asyncHandler';
import { crmUsersQuery, crmFactsBody, crmMessageBody, crmStatusBody } from '../crm/schemas';
import { listCrmUsers, getCrmFacts } from '../crm/facts';
import { queueCrmMessage, crmMessageStatuses } from '../crm/messages';
export const crmUsers = asyncHandler(async (req, res) => {
  res.json(await listCrmUsers(crmUsersQuery.parse(req.query)));
});
export const crmFacts = asyncHandler(async (req, res) => {
  res.json(await getCrmFacts(crmFactsBody.parse(req.body).uids));
});
export const crmMessage = asyncHandler(async (req, res) => {
  res.json(await queueCrmMessage(crmMessageBody.parse(req.body)));
});
export const crmStatuses = asyncHandler(async (req, res) => {
  res.json(await crmMessageStatuses(crmStatusBody.parse(req.body).mids));
});
