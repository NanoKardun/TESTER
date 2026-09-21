'use strict';
/* =====================================================================
   KuisKu Online – server game kuis multiplayer
   - Tanpa dependensi (hanya modul bawaan Node.js 18+)
   - Realtime lewat Server-Sent Events (SSE) + POST biasa
   - Server yang memegang kunci jawaban, waktu, dan skor (anti-curang)
   Jalankan:  node server.js   lalu buka http://localhost:3000
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- Konfigurasi (bisa diubah lewat environment variable) ---------- */
const PORT         = Number(process.env.PORT) || 3000;
const MIN_PLAYERS  = Math.max(1, Number(process.env.MIN_PLAYERS) || 2);   // minimal pemain untuk mulai
const MAX_PLAYERS  = Math.max(MIN_PLAYERS, Number(process.env.MAX_PLAYERS) || 30);
const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 4000;           // hitung mundur sebelum soal 1
const REVEAL_MS    = Number(process.env.REVEAL_MS) || 6000;              // jeda pembahasan tiap soal
const DROP_GRACE_MS = 10000;        // pemain terputus di ruang tunggu dihapus setelah ini
const LOW_GRACE_MS  = 15000;        // game berhenti jika pemain aktif < minimal selama ini
const MAX_ROOMS    = 300;

/* ---------- Muat & validasi kuis ---------- */
const QUIZZES = require('./quizzes').filter(z => z && z.id && z.title && Array.isArray(z.questions) && z.questions.length &&
  z.questions.every(q => q && q.q && Array.isArray(q.options) && q.options.length === 4 &&
    Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4));
if (!QUIZZES.length) { console.error('Tidak ada kuis valid di quizzes.js'); process.exit(1); }

