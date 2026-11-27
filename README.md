# Claude bot: Shopify Horizon delivery system

Figma screenshots + style guide do, bots poori theme banate hain. Aap dashboard pe live dekhte ho.

```
Design reader → Frontend bot (parallel) → UAT bot → QA bot → Fix bot → QA re-test → Closed
                Backend bot (parallel: pages, blog, menus, collections, products)
```

## Folder (D:\Claude bot)

```
Claude bot/
├── theme_export__pranic-dru…/   ← aapki Horizon theme (bots sirf isme kaam karte hain)
├── CLAUDE.md                    ← orchestrator ke rules (Claude Code khud padhta hai)
├── .claude/
│   ├── agents/                  ← 6 bots: design-reader, frontend-bot, backend-bot, uat-bot, qa-bot, fix-bot
│   ├── commands/                ← /build-site, /bot-status, /style-guide
│   └── settings.json            ← permissions (live theme push/publish blocked)
├── inputs/
│   ├── figma/                   ← 01-home.png, 02-about-us.png … (README dekho)
│   ├── style-guide.json         ← colours, fonts, H1–H6, p, span, buttons, spacing
│   ├── style-guide/             ← (optional) style guide images/PDF
│   └── brief.md                 ← requirements
├── pipeline/
│   ├── board.js                 ← board CLI (bots isi se cards move karte hain)
│   ├── tokens.js                ← style guide → theme/assets/bot-tokens.css
│   ├── push.js                  ← sirf unpublished bot theme pe push
│   ├── shots.js                 ← 375/768/1440 screenshots (UAT/QA ke liye)
│   ├── admin.js                 ← Admin GraphQL (Backend bot)
│   └── config.json              ← store, themeId, password
├── dashboard/                   ← live board: http://localhost:4321
└── reports/                     ← specs, screenshots, report.md
```

## Ek baar ka setup

1. **Zip extract** karo `D:\Claude bot` me (theme folder ke saath, same level pe).
2. **Node 18+ aur Shopify CLI** check karo (VS Code terminal me):
   ```
   node -v
   shopify version
   ```
   Shopify CLI nahi hai to: `npm install -g @shopify/cli@latest`
3. `pipeline/config.json` me `store` daalo (jaise `pranic-xyz.myshopify.com`), aur store password protected hai to `storePassword`.
4. **Bot theme banao** (live theme ko kabhi touch nahi karega). Terminal me:
   ```
   shopify theme push --unpublished --store pranic-xyz.myshopify.com --path "theme_export__pranic-dru..."
   ```
   Theme ka naam do, jaise `Bot build`. Jo **theme ID** mile wo `pipeline/config.json` → `themeId` me daalo.
   (Ye step skip karoge to system **local mode** me chalega: code banega aur QA code-level hoga, preview screenshots nahi.)
5. **Screenshots ke liye** (recommended):
   ```
   npm install
   npm run shots:install
   ```
6. **Backend bot ke liye** (optional): `.env.example` ko `.env` me copy karo aur Admin API token daalo.
   Token nahi hai to Backend bot import files + manual steps bana dega.

## Har project pe

1. `inputs/figma/` me 7 screenshots daalo (`01-home.png` … `07-blog-detail.png`).
2. `inputs/style-guide.json` bharo, ya style guide images `inputs/style-guide/` me daal ke Claude Code me `/style-guide` chalao.
3. `inputs/brief.md` bharo.
4. Doosre terminal me dashboard chalao: `npm run dashboard` → browser me http://localhost:4321
5. Claude Code panel me likho: **`/build-site new Pranic test`**

Bots kaam karte dikhenge: cards ek column se doosre me move honge, bugs aur logs har card pe.
Beech me status chahiye: `/bot-status`. Ruk gaya to dobara `/build-site` (bina `new`) chalao, wahi se resume karega.

## Kya kab human karega

- **Needs human** column ke cards (3 fix rounds ke baad bhi bug) aapko dekhne hain. Fix karke: `node pipeline/board.js unblock C07`
- Final review + client UAT + publish hamesha human karega.

## Board CLI (manual control)

```
node pipeline/board.js status            # summary
node pipeline/board.js release C05       # atka hua card free karo
node pipeline/board.js unblock C07       # human fix ke baad wapas QA
node pipeline/board.js report            # reports/report.md
```

## Tips (pehle hafte ke liye)

- Har run ke baad `reports/report.md` dekho. Jo bug baar-baar aaye, uska rule `CLAUDE.md` ke "Hard rules" me add karo. Bot agli baar wo galti nahi karega.
- Achhe bane `custom-*` sections ko ek kit folder me save karte jao; agle projects me Frontend bot unhe reuse karega.
- Bots `sonnet` model pe chalte hain (usage bachane ke liye). Quality kam lage to `.claude/agents/*.md` me `model: opus` kar do.
