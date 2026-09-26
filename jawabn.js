'use strict';
const { tick, submitAnswer } = require('./lib/game');
const { withRoom } = require('./lib/store');

function json(status, obj) { return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) }; }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Metode tidak diizinkan.' });
  let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Permintaan tidak valid.' }); }
  const code = String(b.code || '').toUpperCase(), pid = String(b.pid || ''), token = String(b.token || '');

  const r = await withRoom(code, (room) => {
    const now = Date.now();
    const p = room.players[pid];
    if (!p || p.token !== token) return { cancel: { status: 401, error: 'Sesi tidak valid.' } };
    p.lastSeen = now;
    tick(room, now);
    const ok = submitAnswer(room, pid, b.idx, now);
    if (ok) tick(room, now); // langsung buka jawaban begitu semua sudah menjawab
    return { out: { ok } };
  });
  if (r.notFound) return json(404, { error: 'Ruang tidak ditemukan.' });
  if (r.cancelled) return json(r.cancelled.status, { error: r.cancelled.error });
  if (r.conflict) return json(503, { error: 'Server sedang sibuk, coba lagi.' });
  return json(200, r.out);
};
