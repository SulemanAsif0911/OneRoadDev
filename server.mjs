/**
 * CyberKhyal — authoritative room + relay server.
 *
 * A single Node process serves three things on one port:
 *   1. the Next.js app            (npm run dev / npm start)
 *   2. /models/*                  raw GLB assets streamed from the repo root (range capable)
 *   3. /ws                        WebSocket room protocol (create/join/ready/deploy/race)
 *
 * Racing model: each client simulates its own car at full rate (crisp local feel) and streams
 * transforms to the server, which validates lap progress, keeps the authoritative race state and
 * fans snapshots out to everyone at 20 Hz. Remote cars are interpolated client-side.
 *
 * Usage:
 *   node server.mjs --dev -H 10.0.0.13 -p 3000
 *   node server.mjs -p 3000            (production, requires `npm run build` first)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import next from 'next';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ CLI ---- */
const argv = process.argv.slice(2);
const getFlag = (names) => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (names.includes(a)) return argv[i + 1];
    const hit = names.find((n) => a.startsWith(n + '='));
    if (hit) return a.slice(hit.length + 1);
  }
  return undefined;
};
const DEV = argv.includes('--dev') || process.env.NODE_ENV === 'development';
const HOST = getFlag(['-H', '--hostname', '--host']) || process.env.HOSTNAME_BIND || '0.0.0.0';
const PORT = Number(getFlag(['-p', '--port']) || process.env.PORT || 3000);

/* ------------------------------------------------------------ WS protocol ---
 * client -> server: hello | join | leave | setCar | ready | deploy | restart | kick | input
 *                   | car (transform) | lap | ping | chat | settings
 * server -> client: welcome | room | error | state | snap | race | chat | kick | pong
 * -------------------------------------------------------------------------- */

const ROOM_TTL_LIVE = 12 * 60 * 60 * 1000; // rooms live at most 12h
const EMPTY_TTL = 60 * 1000;               // empty rooms are reaped after 60s
const PLAYER_TIMEOUT = 15 * 1000;          // drop players we haven't heard from
const SNAP_HZ = 20;
const MAX_PLAYERS = 12;
const COLORS = ['#e8402d', '#2f7fe8', '#f2c33c', '#3fc46b', '#b25cf0', '#ef6bb0', '#22d3ee', '#ff8a3d', '#9ad63c', '#8b93ff', '#f4633a', '#4be0d0'];

const randCode = (rooms) => {
  for (let i = 0; i < 5000; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return String(Math.floor(1000 + Math.random() * 9000));
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** @type {Map<string, any>} */
const rooms = new Map();

/* ------------------------------------------------------- track / lap logic --- */
// The circuit lives in public/arena/circuit.json; the server uses it to validate laps.
let circuit = null;
try {
  circuit = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'arena', 'circuit.json'), 'utf8'));
} catch { circuit = null; }

const TRACK = (() => {
  if (!circuit?.pts?.length) return null;
  const pts = circuit.pts;
  const n = pts.length;
  // cumulative arclength for progress checks
  const seg = new Float32Array(n);
  let len = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg[i] = d; len += d;
  }
  return { pts, n, seg, len };
})();