const AVATARS = ['🦊','🐼','🐯','🦄','🐸','🐙','🐧','🦁','🐨','🐵','🐰','🐻','🦉','🐢','🐬','🦋','🐞','🐳','🦖','🐝'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();

/* ---------- Utilitas ---------- */
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cleanName = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
const genCode = () => { for (;;) { let c = ''; for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!rooms.has(c)) return c; } };
function json(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 4096) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/* ---------- Model ruang & pemain ---------- */
function createRoom(quiz) {
  const room = { code: genCode(), quiz, hostId: null, players: new Map(), phase: 'lobby', qs: [], qi: 0,
    phaseEndsAt: 0, qEndsAt: 0, lowSince: 0, endedEarly: false, touched: Date.now() };
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, rawName) {
  const used = new Set([...room.players.values()].map(p => p.av));
  const av = AVATARS.find(a => !used.has(a)) || AVATARS[room.players.size % AVATARS.length];
  const names = new Set([...room.players.values()].map(p => p.name.toLowerCase()));
  let name = rawName, k = 2;
  while (names.has(name.toLowerCase())) name = rawName.slice(0, 13) + ' ' + (k++);
  const p = { id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(16).toString('hex'), name, av,
    score: 0, streak: 0, best: 0, correct: 0, gain: 0, answer: null, log: [],
    connected: false, left: false, res: null, dropTimer: null };
  room.players.set(p.id, p);
  return p;
}
const resetStats = p => { p.score = 0; p.streak = 0; p.best = 0; p.correct = 0; p.gain = 0; p.answer = null; p.log = []; };
const activePlayers = room => [...room.players.values()].filter(p => !p.left);
const connectedCount = room => activePlayers(room).filter(p => p.connected).length;
const ranked = room => [...room.players.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
function reassignHost(room) {
  const list = activePlayers(room);
  const n = list.find(p => p.connected) || list[0];
  room.hostId = n ? n.id : null;
}
function removePlayer(room, p) {
  if (p.dropTimer) clearTimeout(p.dropTimer);
  room.players.delete(p.id);
  if (p.res) { try { p.res.end(); } catch (e) {} p.res = null; }
  if (room.hostId === p.id) reassignHost(room);
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  broadcast(room);
}
function setConnected(room, p, val) {
  if (p.dropTimer) { clearTimeout(p.dropTimer); p.dropTimer = null; }
  p.connected = val;
  if (!val && room.phase === 'lobby') {
    p.dropTimer = setTimeout(() => { if (!p.connected && room.players.has(p.id)) removePlayer(room, p); }, DROP_GRACE_MS);
  }
  broadcast(room);
}

/* ---------- State yang dikirim ke pemain ---------- */
function stateFor(room, p) {
  const inGame = room.phase !== 'lobby';
  const list = inGame ? ranked(room) : [...room.players.values()];
  const s = {
    now: Date.now(), code: room.code, phase: room.phase, quizTitle: room.quiz.title,
    hostId: room.hostId, min: MIN_PLAYERS, max: MAX_PLAYERS, connected: connectedCount(room),
    you: { id: p.id, score: p.score, streak: p.streak, best: p.best, correct: p.correct, rank: inGame ? list.findIndex(x => x.id === p.id) + 1 : 0 },
    players: list.map(x => ({ id: x.id, name: x.name, av: x.av, score: x.score, connected: x.connected && !x.left, answered: room.phase === 'question' ? !!x.answer : false }))
  };
  if (room.phase === 'countdown') s.endsAt = room.phaseEndsAt;
  if (room.phase === 'question' || room.phase === 'reveal') {
    const q = room.qs[room.qi];
    s.q = { index: room.qi, total: room.qs.length, text: q.q, options: q.opts.map(o => o.t), time: q.time,
      endsAt: room.qEndsAt, picked: p.answer ? p.answer.idx : -1, answered: !!p.answer };
    if (room.phase === 'question') {
      const act = activePlayers(room).filter(x => x.connected);
      s.q.answeredCount = act.filter(x => x.answer).length;
      s.q.needed = act.length;
    } else {
      s.reveal = { correct: q.opts.findIndex(o => o.ok), gain: p.gain, nextAt: room.phaseEndsAt, last: room.qi + 1 >= room.qs.length };
    }
  }
  if (room.phase === 'finished') {
    s.final = { total: room.qs.length, endedEarly: room.endedEarly, log: p.log,
      standings: list.map(x => ({ id: x.id, name: x.name, av: x.av, score: x.score, correct: x.correct, best: x.best })) };
  }
  return s;
}
function send(room, p) {
  if (!p.res) return;
  try { p.res.write('event: state\ndata: ' + JSON.stringify(stateFor(room, p)) + '\n\n'); } catch (e) {}
}
function broadcast(room) { room.touched = Date.now(); for (const p of room.players.values()) send(room, p); }

/* ---------- Alur permainan ---------- */
function startGame(room) {
  for (const p of [...room.players.values()]) if (!p.connected || p.left) removePlayer(room, p);
  if (!rooms.has(room.code)) return;
  room.qs = shuffle(room.quiz.questions).map(q => ({
    q: q.q, time: q.time || 20, opts: shuffle(q.options.map((t, i) => ({ t, ok: i === q.answer })))
  }));
  room.qi = 0; room.endedEarly = false; room.lowSince = 0;
  for (const p of room.players.values()) resetStats(p);
  room.phase = 'countdown'; room.phaseEndsAt = Date.now() + COUNTDOWN_MS;
  broadcast(room);
}
function beginQuestion(room) {
  const q = room.qs[room.qi];
  for (const p of room.players.values()) { p.answer = null; p.gain = 0; }
  room.phase = 'question'; room.qEndsAt = Date.now() + q.time * 1000;
  broadcast(room);
}
function allAnswered(room) {
  const act = activePlayers(room).filter(p => p.connected);
  return act.length > 0 && act.every(p => p.answer);
}
function endQuestion(room) {
  if (room.phase !== 'question') return;
  const q = room.qs[room.qi];
  const okIdx = q.opts.findIndex(o => o.ok);
  const total = q.time * 1000;
  for (const p of room.players.values()) {
    const a = p.answer;
    p.gain = 0;
    if (a && a.idx === okIdx) {
      const remain = Math.max(0, Math.min(total, room.qEndsAt - a.at));
      p.streak++; p.best = Math.max(p.best, p.streak); p.correct++;
      p.gain = 500 + Math.round(500 * remain / total) + Math.min(p.streak - 1, 5) * 50;
      p.score += p.gain;
    } else p.streak = 0;
    p.log.push({ q: q.q, ok: p.gain > 0, picked: a ? q.opts[a.idx].t : '(waktu habis)', right: q.opts[okIdx].t, gain: p.gain });
  }
  room.phase = 'reveal'; room.phaseEndsAt = Date.now() + REVEAL_MS;
  broadcast(room);
}
function finish(room, early) {
  room.phase = 'finished'; room.endedEarly = !!early;
  if (room.hostId && !room.players.has(room.hostId)) reassignHost(room);
  broadcast(room);
}
function nextOrFinish(room) {
  if (room.qi + 1 >= room.qs.length) finish(room, false);
  else { room.qi++; beginQuestion(room); }
}
function handleAnswer(room, p, idx) {
  if (room.phase !== 'question' || p.answer || p.left) return false;
  const q = room.qs[room.qi];
  if (!Number.isInteger(idx) || idx < 0 || idx >= q.opts.length) return false;
  const t = Date.now();
  if (t > room.qEndsAt + 300) return false;
  p.answer = { idx, at: Math.min(t, room.qEndsAt) };
  broadcast(room);
  if (allAnswered(room)) endQuestion(room);
  return true;
}

/* Detak server: mengatur waktu setiap fase */
setInterval(() => {
  const t = Date.now();
  for (const room of [...rooms.values()]) {
    const ph = room.phase;
    if (ph === 'countdown') {
      if (connectedCount(room) < MIN_PLAYERS) { room.phase = 'lobby'; broadcast(room); }
      else if (t >= room.phaseEndsAt) beginQuestion(room);
    } else if (ph === 'question' || ph === 'reveal') {
      if (connectedCount(room) < MIN_PLAYERS) {
        if (!room.lowSince) room.lowSince = t;
        else if (t - room.lowSince > LOW_GRACE_MS) { finish(room, true); continue; }
      } else room.lowSince = 0;
      if (ph === 'question') { if (t >= room.qEndsAt || allAnswered(room)) endQuestion(room); }
      else if (t >= room.phaseEndsAt) nextOrFinish(room);
    }
  }
}, 250);
/* Ping agar koneksi SSE tidak diputus proxy + bersihkan ruang kosong */
setInterval(() => {
  const t = Date.now();
  for (const room of [...rooms.values()]) {
    for (const p of room.players.values()) if (p.res) { try { p.res.write(': ping\n\n'); } catch (e) {} }
    if (connectedCount(room) === 0 && t - room.touched > 120000) rooms.delete(room.code);
  }
}, 20000);

/* ---------- HTTP ---------- */
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(pathname, req, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Tidak ditemukan'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}
function auth(b) {
  const room = rooms.get(String(b.code || '').toUpperCase().trim());
  const p = room && room.players.get(String(b.pid || ''));
  return p && p.token === b.token ? { room, p } : null;
}
function handleApi(pathname, b, res) {
  if (pathname === '/api/create') {
    const name = cleanName(b.name);
    if (!name) return json(res, 400, { error: 'Isi namamu dulu.' });
    const quiz = QUIZZES.find(z => z.id === b.quizId);
    if (!quiz) return json(res, 400, { error: 'Kuis tidak ditemukan.' });
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Server sedang penuh, coba lagi nanti.' });
    const room = createRoom(quiz), p = addPlayer(room, name);
    room.hostId = p.id;
    return json(res, 200, { code: room.code, pid: p.id, token: p.token });
  }
  if (pathname === '/api/join') {
    const name = cleanName(b.name);
    if (!name) return json(res, 400, { error: 'Isi namamu dulu.' });
    const room = rooms.get(String(b.code || '').toUpperCase().replace(/\s/g, ''));
    if (!room) return json(res, 404, { error: 'Kode ruang tidak ditemukan.' });
    if (room.phase !== 'lobby') return json(res, 409, { error: 'Permainan di ruang ini sudah dimulai.' });
    if (activePlayers(room).length >= MAX_PLAYERS) return json(res, 409, { error: 'Ruang sudah penuh.' });
    const p = addPlayer(room, name);
    return json(res, 200, { code: room.code, pid: p.id, token: p.token });
  }
  const a = auth(b);
  if (!a) return json(res, 401, { error: 'Sesi tidak valid.' });
  const { room, p } = a;
  switch (pathname) {
    case '/api/start':
      if (room.hostId !== p.id) return json(res, 403, { error: 'Hanya host yang bisa memulai.' });
      if (room.phase !== 'lobby') return json(res, 409, { error: 'Permainan sudah berjalan.' });
      if (connectedCount(room) < MIN_PLAYERS) return json(res, 409, { error: `Butuh minimal ${MIN_PLAYERS} pemain untuk mulai.` });
      startGame(room);
      return json(res, 200, { ok: true });
    case '/api/answer':
      return json(res, 200, { ok: handleAnswer(room, p, b.idx) });
    case '/api/rematch': {
      const host = room.players.get(room.hostId);
      if (room.phase !== 'finished') return json(res, 409, { error: 'Belum selesai.' });
      if (room.hostId !== p.id && host && host.connected && !host.left) return json(res, 403, { error: 'Hanya host yang bisa mengulang.' });
      for (const x of [...room.players.values()]) { if (!x.connected || x.left) removePlayer(room, x); }
      if (!rooms.has(room.code)) return json(res, 200, { ok: true });
      for (const x of room.players.values()) resetStats(x);
      if (!room.players.has(room.hostId)) reassignHost(room);
      room.phase = 'lobby'; room.qs = [];
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    case '/api/leave':
      if (room.phase === 'lobby') removePlayer(room, p);
      else {
        p.left = true; p.connected = false;
        if (p.res) { try { p.res.end(); } catch (e) {} p.res = null; }
        if (room.hostId === p.id) reassignHost(room);
        if (activePlayers(room).length === 0) rooms.delete(room.code); else broadcast(room);
      }
      return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Tidak ditemukan.' });
}
function handleEvents(req, res, q) {
  const room = rooms.get(String(q.get('code') || '').toUpperCase());
  const p = room && room.players.get(String(q.get('pid') || ''));
  if (!p || p.token !== q.get('token') || p.left) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const old = p.res;
  p.res = res;
  if (old) { try { old.end(); } catch (e) {} }
  setConnected(room, p, true);
  res.on('close', () => { if (p.res === res) { p.res = null; if (room.players.has(p.id)) setConnected(room, p, false); } });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/api/events') return handleEvents(req, res, url.searchParams);
    if (req.method === 'GET' && pathname === '/api/quizzes') return json(res, 200, QUIZZES.map(z => ({ id: z.id, title: z.title, count: z.questions.length })));
    if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'POST' && pathname.startsWith('/api/')) return handleApi(pathname, await readBody(req), res);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(pathname, req, res);
    res.writeHead(405); res.end();
  } catch (e) { json(res, 400, { error: 'Permintaan tidak valid.' }); }
});
server.listen(PORT, () => console.log(`KuisKu Online berjalan di http://localhost:${PORT}  (minimal pemain: ${MIN_PLAYERS})`));
