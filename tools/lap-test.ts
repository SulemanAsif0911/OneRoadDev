/**
 * Real-arena lap driver: drives the shipped circuit.json with the shipped physics and reports
 * whether the lap is (a) possible and (b) how long it takes. This is the integration test for
 * the whole driving stack -- physics + arena + circuit + assists.
 *
 *   CAR=2017_lamborghini_huracan_mansory node --experimental-strip-types tools/lap-test.ts
 *   env: CAR, LAPS, ASSIST (arcade|sport|pro|sim), CAP (km/h), VERBOSE=1, DRIFT=1
 */
import * as fs from 'node:fs';
import * as THREE from 'three';
import { Arena } from '../src/game/arena.ts';
import { CarSim, specFromCarJson, ASSIST_PRESETS } from '../src/game/physics.ts';

const base = 'public/arena/';
const meta = JSON.parse(fs.readFileSync(base + 'meta.json', 'utf8'));
const gridFn = fs.readFileSync(base + 'grid.bin');
const arena = new Arena(meta, gridFn.buffer.slice(gridFn.byteOffset, gridFn.byteOffset + gridFn.byteLength));
const circuit = JSON.parse(fs.readFileSync(base + 'circuit.json', 'utf8'));
const pts: [number, number][] = circuit.pts;
const N = pts.length;
const carJson = JSON.parse(fs.readFileSync('public/cars/cars.json', 'utf8'));
const list = Array.isArray(carJson) ? carJson : carJson.cars;
const carId = process.env.CAR || '2017_lamborghini_huracan_mansory';
const spec = specFromCarJson(list.find((c: any) => c.id === carId));
const assistName = (process.env.ASSIST || 'sport') as keyof typeof ASSIST_PRESETS;
const assist = { ...ASSIST_PRESETS[assistName], auto: true };
const LAPS = +(process.env.LAPS || 3);
const CAP = (+(process.env.CAP || 200)) / 3.6;
const VERBOSE = process.env.VERBOSE === '1';

// ---------------------------------------------------------------- path tables
const seg = (i: number) => { const a = pts[i], b = pts[(i + 1) % N]; return Math.hypot(b[0] - a[0], b[1] - a[1]); };
const s: number[] = []; let total = 0;
for (let i = 0; i < N; i++) { s.push(total); total += seg(i); }
const atArc = (arc: number): [number, number, number, number] => {   // x, z, tangent x, tangent z
  arc = ((arc % total) + total) % total;
  let i = 0; while (i < N - 1 && s[i + 1] <= arc) i++;
  const a = pts[i], b = pts[(i + 1) % N];
  const t = (arc - s[i]) / (seg(i) || 1);
  const dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1;
  return [a[0] + dx * t, a[1] + dz * t, dx / L, dz / L];
};
// curvature over a ~6 m window (circumradius of three points)
const curv: number[] = [];
for (let i = 0; i < N; i++) {
  const p0 = pts[(i - 2 + N) % N], p1 = pts[i], p2 = pts[(i + 2) % N];
  const ax = p1[0] - p0[0], az = p1[1] - p0[1], bx = p2[0] - p1[0], bz = p2[1] - p1[1];
  const cross = ax * bz - az * bx, la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
  curv.push(2 * cross / (la * lb * lc || 1e-6));
}
// speed profile: what the tyres could hold, then braking and traction limits between corners
const LAT = 9.6, ACC = 8.4, BRK = 13.5;
const vProf = new Float64Array(N);
for (let i = 0; i < N; i++) vProf[i] = Math.min(CAP, Math.sqrt(LAT / Math.max(Math.abs(curv[i]), 1e-4)));
for (let k = 0; k < 40; k++) {
  for (let i = N - 1; i >= 0; i--) { const j = (i + 1) % N; vProf[i] = Math.min(vProf[i], Math.sqrt(vProf[j] * vProf[j] + 2 * BRK * seg(i))); }
  for (let i = 0; i < N; i++) { const j = (i - 1 + N) % N; vProf[i] = Math.min(vProf[i], Math.sqrt(vProf[j] * vProf[j] + 2 * ACC * seg(j))); }
}
const arcIndexOf = (arc: number) => { let i = 0; while (i < N - 1 && s[i + 1] <= arc) i++; return i; };