/** nearest point index on the circuit to (x,z) — coarse then refined */
function nearestIndex(x, z, hint = -1) {
  if (!TRACK) return 0;
  const { pts, n } = TRACK;
  let best = 0, bd = Infinity;
  if (hint >= 0) {
    for (let k = -24; k <= 24; k++) {
      const i = (hint + k + n) % n;
      const d = (pts[i][0] - x) ** 2 + (pts[i][1] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd < 45 * 45) return best;
    bd = Infinity;
  }
  const step = Math.max(1, Math.floor(n / 64));
  for (let i = 0; i < n; i += step) {
    const d = (pts[i][0] - x) ** 2 + (pts[i][1] - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  for (let k = -step; k <= step; k++) {
    const i = (best + k + n) % n;
    const d = (pts[i][0] - x) ** 2 + (pts[i][1] - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/* -------------------------------------------------------------- room logic --- */
const newRoom = (code, hostId) => ({
  code,
  createdAt: Date.now(),
  hostId,
  state: 'lobby',                 // lobby | countdown | racing | finished
  race: { laps: 3, countdownEnd: 0, startedAt: 0, endedAt: 0 },
  players: new Map(),
  results: [],
});

const newPlayer = (room, name, car, color) => {
  const id = uid();
  const used = new Set([...room.players.values()].map((p) => p.color));
  const pick = color && !used.has(color) ? color : COLORS.find((c) => !used.has(c)) || COLORS[0];
  return {
    id, name: String(name || 'Racer').slice(0, 16), car: car || 'huracan', color: pick,
    ready: false, joinedAt: Date.now(), lastSeen: Date.now(), ping: 0,
    seq: 0, transform: null, input: null,
    lap: 0, cp: -1, lapStart: 0, lapTimes: [], best: null, finished: false, finishTime: null, position: 0,
    progress: 0, lastIdx: -1, wrongWay: false, driftScore: 0, topSpeed: 0,
  };
};

const roster = (room) => [...room.players.values()].map((p) => ({
  id: p.id, name: p.name, car: p.car, color: p.color, ready: p.ready, ping: p.ping,
  lap: p.lap, best: p.best, finished: p.finished, finishTime: p.finishTime, position: p.position,
}));

const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (room, obj, exceptId) => { for (const p of room.players.values()) if (p.id !== exceptId) send(p.ws, obj); };

function lobbyState(room) {
  return { t: 'room', code: room.code, state: room.state, hostId: room.hostId, laps: room.race.laps, players: roster(room) };
}

function startRace(room, laps) {
  room.race.laps = Math.max(1, Math.min(20, laps || room.race.laps || 3));
  room.results = [];
  for (const p of room.players.values()) {
    p.lap = 0; p.cp = -1; p.lapTimes = []; p.best = null; p.finished = false; p.finishTime = null;
    p.position = 0; p.progress = 0; p.lastIdx = -1; p.wrongWay = false; p.topSpeed = 0; p.driftScore = 0;
    p.lapStart = 0;
  }
  room.state = 'countdown';
  room.race.startedAt = 0;
  room.race.countdownEnd = Date.now() + 5200;
  room.race.endedAt = 0;
  broadcast(room, { t: 'state', state: 'countdown', countdownEnd: room.race.countdownEnd, laps: room.race.laps });
  broadcast(room, lobbyState(room));
}

function finishRace(room, reason = 'complete') {
  room.state = 'finished';
  room.race.endedAt = Date.now();
  const list = [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, car: p.car, color: p.color, lap: p.lap, best: p.best,
    total: p.finishTime, finished: p.finished, position: p.position, topSpeed: p.topSpeed, drift: p.driftScore,
  }));
  list.sort((a, b) => {
    if (a.finished && b.finished) return (a.total || 1e9) - (b.total || 1e9);
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    return (b.lap || 0) - (a.lap || 0);
  });
  list.forEach((r, i) => { r.position = i + 1; });
  room.results = list;
  broadcast(room, { t: 'race', reason, results: list });
  broadcast(room, lobbyState(room));
}

/* ------------------------------------------------------------------ server --- */
const app = next({ dev: DEV, dir: __dirname, hostname: HOST, port: PORT });
await app.prepare();
const handle = app.getRequestHandler();
const upgradeHandler = typeof app.getUpgradeHandler === 'function' ? app.getUpgradeHandler() : null;

const MIME = {
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.ktx2': 'image/ktx2',
};

function serveModel(req, res) {
  const rel = decodeURIComponent((req.url || '').split('?')[0].replace(/^\/models\/+/, ''));
  const file = path.join(__dirname, rel);
  if (!file.startsWith(__dirname) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'model not found', path: rel }));
  }
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, {
      'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`, 'cache-control': 'public, max-age=86400',
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/models/')) return serveModel(req, res);
  if (url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, dev: DEV, rooms: rooms.size, players: [...rooms.values()].reduce((a, r) => a + r.players.size, 0) }));
  }
  if (url === '/api/track') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ hasCircuit: !!TRACK, lapLen: circuit?.lapLen ?? 0 }));
  }
  return handle(req, res);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (url.startsWith('/ws')) {
    return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
  if (upgradeHandler) return upgradeHandler(req, socket, head);
  socket.destroy();
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.roomCode = null;
  ws.playerId = null;

  const room = () => (ws.roomCode ? rooms.get(ws.roomCode) : null);
  const player = () => { const r = room(); return r ? r.players.get(ws.playerId) : null; };

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const r = room(); const p = player();
    if (p) p.lastSeen = Date.now();

    switch (msg.t) {
      case 'hello': {
        send(ws, { t: 'welcome', server: 'CyberKhyal', track: { lapLen: circuit?.lapLen ?? 0, points: TRACK?.n ?? 0 }, maxPlayers: MAX_PLAYERS });
        break;
      }
      case 'create': {
        const code = randCode(rooms);
        const nr = newRoom(code, null);
        rooms.set(code, nr);
        const np = newPlayer(nr, msg.name, msg.car, msg.color);
        nr.hostId = np.id;
        np.ws = ws; ws.roomCode = code; ws.playerId = np.id;
        nr.players.set(np.id, np);
        send(ws, { t: 'room', ...lobbyState(nr), you: np.id, host: true });
        break;
      }
      case 'join': {
        const code = String(msg.code || '').trim();
        const nr = rooms.get(code);
        if (!nr) return send(ws, { t: 'error', code: 'no-room', msg: 'No room with that code' });
        if (nr.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', code: 'full', msg: 'Room is full' });
        const np = newPlayer(nr, msg.name, msg.car, msg.color);
        np.ws = ws; ws.roomCode = code; ws.playerId = np.id;
        nr.players.set(np.id, np);
        send(ws, { t: 'room', ...lobbyState(nr), you: np.id, host: nr.hostId === np.id });
        broadcast(nr, { t: 'player-joined', player: { id: np.id, name: np.name, car: np.car, color: np.color } }, np.id);
        broadcast(nr, lobbyState(nr));
        break;
      }
      case 'leave': ws.close(); break;
      case 'setCar': {
        if (!r || !p) return;
        if (msg.car) p.car = String(msg.car).slice(0, 40);
        if (msg.name) p.name = String(msg.name).slice(0, 16);
        if (msg.color && ![...r.players.values()].some((o) => o.id !== p.id && o.color === msg.color)) p.color = msg.color;
        broadcast(r, lobbyState(r));
        break;
      }
      case 'ready': {
        if (!r || !p) return;
        p.ready = !!msg.ready;
        broadcast(r, lobbyState(r));
        break;
      }
      case 'laps': {
        if (!r || !p || r.hostId !== p.id) return;
        r.race.laps = Math.max(1, Math.min(20, msg.laps | 0 || 3));
        broadcast(r, lobbyState(r));
        break;
      }
      case 'start': {  // host deploys everyone into the arena
        if (!r || r.hostId !== p?.id) return;
        startRace(r, msg.laps);
        break;
      }
      case 'restart': {
        if (!r || r.hostId !== p?.id) return;
        r.state = 'lobby';
        r.results = [];
        for (const q of r.players.values()) { q.ready = false; q.lap = 0; q.cp = -1; q.lapTimes = []; q.best = null; q.finished = false; q.finishTime = null; q.position = 0; q.progress = 0; }
        broadcast(r, { t: 'state', state: 'lobby' });
        broadcast(r, lobbyState(r));
        break;
      }
      case 'kick': {
        if (!r || r.hostId !== p?.id || msg.id === p.id) return;
        const victim = r.players.get(msg.id);
        if (victim) { send(victim.ws, { t: 'kick', msg: 'Removed by host' }); victim.ws?.close(); }
        break;
      }
      case 'input': {
        if (!p) break;
        p.input = { s: msg.s | 0, th: msg.th | 0, br: msg.br | 0, st: +msg.st || 0, hb: msg.hb ? 1 : 0, bo: msg.bo ? 1 : 0, t: Date.now() };
        break;
      }
      case 'car': {
        if (!r || !p) break;
        p.transform = msg.p ? { p: msg.p, q: msg.q, v: msg.v, sp: msg.sp | 0, gear: msg.gear | 0, rpm: msg.rpm | 0, dr: msg.dr | 0, bo: msg.bo ? 1 : 0, w: msg.w, hb: msg.hb ? 1 : 0, air: msg.air ? 1 : 0 } : p.transform;
        p.topSpeed = Math.max(p.topSpeed, msg.sp | 0);
        p.driftScore += msg.dr | 0;
        // --- lap validation against the circuit ---
        if (r.state === 'racing' && !p.finished && TRACK && msg.p) {
          const [x, , z] = msg.p;
          const idx = nearestIndex(x, z, p.lastIdx);
          const n = TRACK.n;
          const prev = p.lastIdx;
          if (prev >= 0) {
            // forward progress with wraparound
            let d = idx - prev;
            if (d < -n / 2) d += n;
            if (d > n / 2) d -= n;
            p.progress += d;
            // eight sectors around the lap; a lap only counts when the car has collected them
            // all in order and then crossed the line, which is what stops a car from farming
            // laps by reversing over the start line.
            const gateEvery = Math.max(1, Math.floor(n / 8));
            const gate = Math.floor(idx / gateEvery) % 8;
            const prevGate = Math.floor(prev / gateEvery) % 8;
            p.sectors = p.sectors || new Set();
            if (gate !== prevGate) {
              const expected = (p.cp + 1 + 8) % 8;
              if (p.cp < 0 || gate === expected) { p.cp = gate; p.sectors.add(gate); }
            }
            const nearStart = prev > n - gateEvery || prev < gateEvery * 0.5;
            const crossed = nearStart && ((prev > n - gateEvery && idx < gateEvery) || (prev < gateEvery * 0.5 && idx > n - gateEvery * 0.5));
            if (crossed && p.sectors.size >= 6) {
              const now = Date.now();
              const t = p.lapStart ? now - p.lapStart : 0;
              p.sectors = new Set();
              p.cp = -1;
              p.lap = (p.lap || 0) + 1;
              p.lapStart = now;
              if (t > 3000) {
                p.lapTimes.push(t);
                p.best = p.best == null ? t : Math.min(p.best, t);
                broadcast(r, { t: 'lap', id: p.id, name: p.name, lap: p.lap, time: t, best: p.best });
              }
              if (p.lap > r.race.laps) {
                p.finished = true;
                p.finishTime = now - r.race.startedAt;
                broadcast(r, { t: 'event', kind: 'finish', id: p.id, name: p.name, position: [...r.players.values()].filter((q) => q.finished).length, time: p.finishTime });
                if ([...r.players.values()].every((q) => q.finished)) finishRace(r);
              }
            }
          }
          p.lastIdx = idx;
        }
        break;
      }
      case 'ping': send(ws, { t: 'pong', ts: msg.ts, server: Date.now() }); break;
      case 'chat': {
        if (!r || !p) break;
        broadcast(r, { t: 'chat', id: p.id, name: p.name, color: p.color, text: String(msg.text || '').slice(0, 140), ts: Date.now() });
        break;
      }
      default: break;
    }
  });

  ws.on('close', () => {
    const r = room(); if (!r) return;
    const p = r.players.get(ws.playerId);
    if (p) r.players.delete(p.id);
    const rest = [...r.players.values()];
    if (rest.length === 0) {
      r.emptySince = Date.now();
    } else {
      if (r.hostId === ws.playerId) {
        r.hostId = rest[0].id;
        broadcast(r, { t: 'event', kind: 'host', hostId: r.hostId, name: rest[0].name });
      }
      broadcast(r, { t: 'player-left', id: ws.playerId, name: p?.name });
      broadcast(r, lobbyState(r));
      if (r.state === 'racing' && rest.every((q) => q.finished)) finishRace(r);
    }
  });
});

