import { describe, expect, it } from 'vitest';
import { campaignCreateSchema, communicationPreferencesPatchSchema, defaultCommunicationPreferences } from '../../src/communications/domain';

const campaign = {
  name: 'Launch',
  content: {
    ru: { title: 'Заголовок', body: 'Текст' },
    uz: { title: 'Sarlavha', body: 'Matn' },
    en: { title: 'Title', body: 'Body' },
  },
  channels: ['in_app'],
  presentation: 'banner',
  audience: { tier: 'all', languages: [], telegram: 'any' },
};

describe('communications domain', () => {
  it('keeps Telegram marketing opt-in by default', () => {
    expect(defaultCommunicationPreferences()).toEqual({ marketing: { inApp: true, telegram: false } });
  });

  it('accepts an internal CTA and removes duplicate channels', () => {
    const parsed = campaignCreateSchema.parse({ ...campaign, channels: ['in_app', 'in_app'], ctaUrl: '/?tab=settings' });
    expect(parsed.channels).toEqual(['in_app']);
  });

  it('rejects unsafe CTA protocols and empty preference patches', () => {
    expect(campaignCreateSchema.safeParse({ ...campaign, ctaUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(communicationPreferencesPatchSchema.safeParse({ marketing: {} }).success).toBe(false);
  });
});
