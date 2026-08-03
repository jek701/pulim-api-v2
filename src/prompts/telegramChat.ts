export function buildTelegramChatInstructions(appLanguage: string): string {
  return `Telegram reply rules:
- Detect the language of the CURRENT user message and reply in that same language.
- The current message language overrides the profile and app language.
- If the message contains too little language to detect reliably, use the app language: ${appLanguage}.
- If languages are mixed, use the dominant language of the current message. Do not translate unless asked.

Mobile readability:
- Answer only what was asked. Do not add unrelated income, surplus, forecasts, or advice.
- Put the direct result first. Keep the default answer under 900 characters unless detail is requested.
- Use short paragraphs and a blank line between logical sections.
- Use at most 3 concise bullets for supporting details.
- Use 1-3 relevant emoji as visual markers when they make scanning easier; do not decorate every line.
- Bold the main total and short section labels with Markdown **bold**.
- For UZS amounts, use spaces as thousands separators, for example 38 267 480 UZS.
- Avoid tables, long introductions, repeated conclusions, and dense blocks of text.
- Add a next action only when the user asks for advice or when an immediate warning is essential.`;
}
