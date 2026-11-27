---
description: Run the full bot pipeline (design → frontend → UAT → QA → fix → closed) for the current inputs. Resumes if a run exists.
argument-hint: [new] [project name]
---
You are the orchestrator. Follow `CLAUDE.md`. Do not write theme code yourself; delegate to the subagents. Arguments: $ARGUMENTS

## 0. Preflight (report in 4-6 Hinglish lines)
- `node pipeline/board.js` (prints help, proves Node works). Read `pipeline/config.json`.
- Theme folder detected? (`theme_export__*` with `config/settings_schema.json`). Is it Horizon (check `config/settings_schema.json` theme_name)?
- `inputs/figma/` has screenshots? `inputs/style-guide.json` filled (brand not "Sample brand")? `inputs/brief.md` filled?
- Mode: **live preview** if `themeId` + `store` set (push + screenshots), else **local mode** (code-only UAT/QA, no push). Say which.
- If screenshots are missing, stop and ask for them.
- Run `node pipeline/slice.js` so every tall screenshot is cut into readable parts under `inputs/figma/slices/`.
- If `pipeline/board.json` exists and the arguments do not contain `new`: resume (skip to step 3).
  Else: `node pipeline/board.js init --project "<name from args or config>" --force`.
- Tell the user: dashboard is at http://localhost:4321 (run `npm run dashboard` in a second terminal if not already running).

## 1. Style guide
If the style guide still has placeholder values: run the **design-reader** subagent with "Mode: style". Otherwise just run `node pipeline/tokens.js`.

## 2. Design + backend (parallel)
In ONE message launch, in parallel:
- one **design-reader** per page from `pipeline/board.json` → `pages` with "Mode: page <Page name>" (Home first in the list, max 4 at once; launch the rest after),
- one **backend-bot** (run it in the background if possible).
When design readers return, check `node pipeline/board.js status` shows cards.

## 3. Build loop
Repeat until the status output says `ALL_DONE=true`:
1. `node pipeline/board.js status`.
2. In ONE message launch in parallel:
   - **frontend-bot** × min(backlog cards on different pages, `frontendParallel` from config),
   - **uat-bot** × 1 if any card is in `park`,
   - **qa-bot** × 1 if any card is in `qa`,
   - **fix-bot** × 1 if any card is in `fix`.
   Each bot claims its own card with `board.js next`, so just tell each "Pick the next card and finish it".
3. When they return, give the user one short progress line (e.g. "Round 3: 9/20 closed, 4 bugs open").
4. If a round makes no progress (same status twice), check for cards stuck with an owner and run `node pipeline/board.js release <id>`.
Cards in `blocked` are left for the human; do not loop on them.

## 4. Finish
- `shopify theme check --path "<themeDir>"` once for the whole theme; any error in `custom-*` files → log as bug on the right card and continue the loop.
- `node pipeline/board.js report`, then read `reports/report.md`.
- Final message (Hinglish): pages done, sections closed, bugs found/fixed, blocked cards with reasons, manual backend steps, preview link
  `https://<store>/?preview_theme_id=<themeId>` if live mode, and what the human should review before client UAT.
