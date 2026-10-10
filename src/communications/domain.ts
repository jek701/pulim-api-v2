import { z } from 'zod';

export const communicationLanguages = ['ru', 'uz', 'en'] as const;
export type CommunicationLanguage = typeof communicationLanguages[number];
export type CommunicationChannel = 'in_app' | 'telegram';
export type CommunicationPresentation = 'inbox' | 'banner' | 'modal';
export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'failed';

export interface LocalizedCampaignContent {
  title: string;
  body: string;
  ctaLabel?: string;
}

export interface CampaignAudience {
  tier: 'all' | 'free' | 'premium' | 'trial';
  languages: CommunicationLanguage[];
  telegram: 'any' | 'linked' | 'unlinked';
}

export interface CampaignStats {
  audience: number;
  inAppDelivered: number;
  telegramQueued: number;
  telegramSent: number;
  telegramFailed: number;
  seen: number;
  clicked: number;
  dismissed: number;
}

export interface CommunicationCampaign {
  id: string;
  name: string;
  content: Record<CommunicationLanguage, LocalizedCampaignContent>;
  channels: CommunicationChannel[];
  presentation: CommunicationPresentation;
  audience: CampaignAudience;
  ctaUrl?: string;
  status: CampaignStatus;
  scheduledAt: number | null;
  stats: CampaignStats;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  lastError: string | null;
}

export interface CommunicationPreferences {
  marketing: { inApp: boolean; telegram: boolean };
}

export interface InAppMessage {
  id: string;
  campaignId: string;
  userId: string;
  presentation: CommunicationPresentation;
  title: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  createdAt: number;
  readAt: number | null;
  clickedAt: number | null;
  dismissedAt: number | null;
}

const contentSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(2_000),
  ctaLabel: z.string().trim().max(40).optional(),
});

const ctaUrlSchema = z.string().trim().max(1_000).refine((value) => {
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}, 'CTA must be an internal path or an HTTPS URL.');

const campaignFields = {
  name: z.string().trim().min(1).max(100),
  content: z.object({ ru: contentSchema, uz: contentSchema, en: contentSchema }),
  channels: z.array(z.enum(['in_app', 'telegram'])).min(1).max(2).transform((value) => [...new Set(value)]),
  presentation: z.enum(['inbox', 'banner', 'modal']),
  audience: z.object({
    tier: z.enum(['all', 'free', 'premium', 'trial']).default('all'),
    languages: z.array(z.enum(communicationLanguages)).max(3).default([]),
    telegram: z.enum(['any', 'linked', 'unlinked']).default('any'),
  }),
  ctaUrl: ctaUrlSchema.optional(),
};

export const campaignCreateSchema = z.object(campaignFields);
export const campaignPatchSchema = z.object(campaignFields).partial().refine((value) => Object.keys(value).length > 0);
export const campaignSendSchema = z.object({ scheduledAt: z.number().int().positive().nullable().optional() });
export const communicationPreferencesPatchSchema = z.object({
  marketing: z.object({ inApp: z.boolean().optional(), telegram: z.boolean().optional() }).refine((value) => Object.keys(value).length > 0),
});

export const defaultCommunicationPreferences = (): CommunicationPreferences => ({
  marketing: { inApp: true, telegram: false },
});

export const emptyCampaignStats = (): CampaignStats => ({
  audience: 0,
  inAppDelivered: 0,
  telegramQueued: 0,
  telegramSent: 0,
  telegramFailed: 0,
  seen: 0,
  clicked: 0,
  dismissed: 0,
});
