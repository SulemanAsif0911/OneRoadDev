/**
 * End-to-end room protocol test — no browser needed.
 *
 *   node tools/net-test.mjs [url]
 *
 * Connects two clients to a running CyberKhyal server, creates a room, joins with the code,
 * deploys, then drives a synthetic lap around the real circuit and checks that the server counts
 * sectors and laps, streams snapshots and relays chat. Exits non-zero if anything fails.
 */
import fs from 'node:fs';
import WebSocket from 'ws';

const URL = process.argv[2] || 'ws://localhost:3000/ws';
const circuit = JSON.parse(fs.readFileSync('public/arena/circuit.json', 'utf8'));
const P = circuit.pts;
const N = P.length;

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

function client(name) {
  const ws = new WebSocket(URL);
  ws.inbox = [];
  ws.on('message', (raw) => {
    try { ws.inbox.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  ws.name = name;
  ws.waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const i = ws.inbox.findIndex((m) => { try { return pred(m); } catch { return false; } });
      if (i >= 0) return resolve(ws.inbox.splice(i, 1)[0]);
      if (Date.now() - started > ms) return reject(new Error(`${name}: timed out waiting for a message (saw ${ws.inbox.map((m) => m.t).join(', ') || 'nothing'})`));
      setTimeout(tick, 20);
    };
    tick();
  });
  ws.wait = (type, ms = 3000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const i = ws.inbox.findIndex((m) => m.t === type);
      if (i >= 0) return resolve(ws.inbox.splice(i, 1)[0]);
      if (Date.now() - started > ms) return reject(new Error(`${name}: timed out waiting for "${type}" (saw ${ws.inbox.map((m) => m.t).join(', ') || 'nothing'})`));
      setTimeout(tick, 20);
    };
    tick();
  });
  ws.open = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return ws;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`CyberKhyal room protocol test → ${URL}\n`);
  const host = client('host');
  const guest = client('guest');
  await Promise.all([host.open, guest.open]);

  host.send(JSON.stringify({ t: 'hello' }));
  const welcome = await host.wait('welcome');
  ok(welcome.server === 'CyberKhyal', 'welcome handshake', `${welcome.maxPlayers} max players, lap ${Math.round(welcome.track.lapLen)} m`);

  host.send(JSON.stringify({ t: 'create', name: 'Host', car: '2017_lamborghini_huracan_mansory' }));
  const room = await host.wait('room');
  const code = room.code;
  ok(/^\d{4}$/.test(code), 'host created a room with a 4-digit code', code);
  ok(room.host === true && room.players.length === 1, 'host is flagged as host');

  guest.send(JSON.stringify({ t: 'hello' }));
  await guest.wait('welcome');
  guest.send(JSON.stringify({ t: 'join', code, name: 'Guest', car: '2001_bmw_m3_gtr' }));
  const guestRoom = await guest.wait('room');
  ok(guestRoom.code === code && guestRoom.host === false, 'guest joined with the code and is not host');
  const joined = await host.wait('player-joined', 2000).catch(() => null);
  ok(!!joined, 'host was told a player joined', joined?.player?.name);

  guest.send(JSON.stringify({ t: 'ready', ready: true }));
  const readyRoom = await host.waitFor((m) => m.t === 'room' && m.players.some((p) => p.ready), 2500).catch(() => null);
  ok(!!readyRoom, 'ready state is broadcast to the room');

  // a bad code must be refused
  const stray = client('stray');
  await stray.open;
  stray.send(JSON.stringify({ t: 'hello' }));
  await stray.wait('welcome');
  stray.send(JSON.stringify({ t: 'join', code: '0000', name: 'Nobody' }));
  const err = await stray.wait('error');
  ok(err.code === 'no-room', 'joining a code that does not exist is refused', err.msg);
  stray.close();

  // ---- deploy
  host.send(JSON.stringify({ t: 'laps', laps: 2 }));
  await host.wait('room');
  host.send(JSON.stringify({ t: 'start', laps: 2 }));
  const cd = await guest.wait('state');
  ok(cd.state === 'countdown' && cd.laps === 2, 'deploy starts a countdown for everyone', `ends in ${Math.round((cd.countdownEnd - Date.now()) / 100) / 10}s`);

  const racing = await guest.wait('state', 7000);
  ok(racing.state === 'racing' && !!racing.startedAt, 'countdown resolved into a race');

  // ---- drive two synthetic laps along the real centreline
  let lapEvents = 0;
  let snaps = 0;
  host.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'lap' && m.id) lapEvents++;
    if (m.t === 'snap') snaps++;
  });
  const start = Date.now();
  const STEP = 5;                    // path points per message
  const SEND_MS = 130;               // ~3.5 s per lap so the server's >3 s lap guard passes
  const totalSends = Math.ceil((N * 2.4) / STEP);
  for (let k = 0; k < totalSends; k++) {
    const i = (k * STEP) % N;
    const [x, z] = P[i];
    host.send(JSON.stringify({
      t: 'car', p: [x, 0.6, z], q: [0, 0, 0, 1], v: [0, 0, 0], sp: 120, gear: 4, rpm: 6000,
      dr: 0, bo: 0, w: [0, 0, 0, 0], hb: 0, air: 0,
    }));
    await sleep(SEND_MS);
  }
  await sleep(400);
  ok(snaps > 5, 'server streams snapshots during the race', `${snaps} snapshots`);
  ok(lapEvents >= 2, 'server validated and broadcast laps', `${lapEvents} lap messages in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  // ---- chat relay
  host.send(JSON.stringify({ t: 'chat', text: 'good luck' }));
  const chat = await guest.wait('chat', 1500).catch(() => null);
  ok(chat?.text === 'good luck', 'chat relays to the other player');

  // ---- rematch
  host.send(JSON.stringify({ t: 'restart' }));
  const lobby = await guest.wait('state');
  ok(lobby.state === 'lobby', 'host can send everyone back to the lobby');

  // ---- disconnect cleans up
  guest.close();
  const after = await host.waitFor((m) => m.t === 'room' && m.players.length === 1, 3000).catch(() => null);
  ok(!!after, 'leaving removes the player from the room');

  host.close();
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
