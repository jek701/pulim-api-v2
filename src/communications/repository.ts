import { createHash } from 'node:crypto';
import { admin, db, FieldValue } from '../config/firebase';
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

const campaigns = () => db.collection('communicationCampaigns');
const messages = () => db.collection('inAppMessages');
const deliveries = () => db.collection('communicationDeliveries');
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

function campaignFrom(document: FirebaseFirestore.DocumentSnapshot): CommunicationCampaign {
  return { id: document.id, ...document.data() } as CommunicationCampaign;
}

export function communicationPreferences(profile?: Partial<UserProfile> | null): CommunicationPreferences {
  const stored = profile?.communications?.marketing;
  return {
    marketing: {
      inApp: stored?.inApp !== false,
      telegram: stored?.telegram === true,
    },
  };
}

export async function getCommunicationPreferences(uid: string): Promise<CommunicationPreferences> {
  const snap = await profileRef(uid).get();
  return communicationPreferences(snap.data() as UserProfile | undefined);
}

export async function patchCommunicationPreferences(uid: string, patch: Partial<CommunicationPreferences['marketing']>): Promise<CommunicationPreferences> {
  const current = await getCommunicationPreferences(uid);
  const next = { marketing: { ...current.marketing, ...patch } };
  await profileRef(uid).set({ communications: next, updatedAt: Date.now() }, { merge: true });
  return next;
}

export async function listCampaigns(limit = 50): Promise<CommunicationCampaign[]> {
  const snapshot = await campaigns().orderBy('createdAt', 'desc').limit(limit).get();
  return snapshot.docs.map(campaignFrom);
}

export async function createCampaign(uid: string, input: Omit<CommunicationCampaign, 'id' | 'status' | 'scheduledAt' | 'stats' | 'createdBy' | 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt' | 'lastError'>): Promise<CommunicationCampaign> {
  const now = Date.now();
  const ref = campaigns().doc();
  const campaign: Omit<CommunicationCampaign, 'id'> = {
    ...input,
    status: 'draft', scheduledAt: null, stats: emptyCampaignStats(), createdBy: uid,
    createdAt: now, updatedAt: now, startedAt: null, completedAt: null, lastError: null,
  };
  await ref.set(campaign);
  return { id: ref.id, ...campaign };
}

export async function updateCampaign(id: string, patch: Record<string, unknown>): Promise<CommunicationCampaign> {
  const ref = campaigns().doc(id);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw AppError.notFound('Campaign not found.');
    if (!['draft', 'paused'].includes(String(snap.data()?.status))) throw AppError.badRequest('Only draft or paused campaigns can be edited.');
    transaction.set(ref, { ...patch, updatedAt: Date.now() }, { merge: true });
  });
  return campaignFrom(await ref.get());
}

export async function scheduleCampaign(id: string, scheduledAt?: number | null): Promise<CommunicationCampaign> {
  const ref = campaigns().doc(id);
  const now = Date.now();
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw AppError.notFound('Campaign not found.');
    if (!['draft', 'paused', 'failed'].includes(String(snap.data()?.status))) throw AppError.badRequest('Campaign cannot be sent from its current state.');
    transaction.set(ref, { status: 'scheduled', scheduledAt: scheduledAt && scheduledAt > now ? scheduledAt : now, updatedAt: now, lastError: null }, { merge: true });
  });
  return campaignFrom(await ref.get());
}

export async function pauseCampaign(id: string): Promise<CommunicationCampaign> {
  const ref = campaigns().doc(id);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) throw AppError.notFound('Campaign not found.');
    if (snap.data()?.status !== 'scheduled') throw AppError.badRequest('Only scheduled campaigns can be paused.');
    transaction.set(ref, { status: 'paused', updatedAt: Date.now() }, { merge: true });
  });
  return campaignFrom(await ref.get());
}

function normalizeLanguage(value: unknown): CommunicationLanguage {
  return value === 'ru' || value === 'uz' || value === 'en' ? value : 'en';
}

function telegramLinked(profile: Partial<UserProfile>): boolean {
  const settings = profile.notifications;
  return Boolean(settings?.telegram.chatId && settings.telegram.status !== 'blocked' && settings.telegram.status !== 'unreachable');
}

function matchesAudience(profile: Partial<UserProfile>, campaign: CommunicationCampaign, now: number): boolean {
  const language = normalizeLanguage(profile.language);
  if (campaign.audience.languages.length && !campaign.audience.languages.includes(language)) return false;
  const linked = telegramLinked(profile);
  if (campaign.audience.telegram === 'linked' && !linked) return false;
  if (campaign.audience.telegram === 'unlinked' && linked) return false;
  if (campaign.audience.tier === 'all') return true;
  const activePremium = profile.subscription?.tier === 'premium' && Number(profile.subscription.premiumUntil ?? 0) > now;
  if (campaign.audience.tier === 'free') return !activePremium;
  if (campaign.audience.tier === 'premium') return activePremium && !profile.subscription?.isTrial;
  return activePremium && profile.subscription?.isTrial === true;
}

async function claimDueCampaign(now: number): Promise<CommunicationCampaign | null> {
  const sending = await campaigns().where('status', '==', 'sending').limit(20).get();
  const abandoned = sending.docs.map(campaignFrom).find((item) => Number((item as CommunicationCampaign & { dispatchLeaseUntil?: number }).dispatchLeaseUntil ?? 0) <= now);
  if (abandoned) {
    await campaigns().doc(abandoned.id).set({ status: 'scheduled', scheduledAt: now, updatedAt: now, lastError: 'Recovered after an interrupted dispatch.' }, { merge: true });
  }
  const snapshot = await campaigns().where('status', '==', 'scheduled').limit(20).get();
  const due = snapshot.docs.map(campaignFrom).filter((item) => Number(item.scheduledAt ?? 0) <= now).sort((a, b) => Number(a.scheduledAt) - Number(b.scheduledAt))[0];
  if (!due) return null;
  return db.runTransaction(async (transaction) => {
    const ref = campaigns().doc(due.id);
    const snap = await transaction.get(ref);
    if (!snap.exists || snap.data()?.status !== 'scheduled' || Number(snap.data()?.scheduledAt ?? 0) > now) return null;
    transaction.set(ref, { status: 'sending', startedAt: now, dispatchLeaseUntil: now + 30 * 60_000, updatedAt: now }, { merge: true });
    return { ...campaignFrom(snap), status: 'sending', startedAt: now };
  });
}

