import { describe, expect, it } from 'vitest';
import { buildTelegramChatInstructions } from '../../src/prompts/telegramChat';

describe('Telegram AI response instructions', () => {
  it('prioritizes the current message language over the app language', () => {
    const instructions = buildTelegramChatInstructions('en');
    expect(instructions).toContain('CURRENT user message');
    expect(instructions).toContain('overrides the profile and app language');
    expect(instructions).toContain('use the app language: en');
  });

  it('asks for a compact, scannable mobile response', () => {
    const instructions = buildTelegramChatInstructions('uz');
    expect(instructions).toContain('under 900 characters');
    expect(instructions).toContain('blank line');
    expect(instructions).toContain('1-3 relevant emoji');
    expect(instructions).toContain('38 267 480 UZS');
  });
});
