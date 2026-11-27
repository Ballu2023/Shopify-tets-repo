#!/usr/bin/env node
// Zero-dependency live dashboard. Run: npm run dashboard  → http://localhost:4321
const http = require('http');
const fs = require('fs');
const path = require('path');
const { P, readJSON } = require('../pipeline/lib');

const PORT = +process.env.PORT || 4321;
const html = path.join(__dirname, 'index.html');
const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.md': 'text/plain; charset=utf-8' };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/api/board') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(readJSON(P.board, null)));
  }
  // Serve screenshots and reports so the dashboard can show them.
  if (url.startsWith('/inputs/') || url.startsWith('/reports/')) {
    const file = path.resolve(P.root, '.' + url);
    const inside = [P.inputs, P.reports].some(d => file.startsWith(d + path.sep));
    if (!inside ||!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(url === '/board' ? path.join(__dirname, 'board.html') : html).pipe(res);
}).listen(PORT, () => console.log(`Bot dashboard: http://localhost:${PORT}  (Ctrl+C to stop)`));