/* --------------------------------------------------------------- main loops --- */
// snapshot fan-out
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.players.size === 0) continue;
    const now = Date.now();
    if (r.state === 'countdown' && now >= r.race.countdownEnd) {
      r.state = 'racing';
      r.race.startedAt = now;
      for (const p of r.players.values()) p.lapStart = now;
      broadcast(r, { t: 'state', state: 'racing', startedAt: now, laps: r.race.laps });
    }
    if (r.state === 'racing' && r.race.endedAt === 0) {
      const timeout = 10 * 60 * 1000;
      if (now - r.race.startedAt > timeout) finishRace(r, 'timeout');
    }
    const cars = [];
    for (const p of r.players.values()) {
      const tr = p.transform;
      cars.push({
        id: p.id, p: tr?.p, q: tr?.q, v: tr?.v, sp: tr?.sp ?? 0, gear: tr?.gear ?? 0, rpm: tr?.rpm ?? 0,
        dr: tr?.dr ? 1 : 0, bo: tr?.bo ? 1 : 0, w: tr?.w, hb: tr?.hb ? 1 : 0, air: tr?.air ? 1 : 0,
        lap: p.lap, cp: p.cp, best: p.best, finished: p.finished, position: p.position, ww: p.wrongWay ? 1 : 0,
      });
    }
    broadcast(r, { t: 'snap', ts: now, state: r.state, cars });
  }
}, 1000 / SNAP_HZ);

