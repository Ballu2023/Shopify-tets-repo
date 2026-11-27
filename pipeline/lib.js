// Shared helpers: paths, config, theme detection, board read/write with a file lock.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = {
  root: ROOT,
  config: path.join(ROOT, 'pipeline', 'config.json'),
  board: path.join(ROOT, 'pipeline', 'board.json'),
  lock: path.join(ROOT, 'pipeline', 'board.lock'),
  inputs: path.join(ROOT, 'inputs'),
  figma: path.join(ROOT, 'inputs', 'figma'),
  styleGuide: path.join(ROOT, 'inputs', 'style-guide.json'),
  reports: path.join(ROOT, 'reports'),
  specs: path.join(ROOT, 'reports', 'specs'),
  shots: path.join(ROOT, 'reports', 'shots'),
};

const STAGES = ['backlog', 'dev', 'park', 'uat', 'qa', 'fix', 'blocked', 'closed'];
const BOTS = ['dr', 'fe', 'be', 'uat', 'qa', 'fix'];
const BOT_NAMES = { dr: 'Design reader', fe: 'Frontend bot', be: 'Backend bot', uat: 'UAT bot', qa: 'QA bot', fix: 'Fix bot' };
// Which stage each bot picks work from, and which stage the card sits in while that bot works.
const PICK = { fe: 'backlog', uat: 'park', qa: 'qa', fix: 'fix' };
const WORKING = { fe: 'dev', uat: 'uat', qa: 'qa', fix: 'fix' };
const MAX_FIX_ROUNDS = 3;

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function config() {
  const c = readJSON(P.config, {});
  if (!c.themeDir) c.themeDir = detectTheme();
  return c;
}

// The theme folder is the first sub-folder that has config/settings_schema.json.
function detectTheme() {
  for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.') || ['node_modules', 'pipeline', 'dashboard', 'inputs', 'reports'].includes(d.name)) continue;
    if (fs.existsSync(path.join(ROOT, d.name, 'config', 'settings_schema.json'))) return d.name;
  }
  return null;
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Several bots run in parallel, so every board change goes through this lock.
function withBoard(fn) {
  const start = Date.now();
  let fd;
  while (true) {
    try { fd = fs.openSync(P.lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(P.lock).mtimeMs > 15000) fs.unlinkSync(P.lock); } catch {}
      if (Date.now() - start > 20000) throw new Error('Board lock timeout');
      sleep(50 + Math.random() * 100);
    }
  }
  try {
    const board = readJSON(P.board, null);
    if (!board) throw new Error('Board not initialised. Run: node pipeline/board.js init --project "Name"');
    const out = fn(board);
    board.updatedAt = new Date().toISOString();
    writeJSON(P.board, board);
    return out;
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(P.lock); } catch {}
  }
}

module.exports = { P, STAGES, BOTS, BOT_NAMES, PICK, WORKING, MAX_FIX_ROUNDS, readJSON, writeJSON, config, detectTheme, withBoard };
