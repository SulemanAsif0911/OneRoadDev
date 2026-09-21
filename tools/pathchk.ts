/**
 * Circuit audit: drive the shipped centreline through the *real* arena and check, at every point,
 * that a car-shaped probe set (the biggest car in the game, 5.6 x 2.1 m) is clear of solids and
 * that the surface under it is continuous enough for the suspension.
 *
 *   node --experimental-strip-types tools/pathchk.ts
 */
import * as fs from 'node:fs';
import * as THREE from 'three';
import { Arena } from '../src/game/arena.ts';

const base = 'public/arena/';
const meta = JSON.parse(fs.readFileSync(base + 'meta.json', 'utf8'));
const grid = fs.readFileSync(base + 'grid.bin');
const arena = new Arena(meta, grid.buffer.slice(grid.byteOffset, grid.byteOffset + grid.byteLength));
const circuit = JSON.parse(fs.readFileSync(base + 'circuit.json', 'utf8'));
const pts: [number, number][] = circuit.pts;
const N = pts.length;

const HL = +(process.env.HL || 2.8), HW = +(process.env.HW || 1.05);
const probes: [number, number][] = [];
for (const f of [-1, -0.5, 0, 0.5, 1]) probes.push([f * HL, 0]);
for (const f of [-1, -0.5, 0.5, 1]) { probes.push([f * HL, -HW]); probes.push([f * HL, HW]); }

let bad = 0, worst: string[] = [], hMin = 1e9, hMax = -1e9, hStepMax = 0, hJumps: string[] = [];
const heights: number[] = [];
const n = new THREE.Vector3();
for (let i = 0; i < N; i++) {
  const p = pts[(i - 1 + N) % N], q = pts[(i + 1) % N];
  const tx = q[0] - p[0], tz = q[1] - p[1];
  const L = Math.hypot(tx, tz) || 1;
  const ux = tx / L, uz = tz / L, rx = -uz, rz = ux;
  let hits = 0, maxSolid = 0;
  for (const [f, r] of probes) {
    const x = pts[i][0] + ux * f + rx * r, z = pts[i][1] + uz * f + rz * r;
    const s = arena.solidAt(x, z);
    if (s > 0.55) hits++;
    maxSolid = Math.max(maxSolid, s);
  }
  const h = arena.heightAt(pts[i][0], pts[i][1]);
  heights.push(h);
  hMin = Math.min(hMin, h); hMax = Math.max(hMax, h);
  const hPrev = heights[i - 1];
  if (i > 0) { const d = Math.abs(h - hPrev); if (d > hStepMax) { hStepMax = d; hJumps = [`i=${i} ${hPrev.toFixed(2)}->${h.toFixed(2)}`]; } }
  if (hits > 0) { bad++; if (worst.length < 12) worst.push(`i=${i} (${pts[i][0].toFixed(0)},${pts[i][1].toFixed(0)}) hits=${hits}/${probes.length} solid=${maxSolid.toFixed(2)} h=${h.toFixed(2)}`); }
  // ride height check: the four wheel contact points should not be more than a kerb apart
  let lo = 1e9, hi = -1e9;
  for (const [f, r] of [[-HL * 0.55, -HW], [-HL * 0.55, HW], [HL * 0.55, -HW], [HL * 0.55, HW]] as [number, number][]) {
    const x = pts[i][0] + ux * f + rx * r, z = pts[i][1] + uz * f + rz * r;
    const hh = arena.heightAt(x, z); lo = Math.min(lo, hh); hi = Math.max(hi, hh);
  }
  if (hi - lo > 0.45) worst.push(`i=${i} axle twist ${(hi - lo).toFixed(2)} m`);
}
console.log(`circuit ${circuit.lapLen.toFixed(0)} m, ${N} pts`);
console.log(`body probes: ${N - bad}/${N} points fully clear, min body clearance reported ${circuit.minBodyClr ?? '?'}`);
console.log(`heights: ${hMin.toFixed(2)} .. ${hMax.toFixed(2)} m, max step between points ${hStepMax.toFixed(2)} m ${hJumps.join(' ')}`);
if (worst.length) console.log('issues:\n  ' + worst.join('\n  '));
else console.log('no issues: a 5.6 x 2.1 m car fits the whole centreline');
// direction of travel: is the loop consistent with the start heading?
const a0 = pts[0], b0 = pts[1];
console.log(`start (${a0[0].toFixed(1)},${a0[1].toFixed(1)}) -> (${b0[0].toFixed(1)},${b0[1].toFixed(1)}) heading ${(Math.atan2(-(b0[0] - a0[0]), -(b0[1] - a0[1])) * 57.3).toFixed(0)} deg (yaw for a -Z facing car)`);
arena.normalAt(a0[0], a0[1], n);
console.log(`start normal ${n.toArray().map((v) => v.toFixed(2)).join(',')}`);
