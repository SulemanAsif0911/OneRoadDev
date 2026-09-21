/**
 * Circuit extractor for CyberKhyal: works on public/arena/grid.bin.
 * Finds the longest genuine cycle inside the widest connected drivable network,
 * simplifies with Douglas-Peucker + Catmull-Rom, and writes public/arena/circuit.json
 */
import fs from 'fs';
import { png, newImage, text, line, rect, blit } from '/home/user/tools/pngutil.mjs';

const dir = 'public/arena';
const meta = JSON.parse(fs.readFileSync(`${dir}/meta.json`, 'utf8'));
const buf = fs.readFileSync(`${dir}/grid.bin`);
const { nx, nz, res, x0, z0, x1, z1, quant } = meta;
const H = new Float32Array(nx * nz), B = new Uint8Array(nx * nz), F = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) { H[k] = buf.readInt16LE(k * 4) * quant; B[k] = buf.readUInt8(k * 4 + 2); F[k] = buf.readUInt8(k * 4 + 3); }

const CLHARD = +(process.env.CLHARD || 5.0);
const CARHALF = +(process.env.CARHALF || 1.35);
const KEEP_PAINT = process.env.KEEP_PAINT !== '0';
const PROPW = +(process.env.PROPW || 4.0);
const props = JSON.parse(fs.readFileSync(`${dir}/props.json`, 'utf8'));
const PROP_PAD = +(process.env.PROP_PAD || 1.6);   // keep the line this far from fence posts / lamps
const drv = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) {
  if (H[k] < -900) continue;
  if (B[k]) continue;
  if (F[k] & 2) continue;                      // too steep
  drv[k] = 1;
}
// props (fences, lamps, planters) are smashable in game; the racing line merely prefers gaps
const propPen = new Float32Array(nx * nz);
for (const [px_, pz, r, h] of props) {
  const rr = Math.max(1.2, r + PROP_PAD);
  const gx = Math.round((px_ - meta.x0) / res), gz = Math.round((pz - meta.z0) / res);
  const R = Math.ceil(rr / res);
  for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const a = gx + dx, b = gz + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
    const d = Math.hypot(dx, dz) * res; if (d > rr) continue;
    const v = 1 - d / rr; const k = b * nx + a;
    if (v > propPen[k]) propPen[k] = v;
  }
}
console.log('prop-aware routing: soft penalty around', props.length, 'props');
console.log('drivable cells:', drv.reduce((a, b) => a + b, 0), `(${(drv.reduce((a, b) => a + b, 0) * res * res).toFixed(0)} m2)`);
// clearance (meters) via chamfer
const INF = 1e9; const clr = new Float32Array(nx * nz);
for (let k = 0; k < nx * nz; k++) clr[k] = drv[k] ? INF : 0;
const d1 = 1, d2 = Math.SQRT2;
for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { const k = z * nx + x; if (clr[k] === 0) continue; let v = clr[k];
  if (x > 0) v = Math.min(v, clr[k - 1] + d1); if (z > 0) v = Math.min(v, clr[k - nx] + d1);
  if (x > 0 && z > 0) v = Math.min(v, clr[k - nx - 1] + d2); if (x < nx - 1 && z > 0) v = Math.min(v, clr[k - nx + 1] + d2); clr[k] = v; }
for (let z = nz - 1; z >= 0; z--) for (let x = nx - 1; x >= 0; x--) { const k = z * nx + x; if (clr[k] === 0) continue; let v = clr[k];
  if (x < nx - 1) v = Math.min(v, clr[k + 1] + d1); if (z < nz - 1) v = Math.min(v, clr[k + nx] + d1);
  if (x < nx - 1 && z < nz - 1) v = Math.min(v, clr[k + nx + 1] + d2); if (x > 0 && z < nz - 1) v = Math.min(v, clr[k + nx - 1] + d2); clr[k] = v; }
for (let k = 0; k < nx * nz; k++) clr[k] *= res;
const pass = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) if (drv[k] && clr[k] >= CLHARD) pass[k] = 1;
console.log(`passable at >=${CLHARD}m:`, pass.reduce((a, b) => a + b, 0), `(${(pass.reduce((a, b) => a + b, 0) * res * res).toFixed(0)} m2)`);
// components
const comp = new Int32Array(nx * nz).fill(-1); const sizes = [];
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
for (let k = 0; k < nx * nz; k++) { if (!pass[k] || comp[k] >= 0) continue; const id = sizes.length; const st = [k]; comp[k] = id; let s = 0;
  while (st.length) { const c = st.pop(); s++; const x = c % nx, z = (c - x) / nx;
    for (const [dx, dz] of NB) { const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nc = b * nx + a; if (pass[nc] && comp[nc] < 0) { comp[nc] = id; st.push(nc); } } }
  sizes.push({ id, s }); }
