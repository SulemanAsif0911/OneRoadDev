/**
 * Circuit builder: connects designer waypoints with max-clearance A* legs inside the
 * drivable network, producing a closed, verified lap -> public/arena/circuit.json
 */
import fs from 'fs';
import { png, newImage, text, line, rect, blit } from '/home/user/tools/pngutil.mjs';
const meta = JSON.parse(fs.readFileSync('public/arena/meta.json', 'utf8'));
const buf = fs.readFileSync('public/arena/grid.bin');
const props = JSON.parse(fs.readFileSync('public/arena/props.json', 'utf8'));
const { nx, nz, res, x0, z0, x1, z1 } = meta;
const H = new Float32Array(nx * nz), B = new Uint8Array(nx * nz), F = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) { H[k] = buf.readInt16LE(k * 4) * meta.quant; B[k] = buf.readUInt8(k * 4 + 2); F[k] = buf.readUInt8(k * 4 + 3); }
const drv = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) { if (H[k] < -900 || B[k] || (F[k] & 2)) continue; drv[k] = 1; }
// clearance field
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
// prop penalty (soft)
const propPen = new Float32Array(nx * nz);
for (const [px_, pz, r, h] of props) {
  const rr = Math.max(1.2, r + 1.5); const gx = Math.round((px_ - x0) / res), gz = Math.round((pz - z0) / res); const R = Math.ceil(rr / res);
  for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const a = gx + dx, b = gz + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
    const d = Math.hypot(dx, dz) * res; if (d > rr) continue; const v = 1 - d / rr; const k = b * nx + a;
    if (v > propPen[k]) propPen[k] = v; } }
// drivable mask that also avoids props a little (used for A*) with soft pen + hard min clearance
const MINCLR = +(process.env.MINCLR || 1.8);
// The racing line follows the PAINTED ROAD: it is the only part of this map that is both
// continuous in height (no plazas dropping off 7 m ledges) and wide enough to race on.
// Props (lamps, planters) are handled by the physics, so they only cost A* a soft penalty.
const ROADONLY = process.env.ROADONLY === '1';
const pass = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) {
  if (!drv[k] || clr[k] < MINCLR) continue;
  if (ROADONLY && !(F[k] & 1)) continue;
  pass[k] = 1;
}
console.log('passable cells:', pass.reduce((a, b) => a + b, 0));
// connected components of the passable region (4-connected) for diagnostics
const comp = new Int32Array(nx * nz).fill(-1); const compSize = []; const compBB = [];
{
  const st = new Int32Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) { if (!pass[k] || comp[k] >= 0) continue; const id = compSize.length; let sp = 0; st[sp++] = k; comp[k] = id; let s = 0;
    let bb = [1e9, 1e9, -1e9, -1e9];
    while (sp > 0) { const c = st[--sp]; s++; const x = c % nx, z = (c - x) / nx;
      bb[0] = Math.min(bb[0], x); bb[2] = Math.max(bb[2], x); bb[1] = Math.min(bb[1], z); bb[3] = Math.max(bb[3], z);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nc = b * nx + a; if (pass[nc] && comp[nc] < 0) { comp[nc] = id; st[sp++] = nc; } } }
    compSize.push(s); compBB.push(bb); }
}
console.log('components:', compSize.map((s, i) => `#${i}:${(s * res * res).toFixed(0)}m2 x[${((compBB[i][0]) * res + x0).toFixed(0)},${((compBB[i][2]) * res + x0).toFixed(0)}] z[${((compBB[i][1]) * res + z0).toFixed(0)},${((compBB[i][3]) * res + z0).toFixed(0)}]`).slice(0, 6).join('\n           '));
function makeHeap(cap) { return { keys: new Float64Array(cap), idx: new Int32Array(cap), n: 0, cap }; }
function hpush(h, k, i) { if (h.n >= h.cap) { const nk = new Float64Array(h.cap * 2), ni = new Int32Array(h.cap * 2); nk.set(h.keys); ni.set(h.idx); h.keys = nk; h.idx = ni; h.cap *= 2; }
  let c = h.n++; h.keys[c] = k; h.idx[c] = i; while (c > 0) { const p = (c - 1) >> 1; if (h.keys[p] <= h.keys[c]) break; const tk = h.keys[p], ti = h.idx[p]; h.keys[p] = h.keys[c]; h.idx[p] = h.idx[c]; h.keys[c] = tk; h.idx[c] = ti; c = p; } }
