const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, 'public');
const rooms = new Map();
const port = Number(process.env.PORT || 3000);
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function code() {
  let result;
  do { result = Array.from(crypto.randomBytes(6), byte => alphabet[byte % alphabet.length]).join(''); }
  while (rooms.has(result));
  return result;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, room] of rooms) if (now - room.updatedAt > 60 * 60 * 1000) rooms.delete(key);
}, 60 * 1000).unref();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/room') {
    if (req.method === 'GET') {
      const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
      return room ? json(res, 200, { ...room, noteHeld: room.noteHeld && Date.now() - room.chanterAt < 1500 }) : json(res, 404, { error: 'Room not found' });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2048) return json(res, 413, { error: 'Request too large' });
      }
      const body = JSON.parse(raw);
      const now = Date.now();
      if (body.action === 'create') {
        const key = code();
        rooms.set(key, { holes: '1111111', noteHeld: false, energy: 0, tilt: 0, chanterAt: 0, bagAt: 0, updatedAt: now });
        return json(res, 200, { code: key });
      }
      const key = String(body.code || '').toUpperCase();
      const room = rooms.get(key);
      if (!room) return json(res, 404, { error: 'Room not found' });
      if (!['chanter', 'bag'].includes(body.role)) return json(res, 400, { error: 'Invalid role' });
      if (body.action === 'join') {
        room[body.role === 'chanter' ? 'chanterAt' : 'bagAt'] = now;
      } else if (body.action === 'update' && body.role === 'chanter' && /^[01]{7}$/.test(body.holes) && typeof body.noteHeld === 'boolean') {
        room.holes = body.holes;
        room.noteHeld = body.noteHeld;
        room.chanterAt = now;
      } else if (body.action === 'update' && body.role === 'bag' && Number.isFinite(body.energy) && Number.isFinite(body.tilt)) {
        room.energy = Math.max(0, Math.min(100, body.energy));
        room.tilt = Math.max(-90, Math.min(90, body.tilt));
        room.bagAt = now;
      } else return json(res, 400, { error: 'Invalid update' });
      room.updatedAt = now;
      return json(res, 200, { ok: true });
    } catch { return json(res, 400, { error: 'Invalid request' }); }
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.resolve(root, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(root + path.sep)) return json(res, 404, { error: 'Not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wav': 'audio/wav' };
  fs.stat(file, (error, stats) => {
    if (error || !stats.isFile()) return json(res, 404, { error: 'Not found' });
    const ext=path.extname(file);
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      ...(ext==='.html'||ext==='.js'||ext==='.css' ? {'Cache-Control':'no-store'} : {})
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, '0.0.0.0', () => console.log(`Digital Gaida running on port ${port}`));