// watchdogs
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    for (const p of [...r.players.values()]) {
      if (now - p.lastSeen > PLAYER_TIMEOUT) { try { p.ws?.close(); } catch {} r.players.delete(p.id); }
      if (p.ws && p.ws.readyState === 1) p.ping = p.ping; // updated via 'lat' messages
    }
    if (r.players.size === 0 && (r.emptySince ? now - r.emptySince > EMPTY_TTL : false)) rooms.delete(code);
    else if (now - r.createdAt > ROOM_TTL_LIVE && r.players.size === 0) rooms.delete(code);
  }
}, 5000);

// websocket-level keepalive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 15000);

// periodic standings (position of each car during a race)
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.state !== 'racing') continue;
    const order = [...r.players.values()].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return (a.finishTime || 0) - (b.finishTime || 0);
      return (b.lap * 1e6 + b.progress) - (a.lap * 1e6 + a.progress);
    });
    order.forEach((p, i) => { p.position = i + 1; });
  }
}, 500);

/* ------------------------------------------------------------------ listen --- */
server.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const ips = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
  console.log('');
  console.log(bold(cyan('    ██████╗██╗   ██╗██████╗ ███████╗██████╗ ██╗  ██╗██╗   ██╗██████╗ ██╗     ')));
  console.log(bold(cyan('   ██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██║ ██╔╝╚██╗ ██╔╝██╔══██╗██║     ')));
  console.log(bold(cyan('   ██║      ╚████╔╝ ██████╔╝█████╗  ██████╔╝█████╔╝  ╚████╔╝ ██████╔╝██║     ')));
  console.log(bold(cyan('   ██║       ╚██╔╝  ██╔══██╗██╔══╝  ██╔══██╗██╔═██╗   ╚██╔╝  ██╔══██╗██║     ')));
  console.log(bold(cyan('   ╚██████╗   ██║   ██████╔╝███████╗██║  ██║██║  ██╗   ██║   ██████╔╝███████╗')));
  console.log(bold(cyan('    ╚═════╝   ╚═╝   ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═════╝ ╚══════╝')));
  console.log(`   ${DEV ? 'development' : 'production'} server ready — racing for everyone on your network:`);
  console.log('');
  for (const ip of ips.length ? ips : ['127.0.0.1']) console.log(`        ▸  ${bold('http://' + ip + ':' + PORT)}`);
  console.log(`        ▸  ${bold('http://localhost:' + PORT)}`);
  console.log('');
  console.log(`   circuit: ${circuit?.lapLen ? circuit.lapLen.toFixed(0) + ' m lap, ' + TRACK?.n + ' path points' : 'missing public/arena/circuit.json'}`);
  console.log(`   models : /models/* streamed from the repository root (no duplication)`);
  console.log(`   websocket: /ws  (rooms, 20 Hz snapshots)`);
  console.log('');
});

process.on('SIGINT', () => { console.log('\nshutting down…'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