// ---------------------------------------------------------------- start on the straightest bit
let startI = 0, bestC = 1e9;
for (let i = 0; i < N; i++) { let c = 0; for (let k = -3; k <= 3; k++) c += Math.abs(curv[(i + k + N) % N]); if (c < bestC) { bestC = c; startI = i; } }
const car = new CarSim(spec, assist, { x: pts[startI][0], z: pts[startI][1], yaw: 0 });
{
  const d = atArc(s[startI] + 2);
  const yaw = Math.atan2(-d[2], -d[3]);
  car.reset({ x: pts[startI][0], z: pts[startI][1], yaw });
  car.settle(arena);
}

const dt = 1 / 120;
let arc = s[startI], prevArc = arc, laps = 0, lapTime = 0;
let maxLatG = 0, airTime = 0, wallFrames = 0, collisions = 0, maxOff = 0, offFrames = 0, maxSpeed = 0, offTrack = 0;
let lastImpact = 0, frames = 0, sumLatG = 0, resets = 0, minSpeedInLap = 1e9;
const carPos = new THREE.Vector3();
const lapTimes: number[] = [];
const STUCK_RESET = process.env.NORESET ? Infinity : 4.0;
let stuck = 0;
const MAXT = +(process.env.MAXT || 400);

for (let step = 0; step < MAXT / dt; step++) {
  // ---- locate the car on the centreline (local search, then a fine projection)
  let bestI = arcIndexOf(arc), bestD = 1e9, bestArc = arc;
  for (let k = -4; k <= 24; k++) {
    const j = (bestI + k + N * 2) % N;
    const a = pts[j], b = pts[(j + 1) % N];
    const dx = b[0] - a[0], dz = b[1] - a[1]; const L2 = dx * dx + dz * dz || 1;
    let t = ((car.pos.x - a[0]) * dx + (car.pos.z - a[1]) * dz) / L2;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + dx * t, pz = a[1] + dz * t;
    const d = Math.hypot(car.pos.x - px, car.pos.z - pz);
    if (d < bestD) { bestD = d; bestArc = s[j] + Math.sqrt(L2) * t; }
  }
  // unwrap the arc so progress is monotonic across the start line
  while (bestArc - arc > total / 2) bestArc -= total;
  while (arc - bestArc > total / 2) bestArc += total;
  arc = bestArc;
  const off = bestD;
  maxOff = Math.max(maxOff, off);
  if (off > 6) offFrames++;
  if (off > 6) offTrack += dt;

  // ---- pure pursuit: aim at a point on the centreline a speed-dependent distance ahead
  const v = car.vel.length();
  maxSpeed = Math.max(maxSpeed, v);
  const look = THREE.MathUtils.clamp(4.5 + 0.62 * v, 6, 24);
  const tgt = atArc(arc + look);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(car.quat);
  const rx = -fwd.z, rz = fwd.x;                       // the car's right in world x/z
  const toX = tgt[0] - car.pos.x, toZ = tgt[1] - car.pos.z;
  const dist = Math.max(0.5, Math.hypot(toX, toZ));
  const dx = toX / dist, dz = toZ / dist;
  const aimErr = Math.atan2(dx * rx + dz * rz, dx * fwd.x + dz * fwd.z);   // + = target to the right
  // cross track: how far the car sits to the right of the line (correct it a little)
  const p0 = atArc(arc);
  const crossErr = (car.pos.x - p0[0]) * rx + (car.pos.z - p0[1]) * rz;
  const steer = THREE.MathUtils.clamp(1.35 * aimErr - 0.07 * crossErr - 0.075 * car.angVel.y * Math.min(1, v / 12), -1, 1);
  // ---- speed target from the profile, sampled a braking distance ahead
  let vTarget = CAP;
  for (let d = 0; d <= 60; d += 3) {
    const i = arcIndexOf(arc + d);
    const allowed = Math.sqrt(vProf[i] * vProf[i] + 2 * BRK * d);
    vTarget = Math.min(vTarget, allowed);
  }
  vTarget = Math.min(vTarget, vProf[arcIndexOf(arc + 1.5)]);
  const throttle = v < vTarget ? THREE.MathUtils.clamp(0.35 + (vTarget - v) * 0.22, 0, 1) : 0;
  const brake = v > vTarget * 1.02 ? THREE.MathUtils.clamp((v - vTarget) * 0.25, 0, 1) : 0;
  const handbrake = !!process.env.DRIFT && Math.abs(aimErr) > 0.5 && v > 14;

  car.step(dt, { throttle, brake, steer, handbrake, boost: false }, arena);
  frames++;
  lapTime += dt;
  maxLatG = Math.max(maxLatG, Math.abs(car.gLat)); sumLatG += Math.abs(car.gLat);
  if (!car.onGround) airTime += dt;
  if (car.wallContact > 0.5) wallFrames++;
  if (car.impactSpeed > lastImpact + 1.5) { collisions++; lastImpact = car.impactSpeed; }
  if (step > 240) minSpeedInLap = Math.min(minSpeedInLap, v);

  // ---- stuck recovery (the game has a reset key; this is the same idea, counted)
  if (v < 1.0 && car.onGround) stuck += dt; else stuck = 0;
  if (stuck > STUCK_RESET) {
    resets++;
    const d0 = atArc(arc + 6);
    car.reset({ x: pts[arcIndexOf(arc)][0], z: pts[arcIndexOf(arc)][1], yaw: Math.atan2(-d0[2], -d0[3]) });
    car.settle(arena);
    stuck = 0;
  }

  if (VERBOSE && step % 120 === 0) {
    console.log(`  t=${(step * dt).toFixed(0)}s v=${(v * 3.6).toFixed(0)}/${(vTarget * 3.6).toFixed(0)}km/h off=${off.toFixed(2)}m aim=${(aimErr * 57.3).toFixed(0)}deg steer=${(steer).toFixed(2)} h=${car.pos.y.toFixed(2)} hits=${collisions}`);
  }

  // ---- lap detection on arc progress
  const progress = arc - prevArc;
  if (progress > total / 2) { /* wrapped */ }
  if (arc - prevArc > 0) { /* forward */ }
  if (arc - prevArc < -total / 2) {
    laps++;
    lapTimes.push(lapTime);
    console.log(`LAP ${laps}: ${lapTime.toFixed(2)} s  (${(total / lapTime * 3.6).toFixed(1)} km/h avg, ${(1000 / lapTime).toFixed(0)} ms/100m)`);
    lapTime = 0;
    if (laps >= LAPS) break;
  }
  prevArc = arc;
}

const avgLat = sumLatG / Math.max(1, frames);
console.log(`RESULT ${carId} [${assistName}] ${total.toFixed(0)}m laps=${laps}/${LAPS} best=${lapTimes.length ? Math.min(...lapTimes).toFixed(2) : '-'}s top=${(maxSpeed * 3.6).toFixed(0)}km/h avgLatG=${avgLat.toFixed(2)} peak=${maxLatG.toFixed(2)} air=${airTime.toFixed(2)}s wallFrames=${wallFrames} collisions=${collisions} offTrack=${offTrack.toFixed(1)}s maxOff=${maxOff.toFixed(1)}m resets=${resets} minSpeed=${(minSpeedInLap * 3.6).toFixed(0)}km/h`);