sizes.sort((a, b) => b.s - a.s);
console.log('components:', sizes.slice(0, 4).map(o => `#${o.id}:${(o.s * res * res).toFixed(0)}m2`).join(' '));
const MAIN = sizes[0].id; const inMain = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) if (comp[k] === MAIN) inMain[k] = 1;

function makeHeap(cap) { return { keys: new Float64Array(cap), idx: new Int32Array(cap), n: 0, cap }; }
function hpush(h, k, i) { if (h.n >= h.cap) { const nk = new Float64Array(h.cap * 2), ni = new Int32Array(h.cap * 2); nk.set(h.keys); ni.set(h.idx); h.keys = nk; h.idx = ni; h.cap *= 2; }
  let c = h.n++; h.keys[c] = k; h.idx[c] = i; while (c > 0) { const p = (c - 1) >> 1; if (h.keys[p] <= h.keys[c]) break; const tk = h.keys[p], ti = h.idx[p]; h.keys[p] = h.keys[c]; h.idx[p] = h.idx[c]; h.keys[c] = tk; h.idx[c] = ti; c = p; } }
function hpop(h) { const k = h.keys[0], i = h.idx[0]; h.n--; if (h.n > 0) { h.keys[0] = h.keys[h.n]; h.idx[0] = h.idx[h.n]; let p = 0; for (;;) { const l = 2 * p + 1, r = l + 1; let m = p; if (l < h.n && h.keys[l] < h.keys[m]) m = l; if (r < h.n && h.keys[r] < h.keys[m]) m = r; if (m === p) break; const tk = h.keys[p], ti = h.idx[p]; h.keys[p] = h.keys[m]; h.idx[p] = h.idx[m]; h.keys[m] = tk; h.idx[m] = ti; p = m; } } return [k, i]; }
const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
function dij(start, pen, distTo, blockD) {
  const D = new Float32Array(nx * nz).fill(INF), P = new Int32Array(nx * nz).fill(-1), done = new Uint8Array(nx * nz);
  const h = makeHeap(1 << 16); D[start] = 0; hpush(h, 0, start);
  while (h.n > 0) { const [dd, ci] = hpop(h); if (done[ci]) continue; done[ci] = 1;
    const x = ci % nx, z = (ci - x) / nx;
    for (const [dx, dz] of NB8) { const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nc = b * nx + a;
      if (!inMain[nc] || done[nc]) continue;
      if (distTo && distTo[nc] <= blockD) continue;
      const ln = (dx && dz ? 1.41421356 : 1) * res;
      let w = ln * (1 + pen / Math.max(0.6, clr[nc] - CARHALF));
      w *= 1 + PROPW * propPen[nc];
      const nd = dd + w; if (nd < D[nc]) { D[nc] = nd; P[nc] = ci; hpush(h, nd, nc); } } }
  return { D, P };
}
const W2M = k => { const x = k % nx, z = (k - x) / nx; return [(x + 0.5) * res + x0, (z + 0.5) * res + z0]; };
const fmt = k => { const [a, b] = W2M(k); return `(${a.toFixed(0)},${b.toFixed(0)})`; };
const cells = [...Array(nx * nz).keys()].filter(k => inMain[k]).sort((a, b) => clr[b] - clr[a]);
const seeds = [];
for (const k of cells) { if (seeds.length >= +(process.env.SEEDS || 6)) break; const x = k % nx, z = (k - x) / nx;
  if (seeds.every(s => Math.hypot((s % nx) - x, ((s - (s % nx)) / nx) - z) * res > 70)) seeds.push(k); }