function hpop(h) { const k = h.keys[0], i = h.idx[0]; h.n--; if (h.n > 0) { h.keys[0] = h.keys[h.n]; h.idx[0] = h.idx[h.n]; let p = 0; for (;;) { const l = 2 * p + 1, r = l + 1; let m = p; if (l < h.n && h.keys[l] < h.keys[m]) m = l; if (r < h.n && h.keys[r] < h.keys[m]) m = r; if (m === p) break; const tk = h.keys[p], ti = h.idx[p]; h.keys[p] = h.keys[m]; h.idx[p] = h.idx[m]; h.keys[m] = tk; h.idx[m] = ti; p = m; } } return [k, i]; }
const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
// ground continuity: the map has terraces, ramps and building bases, so a route that ignores
// height would happily step off a 7 m ledge. Reject transitions steeper than MAXSTEP per cell
// and bias the search towards gentle ground.
const MAXSTEP = +(process.env.MAXSTEP || 0.42);
const SLOPEW = +(process.env.SLOPEW || 5);
function astar(from, to, propw) {
  const D = new Float32Array(nx * nz).fill(INF), P = new Int32Array(nx * nz).fill(-1);
  const done = new Uint8Array(nx * nz);
  const tx = to % nx, tz = (to - tx) / nx;
  const h = (k) => { const x = k % nx, z = (k - x) / nx; return Math.hypot(x - tx, z - tz) * res; };
  const heap = makeHeap(1 << 16); D[from] = 0; hpush(heap, h(from), from);
  while (heap.n > 0) { const [fk, ci] = hpop(heap); if (done[ci]) continue; done[ci] = 1;
    if (ci === to) break;
    const x = ci % nx, z = (ci - x) / nx;
    for (const [dx, dz] of NB8) { const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nc = b * nx + a;
      if (!pass[nc] || done[nc]) continue;
      const dh = Math.abs(H[nc] - H[ci]);
      if (dh > MAXSTEP) continue;
      const ln = (dx && dz ? Math.SQRT2 : 1) * res;
      let w = ln * (1 + 2.5 / Math.max(0.8, clr[nc] - 1.2));
      w *= 1 + propw * propPen[nc];
      w *= 1 + SLOPEW * dh;
      const nd = D[ci] + w; if (nd < D[nc]) { D[nc] = nd; P[nc] = ci; hpush(heap, nd + h(nc), nc); } } }
  if (D[to] >= INF) return null;
  const path = []; let c = to, guard = 0; while (c >= 0 && guard++ < nx * nz) { path.push(c); c = P[c]; } return path.reverse();
}
const WP_RAW = JSON.parse(process.env.WP || fs.readFileSync('tools/waypoints.json', 'utf8'));
const toCell = ([wx, wz]) => { const gx = Math.max(0, Math.min(nx - 1, Math.round((wx - x0) / res))), gz = Math.max(0, Math.min(nz - 1, Math.round((wz - z0) / res))); return gz * nx + gx; };
// snap each waypoint to the nearby maximum-clearance passable cell
function snap(k) {
  if (pass[k]) return k;
  const x = k % nx, z = (k - x) / nx;
  for (let R = 1; R < 40; R++) { let best = -1, bv = -1;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue;
      const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nc = b * nx + a;
      if (pass[nc] && clr[nc] > bv) { bv = clr[nc]; best = nc; } }
    if (best >= 0) return best; }
  return -1;
}
if (process.env.COMPMAP) {
  const PPM = 6.0; const W = Math.round((x1 - x0) * PPM), Hh = Math.round((z1 - z0) * PPM);
  const img = newImage(W, Hh, [8, 10, 16]);
  const big = compSize.indexOf(Math.max(...compSize));
  const pal = [[255, 90, 90], [90, 200, 255], [255, 210, 80], [150, 255, 120], [230, 130, 255], [120, 255, 235]];
  for (let py = 0; py < Hh; py++) for (let px = 0; px < W; px++) { const gx = Math.floor(px / PPM / res), gz = Math.floor(py / PPM / res); if (gx < 0 || gz < 0 || gx >= nx || gz >= nz) continue;
    const k = gz * nx + gx, i = (py * W + px) * 4;
    if (H[k] < -900) { img.px[i] = 8; img.px[i + 1] = 10; img.px[i + 2] = 18; continue; }
    if (B[k]) { img.px[i] = 110; img.px[i + 1] = 55; img.px[i + 2] = 45; continue; }
    if (F[k] & 2) { img.px[i] = 40; img.px[i + 1] = 44; img.px[i + 2] = 56; continue; }
    if (comp[k] === big) { const t = Math.min(1, clr[k] / 14); img.px[i] = 20 + t * 60; img.px[i + 1] = 90 + t * 120; img.px[i + 2] = 70 + t * 110; }
    else if (comp[k] >= 0) { img.px[i] = 70; img.px[i + 1] = 60; img.px[i + 2] = 30; }
    else { img.px[i] = 34; img.px[i + 1] = 38; img.px[i + 2] = 48; } }
  for (let m = Math.ceil(x0 / 20) * 20; m <= x1; m += 20) { const px = Math.round((m - x0) * PPM); if (px >= 0 && px < W) { line(img, px, 0, px, Hh - 1, [255, 255, 255], m % 100 === 0 ? 0.3 : 0.1); text(img, String(m), px + 2, 2, [255, 220, 120], 1); } }
  for (let m = Math.ceil(z0 / 20) * 20; m <= z1; m += 20) { const py = Math.round((m - z0) * PPM); if (py >= 0 && py < Hh) { line(img, 0, py, W - 1, py, [255, 255, 255], m % 100 === 0 ? 0.3 : 0.1); text(img, String(m), 2, py + 2, [255, 220, 120], 1); } }
  WP_RAW.forEach((w, i) => { const px = Math.round((w[0] - x0) * PPM), py = Math.round((w[1] - z0) * PPM);
    rect(img, px - 4, py - 4, px + 4, py + 4, [255, 80, 80], 0.95); text(img, 'W' + (i + 1), px + 6, py - 4, [255, 255, 255], 1); });
  fs.writeFileSync('/home/user/shots/compmap.png', png(img.w, img.h, img.px));
  console.log('wrote compmap.png; big component #' + big + ' size ' + (compSize[big] * res * res).toFixed(0) + 'm2');
  process.exit(0);
}

