#!/usr/bin/env node
// Board CLI: the single source of truth that bots update and the dashboard reads.
// Usage: node pipeline/board.js <command> [args] [--flags]
const fs = require('fs');
const path = require('path');
const { P, STAGES, BOTS, BOT_NAMES, PICK, WORKING, MAX_FIX_ROUNDS, readJSON, writeJSON, config, withBoard } = require('./lib');

const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = [], flag = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; flag[k] = v; }
  else pos.push(argv[i]);
}
const now = () => new Date().toISOString();
class CliError extends Error {}
const die = m => { throw new CliError(m); };
const out = o => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

function pushLog(board, card, bot, msg) {
  const e = { t: now(), bot, card: card ? card.id : null, msg: (card ? card.name + ': ' : '') + msg };
  board.feed.unshift(e); board.feed = board.feed.slice(0, 300);
  if (card) card.log.push(e);
}
function getCard(board, id) { const c = board.cards.find(x => x.id === id); if (!c) die('No card ' + id); return c; }
function needBot(b) { if (!BOTS.includes(b)) die('Unknown bot "' + b + '". Use one of: ' + BOTS.join(', ')); return b; }
function setBot(board, bot, status, task) { board.bots[bot] = { status, task: task || '', at: now() }; }
function refreshBot(board, bot) {
  if (!PICK[bot]) return;
  const mine = board.cards.filter(c => c.owner === bot);
  setBot(board, bot, mine.length ? 'working' : 'idle', mine.map(c => c.page + ' / ' + c.name).join(', '));
}
function pageFromFile(f) {
  const s = path.basename(f, path.extname(f)).replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' ').trim().toLowerCase();
  const acr = { pdp: 'PDP', plp: 'PLP', faq: 'FAQ' };
  return s.split(' ').map(w => acr[w] || w).join(' ').replace(/^\w/, m => m.toUpperCase());
}