console.log('seeds:', seeds.map(fmt).join(' '));
let best = null;
for (const sk of seeds) {
  const { D: dA } = dij(sk, 1.0);
  let A = sk, bd = -1; for (let k = 0; k < nx * nz; k++) if (inMain[k] && dA[k] < INF && dA[k] > bd) { bd = dA[k]; A = k; }
  const { D: dB, P: pB } = dij(A, 1.0);
  let Bi = A, bd2 = -1; for (let k = 0; k < nx * nz; k++) if (inMain[k] && dB[k] < INF && dB[k] > bd2) { bd2 = dB[k]; Bi = k; }
  const ab = []; { let c = Bi; while (c >= 0) { ab.push(c); c = pB[c]; } ab.reverse(); }
  // BFS distance from ab corridor (geodesic inside main)
  const distTo = new Float32Array(nx * nz).fill(INF); const doneAB = new Uint8Array(nx * nz); const h = makeHeap(1 << 16);
  for (const c of ab) { distTo[c] = 0; hpush(h, 0, c); }
  while (h.n > 0) { const [dd, ci] = hpop(h); if (doneAB[ci]) continue; doneAB[ci] = 1; const x = ci % nx, z = (ci - x) / nx;
    for (const [dx, dz] of NB8) { const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nc = b * nx + a;
      const nd = dd + (dx && dz ? 1.41421356 : 1) * res; if (inMain[nc] && nd < distTo[nc]) { distTo[nc] = nd; hpush(h, nd, nc); } } }
  let blockD = +(process.env.BLOCKM || 10), back = null;
  for (let tries = 0; tries < 10; tries++) {
    const { D: dL, P: pL } = dij(Bi, 2.0, distTo, blockD);
    if (dL[A] < INF * 0.5) { back = []; let c = A, g = 0; while (c >= 0 && g++ < nx * nz) { back.push(c); c = pL[c]; } back.reverse(); break; }
    blockD = Math.max(1.5, blockD * 0.65);
  }
  if (!back) { console.log('seed', fmt(sk), 'no cycle'); continue; }
  const coords = ab.concat(back.slice(1)).map(W2M);
  const rl = a => { let L = 0; for (let i = 1; i < a.length; i++) L += Math.hypot(a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]); return L; };
  const tol = +(process.env.DPTOL || 9);
  function dp(pts, tol) { if (pts.length < 3) return pts.slice(); const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
    while (st.length) { const [i0, i1] = st.pop(); const a = pts[i0], b = pts[i1]; const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy;
      let mi = -1, md = -1; for (let i = i0 + 1; i < i1; i++) { const p = pts[i]; let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)); if (d > md) { md = d; mi = i; } }
      if (md > tol) { keep[mi] = 1; st.push([i0, mi]); st.push([mi, i1]); } }
    return pts.filter((_, i) => keep[i]); }
  const simp = dp(coords, tol);
  const CR = (p0, p1, p2, p3, t) => { const t2 = t * t, t3 = t2 * t; return [0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]; };
  const n = simp.length; const out = [];
  for (let i = 0; i < n; i++) { const p0 = simp[(i - 1 + n) % n], p1 = simp[i], p2 = simp[(i + 1) % n], p3 = simp[(i + 2) % n];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]); const steps = Math.max(1, Math.round(segLen / 4));
    for (let s = 0; s < steps; s++) out.push(CR(p0, p1, p2, p3, s / steps)); }
  const len = rl(out.concat([out[0]]));
  let minC = 1e9, sumC = 0, bad = 0;
  for (const p of out) { const gx = Math.round((p[0] - x0) / res), gz = Math.round((p[1] - z0) / res);
    const k = Math.max(0, Math.min(nx * nz - 1, gz * nx + gx)); minC = Math.min(minC, clr[k]); sumC += clr[k]; if (clr[k] < CARHALF) bad++; }
  const avg = sumC / out.length;
  const score = len * Math.min(avg, 16) * (minC > CARHALF ? 1 : 0.15);
  console.log(`seed${fmt(sk)} AB=${rl(ab.map(W2M)).toFixed(0)} BA=${rl(back.map(W2M)).toFixed(0)} block=${blockD.toFixed(0)} raw=${rl(coords).toFixed(0)} lap=${len.toFixed(0)}m avgClr=${avg.toFixed(1)} minClr=${minC.toFixed(1)} bad=${bad} pts=${out.length} score=${score.toFixed(0)}`);
  if (!best || score > best.score) best = { score, len, pts: out, minC, avg, seed: sk, bad };
}
if (!best) { console.log('NO LOOP'); process.exit(1); }
console.log(`BEST lap=${best.len.toFixed(0)}m avgClr=${best.avg.toFixed(1)} minClr=${best.minC.toFixed(1)} bad=${best.bad} pts=${best.pts.length}`);
fs.writeFileSync(`${dir}/circuit.json`, JSON.stringify({ lapLen: +best.len.toFixed(1), minClr: +best.minC.toFixed(2), avgClr: +best.avg.toFixed(2), pts: best.pts.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]) }));
// render check
const SC = 3.2; const W = Math.round(nx * res * SC), Hh = Math.round(nz * res * SC);
const img = newImage(W, Hh, [8, 10, 16]);
for (let py = 0; py < Hh; py++) for (let px = 0; px < W; px++) { const gx = Math.floor(px / SC), gz = Math.floor(py / SC); if (gx < 0 || gz < 0 || gx >= nx || gz >= nz) continue;
  const k = gz * nx + gx, i = (py * W + px) * 4;
  if (H[k] < -900) { img.px[i] = 8; img.px[i + 1] = 10; img.px[i + 2] = 18; continue; }
  if (B[k]) { img.px[i] = 96; img.px[i + 1] = 44; img.px[i + 2] = 54; continue; }
  if (F[k] & 2) { const t = Math.min(1, Math.abs(H[k]) / 30); img.px[i] = 50 + t * 70; img.px[i + 1] = 60; img.px[i + 2] = 78; continue; }
  const t = Math.min(1, clr[k] / 14); img.px[i] = 18 + t * 60; img.px[i + 1] = 60 + t * 120; img.px[i + 2] = 40 + t * 110;
  if (F[k] & 1) { img.px[i] = 30; img.px[i + 1] = 200; img.px[i + 2] = 220; } }
for (let k = 0; k < nx * nz; k++) if (inMain[k]) { const x = k % nx, z = (k - x) / nx;
  for (let dy = 0; dy < SC; dy++) for (let dx = 0; dx < SC; dx++) { const px = x * SC + dx, py = z * SC + dy; if (px >= W || py >= Hh) continue; const i = (py * W + px) * 4;
    img.px[i] = Math.round(img.px[i] * 0.65 + 40 * 0.35); img.px[i + 1] = Math.round(img.px[i + 1] * 0.65 + 190 * 0.35); img.px[i + 2] = Math.round(img.px[i + 2] * 0.65 + 120 * 0.35); } }
for (let i = 0; i < best.pts.length; i++) { const a = best.pts[i], b = best.pts[(i + 1) % best.pts.length];
  line(img, Math.round((a[0] - x0) * SC), Math.round((a[1] - z0) * SC), Math.round((b[0] - x0) * SC), Math.round((b[1] - z0) * SC), [255, 60, 110], 0.95); }
let acc = 0, gn = 0;
for (let i = 0; i < best.pts.length; i++) { const a = best.pts[i], b = best.pts[(i + 1) % best.pts.length]; acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (acc > 70) { acc = 0; gn++; const px = Math.round((a[0] - x0) * SC), py = Math.round((a[1] - z0) * SC); rect(img, px - 5, py - 5, px + 5, py + 5, [255, 255, 90], 0.9); text(img, 'G' + gn, px + 8, py - 4, [255, 255, 170], 1); } }
for (let m = Math.ceil(x0 / 25) * 25; m <= x1; m += 25) { const px = Math.round((m - x0) * SC); if (px >= 0 && px < W) { line(img, px, 0, px, Hh - 1, [255, 255, 255], m % 100 === 0 ? 0.35 : 0.12); if (m % 50 === 0) text(img, String(m), px + 2, 2, [255, 220, 120], 1); } }
for (let m = Math.ceil(z0 / 25) * 25; m <= z1; m += 25) { const py = Math.round((m - z0) * SC); if (py >= 0 && py < Hh) { line(img, 0, py, W - 1, py, [255, 255, 255], m % 100 === 0 ? 0.35 : 0.12); if (m % 50 === 0) text(img, String(m), 2, py + 2, [255, 220, 120], 1); } }
const o2 = newImage(W, Hh + 30, [8, 10, 16]); blit(o2, img, 0, 26);
text(o2, `CIRCUIT lap=${best.len.toFixed(0)}m avgClr=${best.avg.toFixed(1)}m minClr=${best.minC.toFixed(1)}m bad=${best.bad} pts=${best.pts.length} CLHARD=${CLHARD}`, 4, 3, [235, 245, 255], 1);
text(o2, `teal=corridor red=circuit yellow=checkpoints(70m) cyan=painted street`, 4, 15, [190, 210, 235], 1);
fs.writeFileSync('/home/user/shots/circuit.png', png(o2.w, o2.h, o2.px));
console.log('saved /home/user/shots/circuit.png');