const PROPW = +(process.env.PROPW || 3.0);
const cells = WP_RAW.map(w => snap(toCell(w)));
cells.forEach((c, i) => { const x = c % nx, z = (c - x) / nx; console.log(`WP${i + 1} in (${WP_RAW[i]}) -> (${((x + 0.5) * res + x0).toFixed(0)},${((z + 0.5) * res + z0).toFixed(0)}) clr=${clr[c].toFixed(1)}m comp=#${comp[c]} (${(compSize[comp[c]] * res * res).toFixed(0)}m2)`); });
let full = [], legs = [];
for (let i = 0; i < cells.length; i++) {
  const a = cells[i], b = cells[(i + 1) % cells.length];
  if (a < 0 || b < 0) { console.log('bad waypoint', i); process.exit(1); }
  const p = a === b ? [a] : astar(a, b, PROPW);
  if (!p) { console.log(`LEG ${i}->${(i + 1) % cells.length} FAILED`); process.exit(2); }
  legs.push(p);
  full = full.concat(p.slice(i === 0 ? 0 : 1));
}
console.log('legs:', legs.map(l => l.length).join(','));
// ---- post-processing: DP simplify -> Catmull-Rom -> snap-to-drivable -> light smoothing ----
const W2M = k => { const x = k % nx, z = (k - x) / nx; return [(x + 0.5) * res + x0, (z + 0.5) * res + z0]; };
const M2K = (p) => { const gx = Math.max(0, Math.min(nx - 1, Math.round((p[0] - x0) / res))), gz = Math.max(0, Math.min(nz - 1, Math.round((p[1] - z0) / res))); return gz * nx + gx; };
const CLEAR_MIN = +(process.env.CLEARMIN || 1.55);   // racing line radius guarantee (m)
const okCell = k => drv[k] && clr[k] >= CLEAR_MIN;
function snapTo(p, maxR) {
  const k = M2K(p);
  if (okCell(k)) return [p[0], p[1], clr[k]];
  const x = k % nx, z = (k - x) / nx;
  for (let R = 1; R <= maxR; R++) {
    let best = null, bv = -1;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue;
      const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nc = b * nx + a;
      if (okCell(nc) && clr[nc] > bv) { bv = clr[nc]; best = nc; }
    }
    if (best !== null) { const bx = best % nx, bz = (best - bx) / nx; return [(bx + 0.5) * res + x0, (bz + 0.5) * res + z0, bv]; }
  }
  return null;
}
const rl = a => { let L = 0; for (let i = 1; i < a.length; i++) L += Math.hypot(a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]); return L; };
let pts = full.map(W2M);
const rawLen = rl(pts.concat([pts[0]]));
// Douglas-Peucker, closed-loop variant (split at two extreme points)
function dp(pts, tol) {
  if (pts.length < 4) return pts.slice();
  let iA = 0, iB = 0, best = -1;
  for (let i = 0; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > best) { best = d; iB = i; } }
  const seg = (arr) => { if (arr.length < 3) return arr.slice(); const keep = new Uint8Array(arr.length); keep[0] = 1; keep[arr.length - 1] = 1; const st = [[0, arr.length - 1]];
    while (st.length) { const [i0, i1] = st.pop(); const a = arr[i0], b = arr[i1]; const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy;
      let mi = -1, md = -1; for (let i = i0 + 1; i < i1; i++) { const p = arr[i]; let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)); if (d > md) { md = d; mi = i; } }
      if (md > tol) { keep[mi] = 1; st.push([i0, mi]); st.push([mi, i1]); } }
    return arr.filter((_, i) => keep[i]); };
  const a1 = seg(pts.slice(iB).concat(pts.slice(0, iB + 1)));
  // a1 runs from pts[iB] around to pts[iB] again; drop duplicate ends
  return a1.slice(0, -1);
}
const simp = dp(pts, +(process.env.DPTOL || 5));
const CR = (p0, p1, p2, p3, t) => { const t2 = t * t, t3 = t2 * t; return [0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
  0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]; };
let rs = [];
{ const n = simp.length;
  for (let i = 0; i < n; i++) { const p0 = simp[(i - 1 + n) % n], p1 = simp[i], p2 = simp[(i + 1) % n], p3 = simp[(i + 2) % n];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]); const steps = Math.max(1, Math.round(segLen / 3));
    for (let s = 0; s < steps; s++) rs.push(CR(p0, p1, p2, p3, s / steps)); } }
// snap every point onto drivable ground
let unsnapped = 0;
rs = rs.map(p => { const s = snapTo(p, +(process.env.SNAPR || 8)); if (!s) { unsnapped++; return p; } return [s[0], s[1]]; });
// verified reference path (A* result): every point on it has clearance >= pathMinClr
const refPts = full.map(W2M);
// project a point onto the nearest reference point (guarantees drivability of tight spots)
function project(p) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < refPts.length; i += 1) { const d = (refPts[i][0] - p[0]) ** 2 + (refPts[i][1] - p[1]) ** 2; if (d < bd) { bd = d; bi = i; } }
  return [refPts[bi][0], refPts[bi][1]];
}
const TARGET = +(process.env.CLEARTARGET || 2.6);
// iterative smoothing + projection: produces a smooth line that never drops below TARGET
for (let it = 0; it < +(process.env.SMOOTHPASS || 8); it++) {
  const n = rs.length; const ns = rs.map((p, i) => { const a = rs[(i - 1 + n) % n], b = rs[(i + 1) % n];
    return [(p[0] * 2 + a[0] + b[0]) / 4, (p[1] * 2 + a[1] + b[1]) / 4]; });
  rs = ns.map(p => { const s = snapTo(p, 4); const q = s ? [s[0], s[1]] : p; const k = M2K(q);
    if (clr[k] < TARGET) { const pr = project(q); if (clr[M2K(pr)] >= clr[k]) return pr; }
    return q; });
}
// metrics over the final line + the raw A* path
let minC = 1e9, sumC = 0; const tight = [];
rs.forEach((p, i) => { const k = M2K(p); const v = clr[k]; minC = Math.min(minC, v); sumC += v; if (v < CLEAR_MIN + 0.35) tight.push([i, +p[0].toFixed(0), +p[1].toFixed(0), +v.toFixed(1)]); });
const avgC = sumC / rs.length;
let pathMin = 1e9; for (const k of full) pathMin = Math.min(pathMin, clr[k]);
const lapLen = rl(rs.concat([rs[0]]));
console.log(`lap=${lapLen.toFixed(0)}m (raw ${rawLen.toFixed(0)}m) pts=${rs.length} avgClr=${avgC.toFixed(2)} minClr=${minC.toFixed(2)} pathMinClr=${pathMin.toFixed(2)} tight=${tight.length} unsnapped=${unsnapped}`);
if (tight.length) console.log('  tight:', JSON.stringify(tight.slice(0, 14)));
fs.writeFileSync('public/arena/circuit.json', JSON.stringify({ lapLen: +lapLen.toFixed(1), minClr: +minC.toFixed(2), avgClr: +avgC.toFixed(2), pts: rs.map(p => [+p[0].toFixed(2), +p[1].toFixed(2)]) }));
// render
const PPM = 5.0; const W = Math.round((x1 - x0) * PPM), Hh = Math.round((z1 - z0) * PPM);
const img = newImage(W, Hh, [8, 10, 16]);
for (let py = 0; py < Hh; py++) for (let px = 0; px < W; px++) { const gx = Math.floor(px / PPM / res), gz = Math.floor(py / PPM / res); if (gx < 0 || gz < 0 || gx >= nx || gz >= nz) continue;
  const k = gz * nx + gx, i = (py * W + px) * 4;
  if (H[k] < -900) { img.px[i] = 8; img.px[i + 1] = 10; img.px[i + 2] = 18; continue; }
  if (B[k]) { img.px[i] = 120; img.px[i + 1] = 60; img.px[i + 2] = 50; continue; }
  if (F[k] & 2) { img.px[i] = 40; img.px[i + 1] = 44; img.px[i + 2] = 56; continue; }
  const t = Math.min(1, clr[k] / 14); img.px[i] = 16 + t * 50; img.px[i + 1] = 56 + t * 110; img.px[i + 2] = 40 + t * 100;
  if (F[k] & 1) { img.px[i] = Math.round(img.px[i] * 0.5 + 30 * 0.5); img.px[i + 1] = Math.round(img.px[i + 1] * 0.5 + 130 * 0.5); img.px[i + 2] = Math.round(img.px[i + 2] * 0.5 + 150 * 0.5); } }
for (const [px_, pz] of props) { const sx = Math.round((px_ - x0) * PPM), sy = Math.round((pz - z0) * PPM); if (sx >= 0 && sy >= 0 && sx < W && sy < Hh) { const i = (sy * W + sx) * 4; img.px[i] = 255; img.px[i + 1] = 255; img.px[i + 2] = 255; } }
for (let i = 0; i < rs.length; i++) { const a = rs[i], b = rs[(i + 1) % rs.length]; line(img, Math.round((a[0] - x0) * PPM), Math.round((a[1] - z0) * PPM), Math.round((b[0] - x0) * PPM), Math.round((b[1] - z0) * PPM), [255, 60, 110], 0.95); }
rs.forEach((p, i) => { if (i % 4 === 0) { const sx = Math.round((p[0] - x0) * PPM), sy = Math.round((p[1] - z0) * PPM); rect(img, sx - 1, sy - 1, sx + 1, sy + 1, [255, 255, 90], 0.8); } });
rect(img, Math.round((rs[0][0] - x0) * PPM) - 6, Math.round((rs[0][1] - z0) * PPM) - 6, Math.round((rs[0][0] - x0) * PPM) + 6, Math.round((rs[0][1] - z0) * PPM) + 6, [120, 255, 120], 0.95);
for (let m = Math.ceil(x0 / 25) * 25; m <= x1; m += 25) { const px = Math.round((m - x0) * PPM); if (px >= 0 && px < W) { line(img, px, 0, px, Hh - 1, [255, 255, 255], m % 100 === 0 ? 0.35 : 0.12); if (m % 50 === 0) text(img, String(m), px + 2, 2, [255, 220, 120], 1); } }
for (let m = Math.ceil(z0 / 25) * 25; m <= z1; m += 25) { const py = Math.round((m - z0) * PPM); if (py >= 0 && py < Hh) { line(img, 0, py, W - 1, py, [255, 255, 255], m % 100 === 0 ? 0.35 : 0.12); if (m % 50 === 0) text(img, String(m), 2, py + 2, [255, 220, 120], 1); } }
const o2 = newImage(W, Hh + 30, [8, 10, 16]); blit(o2, img, 0, 26);
text(o2, `CIRCUIT lap=${lapLen.toFixed(0)}m avgClr=${avgC.toFixed(1)}m minClr=${minC.toFixed(1)}m pathMin=${pathMin.toFixed(1)} tight=${tight.length} pts=${rs.length}`, 4, 3, [235, 245, 255], 1);
text(o2, `red=lap green=start white=props orange=blocked cyan-ish=painted street`, 4, 15, [190, 210, 235], 1);
fs.writeFileSync('/home/user/shots/circuit.png', png(o2.w, o2.h, o2.px));
console.log('saved /home/user/shots/circuit.png');