const commands = {
  init() {
    if (fs.existsSync(P.board) && !flag.force) die('Board already exists. Use --force to start a fresh run (old board is archived to reports/).');
    if (fs.existsSync(P.board)) {
      fs.mkdirSync(P.reports, { recursive: true });
      fs.copyFileSync(P.board, path.join(P.reports, 'board-' + Date.now() + '.json'));
    }
    const cfg = config();
    const shots = fs.existsSync(P.figma) ? fs.readdirSync(P.figma).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort() : [];
    const board = {
      project: flag.project || cfg.project || 'Untitled project',
      themeDir: cfg.themeDir,
      startedAt: now(), updatedAt: now(),
      pages: shots.reduce((acc, f) => {
        const mobile = /[-_ ]mobile$/i.test(path.basename(f, path.extname(f)));
        const name = pageFromFile(f.replace(/[-_ ]mobile(?=\.\w+$)/i, ''));
        let p = acc.find(x => x.name === name);
        if (!p) acc.push(p = { name, desktop: '', mobile: '' });
        p[mobile ? 'mobile' : 'desktop'] = 'inputs/figma/' + f;
        return acc;
      }, []),
      bots: Object.fromEntries(BOTS.map(b => [b, { status: 'idle', task: '', at: now() }])),
      backend: [],
      cards: [], feed: [],
    };
    writeJSON(P.board, board);
    out(`Board ready for "${board.project}". Theme: ${board.themeDir || 'NOT FOUND'}. Pages from screenshots: ${board.pages.map(p => p.name).join(', ') || 'none'}`);
  },

  add() {
    if (!flag.page || !flag.name) die('add needs --page and --name');
    const id = withBoard(b => {
      const id = 'C' + String(b.cards.length + 1).padStart(2, '0');
      const card = { id, page: flag.page, name: flag.name, file: flag.file || '', template: flag.template || '', spec: flag.spec || '',
        stage: 'backlog', owner: null, rework: 0, fixRounds: 0, bugs: [], log: [], created: now() };
      b.cards.push(card);
      pushLog(b, card, flag.bot || 'dr', 'Card bana: spec ' + (card.spec || '-'));
      return id;
    });
    out(id);
  },

  // Atomically pick + claim the next card for a bot. Never gives two fe/fix bots the same page at once.
  next() {
    const bot = needBot(pos[0]);
    if (!PICK[bot]) die(bot + ' does not pick cards');
    const card = withBoard(b => {
      const busyPages = new Set(b.cards.filter(c => c.owner === 'fe' || c.owner === 'fix').map(c => c.page));
      const c = b.cards.find(x => x.stage === PICK[bot] && !x.owner && ((bot !== 'fe' && bot !== 'fix') || !busyPages.has(x.page)) && (!flag.page || x.page === flag.page));
      if (!c) return null;
      c.owner = bot; c.stage = WORKING[bot];
      pushLog(b, c, bot, 'Kaam shuru');
      refreshBot(b, bot);
      return c;
    });
    out(card || {});
  },

  claim() {
    const bot = needBot(flag.bot);
    out(withBoard(b => {
      const c = getCard(b, pos[0]);
      if (c.owner && c.owner !== bot) die(c.id + ' is owned by ' + c.owner);
      if (c.stage !== PICK[bot] && c.stage !== WORKING[bot]) die(c.id + ' is in ' + c.stage + ', ' + bot + ' picks from ' + PICK[bot]);
      c.owner = bot; c.stage = WORKING[bot];
      pushLog(b, c, bot, 'Kaam shuru'); refreshBot(b, bot);
      return c;
    }));
  },

  // Finish a bot's work on a card and move it on. Rules of the flow live here, not in the prompts.
  done() {
    const bot = needBot(flag.bot), to = flag.to;
    if (!STAGES.includes(to)) die('--to must be one of ' + STAGES.join(', '));
    const allowed = { fe: ['park'], uat: ['qa', 'backlog'], qa: ['closed', 'fix'], fix: ['qa'] };
    if (!allowed[bot] || !allowed[bot].includes(to)) die(bot + ' can only move a card to: ' + (allowed[bot] || []).join(', '));
    out(withBoard(b => {
      const c = getCard(b, pos[0]);
      if (c.owner !== bot) die(c.id + ' is not claimed by ' + bot + ' (owner: ' + c.owner + ')');
      const open = c.bugs.filter(x => x.status === 'open').length;
      if (bot === 'qa' && to === 'closed' && (open || c.bugs.some(x => x.status === 'fixed'))) die('Cannot close: bugs still open or not verified. Run verify first.');
      if (bot === 'qa' && to === 'fix' && !open) die('Send to fix only with open bugs (use bug command first).');
      if (bot === 'fix' && open) die('Still ' + open + ' open bugs. Mark each with bugfixed first.');
      let dest = to;
      if (bot === 'uat' && to === 'backlog') c.rework++;
      if (bot === 'fix') c.fixRounds++;
      if (bot === 'qa' && to === 'fix' && c.fixRounds >= (config().maxFixRounds || MAX_FIX_ROUNDS)) dest = 'blocked';
      c.stage = dest; c.owner = null;
      pushLog(b, c, bot, (flag.msg || 'Done') + (dest === 'blocked' ? ' (max fix rounds, needs human)' : ''));
      refreshBot(b, bot);
      return { id: c.id, stage: c.stage };
    }));
  },

  release() {
    out(withBoard(b => { const c = getCard(b, pos[0]); const was = c.owner; c.owner = null; c.stage = { dev: 'backlog', uat: 'park' }[c.stage] || c.stage; pushLog(b, c, was || 'dr', 'Released'); if (was) refreshBot(b, was); return c.id + ' released'; }));
  },

  unblock() {
    out(withBoard(b => { const c = getCard(b, pos[0]); if (c.stage !== 'blocked') die('not blocked'); c.stage = 'qa'; c.fixRounds = 0; pushLog(b, c, 'qa', 'Human ne unblock kiya, QA re-test'); return c.id; }));
  },

  log() {
    const bot = needBot(flag.bot);
    withBoard(b => { const c = pos[0] && pos[0] !== '-' ? getCard(b, pos[0]) : null; pushLog(b, c, bot, flag.msg || ''); });
    out('ok');
  },

  bug() {
    if (!flag.msg) die('bug needs --msg');
    out(withBoard(b => {
      const c = getCard(b, pos[0]);
      const bug = { id: c.id + '-B' + (c.bugs.length + 1), text: flag.msg, severity: flag.severity || 'medium', where: flag.where || '', status: 'open', at: now() };
      c.bugs.push(bug); pushLog(b, c, flag.bot || 'qa', 'Bug: ' + flag.msg);
      return bug.id;
    }));
  },

  bugfixed() {
    out(withBoard(b => {
      const c = getCard(b, pos[0]); const bug = c.bugs.find(x => x.id === pos[1]); if (!bug) die('No bug ' + pos[1]);
      bug.status = 'fixed'; bug.fix = flag.msg || ''; pushLog(b, c, 'fix', 'Fixed ' + bug.id + (flag.msg ? ': ' + flag.msg : ''));
      return bug.id + ' fixed';
    }));
  },

  verify() {
    out(withBoard(b => {
      const c = getCard(b, pos[0]); const reopen = (flag.reopen || '').split(',').filter(Boolean);
      let v = 0, r = 0;
      for (const x of c.bugs) if (x.status === 'fixed') { if (reopen.includes(x.id)) { x.status = 'open'; r++; } else { x.status = 'verified'; v++; } }
      pushLog(b, c, 'qa', `Re-test: ${v} verified, ${r} reopened`);
      return { verified: v, reopened: r };
    }));
  },

  botstate() {
    const bot = needBot(pos[0]);
    withBoard(b => { setBot(b, bot, flag.status || 'working', flag.task || ''); if (flag.msg) pushLog(b, null, bot, flag.msg); });
    out('ok');
  },

  betask() {
    // Backend tasks list: betask add "Import products" | betask done 1
    out(withBoard(b => {
      if (pos[0] === 'add') { b.backend.push({ n: b.backend.length + 1, name: pos.slice(1).join(' '), status: 'todo' }); return b.backend.length; }
      const t = b.backend.find(x => x.n === +pos[1]); if (!t) die('No backend task ' + pos[1]);
      t.status = pos[0] === 'done' ? 'done' : pos[0] === 'start' ? 'working' : t.status;
      pushLog(b, null, 'be', t.name + ': ' + t.status);
      return t;
    }));
  },

  status() {
    const b = readJSON(P.board, null); if (!b) die('No board');
    const by = Object.fromEntries(STAGES.map(s => [s, b.cards.filter(c => c.stage === s)]));
    const lines = [`Project: ${b.project}  |  cards: ${b.cards.length}`];
    for (const s of STAGES) lines.push(`${s.padEnd(8)} ${String(by[s].length).padStart(3)}  ${by[s].map(c => c.id + (c.owner ? '(' + c.owner + ')' : '')).join(' ')}`);
    lines.push('Bots: ' + BOTS.map(x => `${x}=${b.bots[x].status}`).join('  '));
    const open = b.cards.reduce((a, c) => a + c.bugs.filter(x => x.status !== 'verified').length, 0);
    lines.push(`Open/unverified bugs: ${open}`);
    lines.push('ALL_DONE=' + (b.cards.length > 0 && b.cards.every(c => c.stage === 'closed' || c.stage === 'blocked') && !b.backend.some(t => t.status !== 'done')));
    out(lines.join('\n'));
  },

  report() {
    const b = readJSON(P.board, null); if (!b) die('No board');
    const bugs = b.cards.flatMap(c => c.bugs.map(x => ({ ...x, card: c })));
    const mins = Math.round((Date.parse(b.updatedAt) - Date.parse(b.startedAt)) / 60000);
    const pages = [...new Set(b.cards.map(c => c.page))];
    let md = `# Run report: ${b.project}\n\nStarted ${b.startedAt}, last update ${b.updatedAt} (${mins} min).\n\n`;
    md += `| Metric | Value |\n|---|---|\n| Sections | ${b.cards.length} |\n| Closed | ${b.cards.filter(c => c.stage === 'closed').length} |\n| Needs human | ${b.cards.filter(c => c.stage === 'blocked').length} |\n| Bugs found | ${bugs.length} |\n| Bugs verified | ${bugs.filter(x => x.status === 'verified').length} |\n| UAT rejects | ${b.cards.reduce((a, c) => a + c.rework, 0)} |\n\n`;
    md += `## Pages\n\n| Page | Sections | Closed | Bugs |\n|---|---|---|---|\n`;
    for (const p of pages) { const cs = b.cards.filter(c => c.page === p); md += `| ${p} | ${cs.length} | ${cs.filter(c => c.stage === 'closed').length} | ${cs.reduce((a, c) => a + c.bugs.length, 0)} |\n`; }
    md += `\n## Bugs\n\n| Bug | Section | Severity | Status | Issue |\n|---|---|---|---|---|\n`;
    for (const x of bugs) md += `| ${x.id} | ${x.card.page} / ${x.card.name} | ${x.severity} | ${x.status} | ${x.text.replace(/\|/g, '/')} |\n`;
    if (b.backend.length) { md += `\n## Backend tasks\n\n`; for (const t of b.backend) md += `- [${t.status === 'done' ? 'x' : ' '}] ${t.name}\n`; }
    fs.mkdirSync(P.reports, { recursive: true });
    const file = path.join(P.reports, 'report.md'); fs.writeFileSync(file, md);
    out('Report written: reports/report.md');
  },
};

if (!commands[cmd]) {
  out(`Commands: ${Object.keys(commands).join(', ')}\nBots: ${BOTS.map(b => b + '=' + BOT_NAMES[b]).join(', ')}\nStages: ${STAGES.join(' > ')}`);
  process.exit(cmd ? 1 : 0);
}
try { commands[cmd](); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }