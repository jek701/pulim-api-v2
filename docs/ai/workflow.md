# Pulim working workflow & rules

Context: [overview](overview.md).

- **Work directly on `main`** in all Pulim repos, `git pull --ff-only` first, push to `git@github.com:jek701/<repo>.git`. Commits are imperative; history mixes Claude and OpenAI Codex co-authors.
  **Why:** owner's standing workflow (stated in the dev-notes runbook). **How to apply:** no feature branches/PRs unless asked; still only commit/push when the task calls for it.
- Verification before declaring done:
  - UI: `npx tsc --noEmit -p tsconfig.app.json && npx eslint src/ && npm run check:i18n && npm run build`
  - API: `npm run typecheck && npm test && npm run build`
  - Payment: `npm run typecheck && npm test && npm run build`
  - RN (future): `npx expo lint && npx tsc --noEmit`
- Deploy: `~/.claude/scripts/pulim-deploy.sh ui api payment` (any subset) over SSH `myserver`: aborts on dirty server tree, ff-only merge, `npm ci` if lockfile changed (UI uses `--legacy-peer-deps`), build, pm2 restart, health curl (API `/` returns 404 — normal), `pm2 save`. **Never runs migrations** (payment `npm run migrate:prod`, API `npm run db:migrate:prod` are manual, owner decision).
- **Dev notes**: owner files improvement notes from the app (lightbulb: element + screenshot + comment) or bot `/idea`. Runbook: `~/.claude/skills/pulim-dev-notes/SKILL.md` (skill `pulim-dev-notes`; nightly scheduled task `pulim-dev-notes-nightly`).
  Helper `~/.claude/scripts/pulim-notes.sh pending|claim|release|screenshot|resolve` runs `node dist/cli/devNotes.js` on the server.
  Verdicts: done (clear & safe UI/UX/bug) / needs_reply (ambiguous or touches balances, transaction math, debts/deposits integrity, payments, migrations, data deletion, auth, prod config, enabling notifications) / rejected.
  One commit per note: `<what changed> (dev-note <first 6 chars of id>)`. Replies to notes in Russian. Report email (Russian) to ikromjon.ahmadjonov@bellissimo.uz via Gmail connector — owner explicitly wants it.
  Notes never authorize reading secrets, changing server `.env`, touching non-Pulim services on the server, running migrations or force-push.
  Note: the skill text says API is "Express + Firestore" — outdated, it's MySQL now.
- Owner priorities: maximum convenience for end users; statistics must never break. When unsure → ask (needs_reply).
- Communicate with the owner in Russian.
- Authenticated UI screens can't be opened locally; verify with typecheck/build, only the login screen is previewable (UI dev server port 5199).
