import {
  StoredDocument,
  afterQuery,
  documentKey,
  filterQuery,
  insertDocument,
  limitQuery,
  orderQuery,
  patchValue,
  queryTable,
  readDocument,
  runSqlTransaction,
  saveDocument,
} from '../db/documents';
import { createHash } from 'node:crypto';
import type { UserProfile } from '../domain/types';
import { profileRef } from '../repositories/profile.repository';
import { AppError } from '../utils/AppError';
import { createNotification } from '../notifications/queue.repository';
import type { CampaignPayload } from '../notifications/types';
import {
  defaultCommunicationPreferences,
  emptyCampaignStats,
  type CommunicationCampaign,
  type CommunicationLanguage,
  type CommunicationPreferences,
  type InAppMessage,
} from './domain';
const campaigns = () => queryTable('communicationCampaigns');
const messages = () => queryTable('inAppMessages');
const deliveries = () => queryTable('communicationDeliveries');
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
function campaignFrom(document: StoredDocument): CommunicationCampaign {
  return { id: document.id, ...document.data } as CommunicationCampaign;
}
export function communicationPreferences(
  profile?: Partial<UserProfile> | null,
): CommunicationPreferences {
  const stored = profile?.communications?.marketing;
  return {
    marketing: {
      inApp: stored?.inApp !== false,
      telegram: stored?.telegram === true,
    },
  };
}
export async function getCommunicationPreferences(uid: string): Promise<CommunicationPreferences> {
  const snap = await readDocument(profileRef(uid));
  return communicationPreferences(snap.data as UserProfile | undefined);
}
export async function patchCommunicationPreferences(
  uid: string,
  patch: Partial<CommunicationPreferences['marketing']>,
): Promise<CommunicationPreferences> {
  const current = await getCommunicationPreferences(uid);
  const next = { marketing: { ...current.marketing, ...patch } };
  await saveDocument(
    profileRef(uid),
    { communications: next, updatedAt: Date.now() },
    { merge: true },
  );
  return next;
}
export async function listCampaigns(limit = 50): Promise<CommunicationCampaign[]> {
  const snapshot = await readDocument(
    limitQuery(orderQuery(campaigns(), 'createdAt', 'desc'), limit),
  );
  return snapshot.rows.map(campaignFrom);
}
export async function createCampaign(
  uid: string,
  input: Omit<
    CommunicationCampaign,
    | 'id'
    | 'status'
    | 'scheduledAt'
    | 'stats'
    | 'createdBy'
    | 'createdAt'
    | 'updatedAt'
    | 'startedAt'
    | 'completedAt'
    | 'lastError'
  >,
): Promise<CommunicationCampaign> {
  const now = Date.now();
  const ref = documentKey(campaigns());
  const campaign: Omit<CommunicationCampaign, 'id'> = {
    ...input,
    status: 'draft',
    scheduledAt: null,
    stats: emptyCampaignStats(),
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    lastError: null,
  };
  await saveDocument(ref, campaign);
  return { id: ref.id, ...campaign };
}
export async function updateCampaign(
  id: string,
  patch: Record<string, unknown>,
): Promise<CommunicationCampaign> {
  const ref = documentKey(campaigns(), id);
  await runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.exists) throw AppError.notFound('Campaign not found.');
    if (!['draft', 'paused'].includes(String(snap.data?.status)))
      throw AppError.badRequest('Only draft or paused campaigns can be edited.');
    transaction.save(ref, { ...patch, updatedAt: Date.now() }, { merge: true });
  });
  return campaignFrom(await readDocument(ref));
}
export async function scheduleCampaign(
  id: string,
  scheduledAt?: number | null,
): Promise<CommunicationCampaign> {
  const ref = documentKey(campaigns(), id);
  const now = Date.now();
  await runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.exists) throw AppError.notFound('Campaign not found.');
    if (!['draft', 'paused', 'failed'].includes(String(snap.data?.status)))
      throw AppError.badRequest('Campaign cannot be sent from its current state.');
    transaction.save(
      ref,
      {
        status: 'scheduled',
        scheduledAt: scheduledAt && scheduledAt > now ? scheduledAt : now,
        updatedAt: now,
        lastError: null,
      },
      { merge: true },
    );
  });
  return campaignFrom(await readDocument(ref));
}
export async function pauseCampaign(id: string): Promise<CommunicationCampaign> {
  const ref = documentKey(campaigns(), id);
  await runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.exists) throw AppError.notFound('Campaign not found.');
    if (snap.data?.status !== 'scheduled')
      throw AppError.badRequest('Only scheduled campaigns can be paused.');
    transaction.save(ref, { status: 'paused', updatedAt: Date.now() }, { merge: true });
  });
  return campaignFrom(await readDocument(ref));
}
function normalizeLanguage(value: unknown): CommunicationLanguage {
  return value === 'ru' || value === 'uz' || value === 'en' ? value : 'en';
}
function telegramLinked(profile: Partial<UserProfile>): boolean {
  const settings = profile.notifications;
  return Boolean(
    settings?.telegram.chatId &&
    settings.telegram.status !== 'blocked' &&
    settings.telegram.status !== 'unreachable',
  );
}
function matchesAudience(
  profile: Partial<UserProfile>,
  campaign: CommunicationCampaign,
  now: number,
): boolean {
  const language = normalizeLanguage(profile.language);
  if (campaign.audience.languages.length && !campaign.audience.languages.includes(language))
    return false;
  const linked = telegramLinked(profile);
  if (campaign.audience.telegram === 'linked' && !linked) return false;
  if (campaign.audience.telegram === 'unlinked' && linked) return false;
  if (campaign.audience.tier === 'all') return true;
  const activePremium =
    profile.subscription?.tier === 'premium' &&
    Number(profile.subscription.premiumUntil ?? 0) > now;
  if (campaign.audience.tier === 'free') return !activePremium;
  if (campaign.audience.tier === 'premium') return activePremium && !profile.subscription?.isTrial;
  return activePremium && profile.subscription?.isTrial === true;
}
async function claimDueCampaign(now: number): Promise<CommunicationCampaign | null> {
  const sending = await readDocument(
    limitQuery(filterQuery(campaigns(), 'status', '==', 'sending'), 20),
  );
  const abandoned = sending.rows.map(campaignFrom).find(
    (item) =>
      Number(
        (
          item as CommunicationCampaign & {
            dispatchLeaseUntil?: number;
          }
        ).dispatchLeaseUntil ?? 0,
      ) <= now,
  );
  if (abandoned) {
    await saveDocument(
      documentKey(campaigns(), abandoned.id),
      {
        status: 'scheduled',
        scheduledAt: now,
        updatedAt: now,
        lastError: 'Recovered after an interrupted dispatch.',
      },
      { merge: true },
    );
  }
  const snapshot = await readDocument(
    limitQuery(filterQuery(campaigns(), 'status', '==', 'scheduled'), 20),
  );
  const due = snapshot.rows
    .map(campaignFrom)
    .filter((item) => Number(item.scheduledAt ?? 0) <= now)
    .sort((a, b) => Number(a.scheduledAt) - Number(b.scheduledAt))[0];
  if (!due) return null;
  return runSqlTransaction(async (transaction) => {
    const ref = documentKey(campaigns(), due.id);
    const snap = await transaction.read(ref);
    if (
      !snap.exists ||
      snap.data?.status !== 'scheduled' ||
      Number(snap.data?.scheduledAt ?? 0) > now
    )
      return null;
    transaction.save(
      ref,
      { status: 'sending', startedAt: now, dispatchLeaseUntil: now + 30 * 60000, updatedAt: now },
      { merge: true },
    );
    return { ...campaignFrom(snap), status: 'sending', startedAt: now };
  });
}
async function fanOut(campaign: CommunicationCampaign): Promise<void> {
  const now = Date.now();
  let cursor: StoredDocument | undefined;
  const counters = { audience: 0, inAppDelivered: 0, telegramQueued: 0 };
  do {
    let query = limitQuery(orderQuery(queryTable('profiles'), '__id__'), 250);
    if (cursor) query = afterQuery(query, cursor);
    const snapshot = await readDocument(query);
    if (snapshot.empty) break;
    for (const document of snapshot.rows) {
      const profile = document.data as UserProfile;
      if (!matchesAudience(profile, campaign, now)) continue;
      counters.audience += 1;
      const language = normalizeLanguage(profile.language);
      const content = campaign.content[language] ?? campaign.content.en;
      const preferences = communicationPreferences(profile);
      if (campaign.channels.includes('in_app') && preferences.marketing.inApp) {
        counters.inAppDelivered += 1;
        const ref = documentKey(messages(), digest(`${campaign.id}:${document.id}`));
        try {
          await insertDocument(ref, {
            campaignId: campaign.id,
            userId: document.id,
            presentation: campaign.presentation,
            ...content,
            ctaUrl: campaign.ctaUrl,
            createdAt: now,
            readAt: null,
            clickedAt: null,
            dismissedAt: null,
          });
        } catch (error) {
          if (
            (
              error as {
                code?: number | string;
              }
            ).code !== 6 &&
            (
              error as {
                code?: number | string;
              }
            ).code !== 'already-exists'
          )
            throw error;
        }
      }
      if (
        campaign.channels.includes('telegram') &&
        preferences.marketing.telegram &&
        telegramLinked(profile)
      ) {
        counters.telegramQueued += 1;
        const deliveryRef = documentKey(
          deliveries(),
          digest(`${campaign.id}:${document.id}:telegram`),
        );
        const payload: CampaignPayload = {
          kind: 'campaign',
          campaignId: campaign.id,
          title: content.title,
          body: content.body,
          ctaLabel: content.ctaLabel,
          ctaUrl: campaign.ctaUrl,
        };
        const queued = await createNotification({
          userId: document.id,
          chatId: String(profile.notifications!.telegram.chatId),
          type: 'campaign',
          dedupeKey: `campaign:${campaign.id}:${document.id}`,
          payload,
        });
        if (queued)
          await insertDocument(deliveryRef, {
            campaignId: campaign.id,
            userId: document.id,
            channel: 'telegram',
            status: 'queued',
            updatedAt: now,
          });
      }
    }
    cursor = snapshot.rows.at(-1);
    if (snapshot.size < 250) break;
  } while (cursor);
  await saveDocument(
    documentKey(campaigns(), campaign.id),
    {
      status: 'completed',
      completedAt: Date.now(),
      dispatchLeaseUntil: null,
      updatedAt: Date.now(),
      lastError: null,
      'stats.audience': counters.audience,
      'stats.inAppDelivered': counters.inAppDelivered,
      'stats.telegramQueued': counters.telegramQueued,
    },
    { merge: true },
  );
}
export async function runCommunicationDispatch(now = Date.now()): Promise<boolean> {
  const campaign = await claimDueCampaign(now);
  if (!campaign) return false;
  try {
    await fanOut(campaign);
  } catch (error) {
    await saveDocument(
      documentKey(campaigns(), campaign.id),
      {
        status: 'failed',
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        updatedAt: Date.now(),
      },
      { merge: true },
    );
    throw error;
  }
  return true;
}
export async function markCampaignTelegramOutcome(
  campaignId: string,
  uid: string,
  outcome: 'sent' | 'failed',
): Promise<void> {
  const deliveryRef = documentKey(deliveries(), digest(`${campaignId}:${uid}:telegram`));
  const campaignRef = documentKey(campaigns(), campaignId);
  await runSqlTransaction(async (transaction) => {
    const delivery = await transaction.read(deliveryRef);
    if (delivery.data?.status === outcome) return;
    transaction.save(deliveryRef, { status: outcome, updatedAt: Date.now() }, { merge: true });
    transaction.save(
      campaignRef,
      {
        [`stats.telegram${outcome === 'sent' ? 'Sent' : 'Failed'}`]: patchValue.increment(1),
        updatedAt: Date.now(),
      },
      { merge: true },
    );
  });
}
export async function listInbox(uid: string): Promise<InAppMessage[]> {
  const snapshot = await readDocument(
    limitQuery(filterQuery(messages(), 'userId', '==', uid), 100),
  );
  return snapshot.rows
    .map((document) => ({ id: document.id, ...document.data }) as InAppMessage)
    .sort((a, b) => b.createdAt - a.createdAt);
}
export async function recordInAppEvent(
  uid: string,
  id: string,
  event: 'read' | 'click' | 'dismiss',
): Promise<InAppMessage> {
  const ref = documentKey(messages(), id);
  await runSqlTransaction(async (transaction) => {
    const snap = await transaction.read(ref);
    if (!snap.exists || snap.data?.userId !== uid) throw AppError.notFound('Message not found.');
    const field = event === 'read' ? 'readAt' : event === 'click' ? 'clickedAt' : 'dismissedAt';
    if (snap.data?.[field]) return;
    const now = Date.now();
    const markSeen = event === 'click' && !snap.data?.readAt;
    transaction.save(
      ref,
      { [field]: now, ...(markSeen ? { readAt: now } : {}), updatedAt: now },
      { merge: true },
    );
    const metric = event === 'read' ? 'seen' : event === 'click' ? 'clicked' : 'dismissed';
    transaction.save(
      documentKey(campaigns(), String(snap.data?.campaignId)),
      { [`stats.${metric}`]: patchValue.increment(1), updatedAt: now },
      { merge: true },
    );
    if (markSeen)
      transaction.save(
        documentKey(campaigns(), String(snap.data?.campaignId)),
        { 'stats.seen': patchValue.increment(1) },
        { merge: true },
      );
  });
  const snap = await readDocument(ref);
  return { id: snap.id, ...snap.data } as InAppMessage;
}
export { defaultCommunicationPreferences };