async function fanOut(campaign: CommunicationCampaign): Promise<void> {
  const now = Date.now();
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  const counters = { audience: 0, inAppDelivered: 0, telegramQueued: 0 };
  do {
    let query = db.collection('profiles').orderBy(admin.firestore.FieldPath.documentId()).limit(250);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    for (const document of snapshot.docs) {
      const profile = document.data() as UserProfile;
      if (!matchesAudience(profile, campaign, now)) continue;
      counters.audience += 1;
      const language = normalizeLanguage(profile.language);
      const content = campaign.content[language] ?? campaign.content.en;
      const preferences = communicationPreferences(profile);
      if (campaign.channels.includes('in_app') && preferences.marketing.inApp) {
        counters.inAppDelivered += 1;
        const ref = messages().doc(digest(`${campaign.id}:${document.id}`));
        try {
          await ref.create({ campaignId: campaign.id, userId: document.id, presentation: campaign.presentation, ...content, ctaUrl: campaign.ctaUrl, createdAt: now, readAt: null, clickedAt: null, dismissedAt: null });
        } catch (error) {
          if ((error as { code?: number | string }).code !== 6 && (error as { code?: number | string }).code !== 'already-exists') throw error;
        }
      }
      if (campaign.channels.includes('telegram') && preferences.marketing.telegram && telegramLinked(profile)) {
        counters.telegramQueued += 1;
        const deliveryRef = deliveries().doc(digest(`${campaign.id}:${document.id}:telegram`));
        const payload: CampaignPayload = { kind: 'campaign', campaignId: campaign.id, title: content.title, body: content.body, ctaLabel: content.ctaLabel, ctaUrl: campaign.ctaUrl };
        const queued = await createNotification({ userId: document.id, chatId: String(profile.notifications!.telegram.chatId), type: 'campaign', dedupeKey: `campaign:${campaign.id}:${document.id}`, payload });
        if (queued) await deliveryRef.create({ campaignId: campaign.id, userId: document.id, channel: 'telegram', status: 'queued', updatedAt: now });
      }
    }
    cursor = snapshot.docs.at(-1);
    if (snapshot.size < 250) break;
  } while (cursor);
  await campaigns().doc(campaign.id).set({
    status: 'completed', completedAt: Date.now(), dispatchLeaseUntil: null, updatedAt: Date.now(), lastError: null,
    'stats.audience': counters.audience,
    'stats.inAppDelivered': counters.inAppDelivered,
    'stats.telegramQueued': counters.telegramQueued,
  }, { merge: true });
}

export async function runCommunicationDispatch(now = Date.now()): Promise<boolean> {
  const campaign = await claimDueCampaign(now);
  if (!campaign) return false;
  try {
    await fanOut(campaign);
  } catch (error) {
    await campaigns().doc(campaign.id).set({ status: 'failed', lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500), updatedAt: Date.now() }, { merge: true });
    throw error;
  }
  return true;
}

export async function markCampaignTelegramOutcome(campaignId: string, uid: string, outcome: 'sent' | 'failed'): Promise<void> {
  const deliveryRef = deliveries().doc(digest(`${campaignId}:${uid}:telegram`));
  const campaignRef = campaigns().doc(campaignId);
  await db.runTransaction(async (transaction) => {
    const delivery = await transaction.get(deliveryRef);
    if (delivery.data()?.status === outcome) return;
    transaction.set(deliveryRef, { status: outcome, updatedAt: Date.now() }, { merge: true });
    transaction.set(campaignRef, { [`stats.telegram${outcome === 'sent' ? 'Sent' : 'Failed'}`]: FieldValue.increment(1), updatedAt: Date.now() }, { merge: true });
  });
}

export async function listInbox(uid: string): Promise<InAppMessage[]> {
  const snapshot = await messages().where('userId', '==', uid).limit(100).get();
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() } as InAppMessage)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function recordInAppEvent(uid: string, id: string, event: 'read' | 'click' | 'dismiss'): Promise<InAppMessage> {
  const ref = messages().doc(id);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists || snap.data()?.userId !== uid) throw AppError.notFound('Message not found.');
    const field = event === 'read' ? 'readAt' : event === 'click' ? 'clickedAt' : 'dismissedAt';
    if (snap.data()?.[field]) return;
    const now = Date.now();
    const markSeen = event === 'click' && !snap.data()?.readAt;
    transaction.set(ref, { [field]: now, ...(markSeen ? { readAt: now } : {}), updatedAt: now }, { merge: true });
    const metric = event === 'read' ? 'seen' : event === 'click' ? 'clicked' : 'dismissed';
    transaction.set(campaigns().doc(String(snap.data()?.campaignId)), { [`stats.${metric}`]: FieldValue.increment(1), updatedAt: now }, { merge: true });
    if (markSeen) transaction.set(campaigns().doc(String(snap.data()?.campaignId)), { 'stats.seen': FieldValue.increment(1) }, { merge: true });
  });
  const snap = await ref.get();
  return { id: snap.id, ...snap.data() } as InAppMessage;
}

export { defaultCommunicationPreferences };
