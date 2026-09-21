/**
 * Road-loop builder: picks the biggest continuous painted-road network, finds two disjoint
 * routes between its farthest points (=> a genuine closed circuit), then smooths it into the
 * shipping racing line. Writes public/arena/circuit.json (+ a debug PNG).
 */
import fs from 'node:fs';
import { png, newImage, text, line } from '/home/user/tools/pngutil.mjs';
const setPx = (img, x, y, c) => { if (x < 0 || y < 0 || x >= img.w || y >= img.h) return; const i = (y * img.w + x) * 4; img.px[i] = c[0]; img.px[i + 1] = c[1]; img.px[i + 2] = c[2]; };
const meta = JSON.parse(fs.readFileSync('public/arena/meta.json', 'utf8'));
const buf = fs.readFileSync('public/arena/grid.bin');
const props = JSON.parse(fs.readFileSync('public/arena/props.json', 'utf8'));
const { nx, nz, res, x0, z0 } = meta;
const H = new Float32Array(nx * nz), B = new Uint8Array(nx * nz), F = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) { H[k] = buf.readInt16LE(k * 4) * meta.quant; B[k] = buf.readUInt8(k * 4 + 2); F[k] = buf.readUInt8(k * 4 + 3); }
const drv = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) if (!(H[k] < -900 || B[k] || (F[k] & 2))) drv[k] = 1;
// clearance
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
const propPen = new Float32Array(nx * nz);
for (const p of props) {
  const [px_, pz, r] = p; const rr = Math.max(1.2, r + 1.4);
  const gx = Math.round((px_ - x0) / res), gz = Math.round((pz - z0) / res); const R = Math.ceil(rr / res);
  for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const a = gx + dx, b = gz + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
    const d = Math.hypot(dx, dz) * res; if (d > rr) continue; const v = 1 - d / rr; const k = b * nx + a;
    if (v > propPen[k]) propPen[k] = v; } }

const MINCLR = +(process.env.MINCLR || 1.5);
const MAXSTEP = +(process.env.MAXSTEP || 0.42);
const ROADONLY = process.env.ROADONLY !== '0';
const pass = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) {
  if (!drv[k] || clr[k] < MINCLR) continue;
  if (ROADONLY && !(F[k] & 1)) continue;
  pass[k] = 1;
}
// components (8-connected for a friendlier network)
const comp = new Int32Array(nx * nz).fill(-1); const sizes = []; const cells = [];
{
  const st = new Int32Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) {
    if (!pass[k] || comp[k] >= 0) continue;
    const id = sizes.length; let sp = 0; st[sp++] = k; comp[k] = id; let s = 0; const list = [];
    while (sp > 0) { const c = st[--sp]; s++; list.push(c); const x = c % nx, z = (c - x) / nx;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nk = b * nx + a;
        if (!pass[nk] || comp[nk] >= 0) continue; if (Math.abs(H[nk] - H[c]) > MAXSTEP) continue; comp[nk] = id; st[sp++] = nk; } }
    sizes.push(s); cells.push(list);
  }
}
const order = sizes.map((s, i) => i).sort((a, b) => sizes[b] - sizes[a]);
console.log('components (top):', order.slice(0, 6).map((i) => `#${i}:${(sizes[i] * res * res).toFixed(0)}m2`).join(' '));
const big = order[0];
const inComp = new Uint8Array(nx * nz);
for (const c of cells[big]) inComp[c] = 1;
// keep only the biggest component for the search
const ok = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) ok[k] = pass[k] && inComp[k] ? 1 : 0;

function makeHeap(cap) { return { keys: new Float64Array(cap), idx: new Int32Array(cap), n: 0, cap }; }
function hpush(h, k, i) { if (h.n >= h.cap) { const nk = new Float64Array(h.cap * 2), ni = new Int32Array(h.cap * 2); nk.set(h.keys); ni.set(h.idx); h.keys = nk; h.idx = ni; h.cap *= 2; }
  let c = h.n++; h.keys[c] = k; h.idx[c] = i; while (c > 0) { const p = (c - 1) >> 1; if (h.keys[p] <= h.keys[c]) break; const tk = h.keys[p], ti = h.idx[p]; h.keys[p] = h.keys[c]; h.idx[p] = h.idx[c]; h.keys[c] = tk; h.idx[c] = ti; c = p; } }
function hpop(h) { const k = h.keys[0], i = h.idx[0]; h.n--; if (h.n > 0) { h.keys[0] = h.keys[h.n]; h.idx[0] = h.idx[h.n]; let p = 0; for (;;) { const l = 2 * p + 1, r = l + 1; let m = p; if (l < h.n && h.keys[l] < h.keys[m]) m = l; if (r < h.n && h.keys[r] < h.keys[m]) m = r; if (m === p) break; const tk = h.keys[p], ti = h.idx[p]; h.keys[p] = h.keys[m]; h.idx[p] = h.idx[m]; h.keys[m] = tk; h.idx[m] = ti; p = m; } } return [k, i]; }
const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const blocked2 = new Uint8Array(nx * nz);
function astar(from, to, propw, useBlock) {
  const D = new Float32Array(nx * nz).fill(INF), P = new Int32Array(nx * nz).fill(-1);
  const done = new Uint8Array(nx * nz);
  const tx = to % nx, tz = (to - tx) / nx;
  const hh = (k) => { const x = k % nx, z = (k - x) / nx; return Math.hypot(x - tx, z - tz) * res; };
  const heap = makeHeap(1 << 16); D[from] = 0; hpush(heap, hh(from), from);
  while (heap.n > 0) { const [, ci] = hpop(heap); if (done[ci]) continue; done[ci] = 1;
    if (ci === to) break;
    const x = ci % nx, z = (ci - x) / nx;
    for (const [dx, dz] of NB8) { const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nc = b * nx + a;
      if (!ok[nc] || done[nc] || (useBlock && blocked2[nc])) continue;
      const dh = Math.abs(H[nc] - H[ci]); if (dh > MAXSTEP) continue;
      const ln = (dx && dz ? Math.SQRT2 : 1) * res;
      let w = ln * (1 + 2.5 / Math.max(0.8, clr[nc] - 1.2));
      w *= 1 + propw * propPen[nc];
      w *= 1 + 5 * dh;
      const nd = D[ci] + w; if (nd < D[nc]) { D[nc] = nd; P[nc] = ci; hpush(heap, nd + hh(nc), nc); } } }
  if (D[to] >= INF) return null;
  const path = []; let c = to, guard = 0; while (c >= 0 && guard++ < nx * nz) { path.push(c); c = P[c]; } return path.reverse();
}
// farthest-point pair over the component (BFS in cell hops, 8-connected)
function bfsFarthest(start) {
  const dist = new Int32Array(nx * nz).fill(-1); const q = new Int32Array(nx * nz); let qh = 0, qt = 0;
  dist[start] = 0; q[qt++] = start; let best = start, bestD = 0;
  while (qh < qt) { const c = q[qh++]; const x = c % nx, z = (c - x) / nx;
    if (dist[c] > bestD) { bestD = dist[c]; best = c; }
    for (const [dx, dz] of NB8) { const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nk = b * nx + a;
      if (!ok[nk] || dist[nk] >= 0) continue; if (Math.abs(H[nk] - H[c]) > MAXSTEP) continue; dist[nk] = dist[c] + 1; q[qt++] = nk; } }
  return { far: best, dist, bestD };
}
// Candidate loops: for several spread-out seed pairs, find two disjoint routes between them
// (the racer's way of turning an open drivable "room" into a closed circuit) and keep the best.
const propw = +(process.env.PROPW || 2.0);
const CORR = +(process.env.CORR || 1.6);
const SIMP = +(process.env.DPTOL || 1.6);
const SPACING = +(process.env.SPACING || 2.8);
const SMOOTHPASS = +(process.env.SMOOTHPASS || 26);

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)];
}
function dp(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bestD = tol;
    const ax = pts[a][0], az = pts[a][1], bx = pts[b][0], bz = pts[b][1];
    const ex = bx - ax, ez = bz - az; const len2 = ex * ex + ez * ez || 1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * ex + (pts[i][1] - az) * ez) / len2));
      const d = Math.hypot(pts[i][0] - (ax + ex * t), pts[i][1] - (az + ez * t));
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = []; for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]); return out;
}
function project(p) {
  const gx = Math.round((p[0] - x0) / res), gz = Math.round((p[1] - z0) / res);
  if (gx >= 0 && gz >= 0 && gx < nx && gz < nz) { const k = gz * nx + gx; if (ok[k]) return [x0 + gx * res, z0 + gz * res]; }
  for (let R = 1; R < 14; R++) {
    let best = null, bestD = 1e9;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue;
      const a = gx + dx, b = gz + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const k = b * nx + a; if (!ok[k]) continue; const d = Math.hypot(dx, dz); if (d < bestD) { bestD = d; best = [x0 + a * res, z0 + b * res]; } }
    if (best) return best;
  }
  return p;
}
/** build the shipping racing line from a cell loop */
function buildPath(loopCells) {
  const raw = loopCells.map((k) => { const x = k % nx, z = (k - x) / nx; return [x0 + x * res, z0 + z * res]; });
  const simplified = dp(raw.concat([raw[0]]), SIMP);
  simplified.pop();
  const n = simplified.length;
  const dense = [];
  for (let i = 0; i < n; i++) {
    const p0 = simplified[(i - 1 + n) % n], p1 = simplified[i], p2 = simplified[(i + 1) % n], p3 = simplified[(i + 2) % n];
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(2, Math.round(seg / SPACING));
    for (let s2 = 0; s2 < steps; s2++) dense.push(catmull(p0, p1, p2, p3, s2 / steps));
  }
  let path = dense.map(project);
  for (let it = 0; it < SMOOTHPASS; it++) {
    const out = path.map((p) => p.slice());
    for (let i = 0; i < path.length; i++) {
      const a = path[(i - 1 + path.length) % path.length], b = path[(i + 1) % path.length];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const tx = path[i][0] + (mx - path[i][0]) * 0.42, tz = path[i][1] + (mz - path[i][1]) * 0.42;
      const pr = project([tx, tz]);
      out[i] = Math.hypot(pr[0] - tx, pr[1] - tz) < 0.75 ? pr : path[i];
    }
    path = out;
  }
  return path;
}
function shapeMetrics(path) {
  let lapLen = 0, maxTurn = 0, totalTurn = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i + 1) % path.length], c = path[(i + 2) % path.length];
    lapLen += Math.hypot(b[0] - a[0], b[1] - a[1]);
    const v1x = b[0] - a[0], v1z = b[1] - a[1], v2x = c[0] - b[0], v2z = c[1] - b[1];
    const ang = Math.atan2(v1x * v2z - v1z * v2x, v1x * v2x + v1z * v2z);
    maxTurn = Math.max(maxTurn, Math.abs(ang)); totalTurn += Math.abs(ang);
  }
  const clrs = path.map((p) => { const gx = Math.round((p[0] - x0) / res), gz = Math.round((p[1] - z0) / res); return gx >= 0 && gz >= 0 && gx < nx && gz < nz ? clr[gz * nx + gx] : 0; });
  return { lapLen, maxTurn, revs: totalTurn / (2 * Math.PI), avgClr: clrs.reduce((a, b) => a + b, 0) / clrs.length, minClr: Math.min(...clrs), tight: clrs.filter((c) => c < 2).length };
}
function despike(loopCells) {
  let L = loopCells;
  for (let pass = 0; pass < 8; pass++) {
    const out = []; let removed = 0;
    for (let i = 0; i < L.length; i++) {
      const prev = L[(i - 1 + L.length) % L.length], next = L[(i + 1) % L.length];
      if (prev === next) { removed++; continue; }
      out.push(L[i]);
    }
    L = out;
    L = L.filter((c, i) => c !== L[(i + 1) % L.length]);
    if (!removed) break;
  }
  return L;
}

const pairList = [];
{
  // wide cells as endpoints: take the top-clearance cells spread over the room, then for each
  // pick the partner that maximises distance + width
  const cand = cells[big].slice().sort((a, b) => clr[b] - clr[a]).slice(0, 120);
  const picked = [];
  for (const A of cand) {
    if (picked.some((q) => Math.hypot((q % nx) - (A % nx), ((q - (q % nx)) / nx) - ((A - (A % nx)) / nx)) < 8)) continue;
    picked.push(A);
    if (picked.length >= 16) break;
  }
  for (const A of picked) {
    const { dist } = bfsFarthest(A);
    // several partners per seed: the farthest, and the best balance of far + wide
    const cells2 = cells[big].filter((c) => dist[c] >= 0);
    cells2.sort((a, b) => (dist[b] + 4 * Math.min(clr[b], 12)) - (dist[a] + 4 * Math.min(clr[a], 12)));
    for (const Bp of cells2.slice(0, 3)) pairList.push([A, Bp, dist[Bp] * res]);
  }
  // dedupe by endpoint pair
  const seen = new Set(); const uniq = [];
  for (const [A, Bp, d] of pairList) { const k = Math.min(A, Bp) + ':' + Math.max(A, Bp); if (seen.has(k)) continue; seen.add(k); uniq.push([A, Bp, d]); }
  pairList.length = 0; pairList.push(...uniq);
  pairList.sort((a, b) => b[2] - a[2]);
}

let bestLoop = null;
for (const [A, Bp, dist] of pairList) {
  const p1 = astar(A, Bp, propw, false);
  if (!p1) { console.log(`  A(${A % nx},${(A - (A % nx)) / nx}) clr ${clr[A].toFixed(1)}m -> dist ${dist.toFixed(0)}m: path1 FAIL`); continue; }
  blocked2.fill(0);
  for (const c of p1) {
    const x = c % nx, z = (c - x) / nx; const R = Math.ceil(CORR / res);
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      if (Math.hypot(dx, dz) * res > CORR) continue; blocked2[b * nx + a] = 1; }
  }
  const clearR = Math.ceil(Math.max(2.0, CORR) / res);
  for (const c of [p1[0], p1[p1.length - 1]]) {
    const x = c % nx, z = (c - x) / nx;
    for (let dz = -clearR; dz <= clearR; dz++) for (let dx = -clearR; dx <= clearR; dx++) {
      const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; blocked2[b * nx + a] = 0; }
  }
  const p2 = astar(A, Bp, propw, true);
  if (!p2) { console.log(`  A(${A % nx},${(A - (A % nx)) / nx}) clr ${clr[A].toFixed(1)}m dist ${dist.toFixed(0)}m: path2 FAIL`); continue; }
  const loopCells = despike(p1.concat(p2.slice(1, -1).reverse()));
  const path = buildPath(loopCells);
  const m = shapeMetrics(path);
  const score = m.lapLen - 45 * Math.max(0, m.revs - 1.25) - 180 * m.maxTurn;
  console.log(`  A(${A % nx},${(A - (A % nx)) / nx}) clr ${clr[A].toFixed(1)}m dist ${dist.toFixed(0)}m: ${path.length} pts, ${m.lapLen.toFixed(0)} m, clr ${m.avgClr.toFixed(1)}/${m.minClr.toFixed(1)}, revs ${m.revs.toFixed(2)}, maxTurn ${(m.maxTurn * 57.3).toFixed(0)}deg -> score ${score.toFixed(0)}`);
  if (!bestLoop || score > bestLoop.score) bestLoop = { path, m, score };
}
if (!bestLoop) { console.log('no loop found'); process.exit(1); }
const path = bestLoop.path, m = bestLoop.m;
const steps = path.map((p, i) => { const q = path[(i + 1) % path.length]; return Math.abs(hAt(p) - hAt(q)); });
function hAt(p) { const gx = Math.round((p[0] - x0) / res), gz = Math.round((p[1] - z0) / res); if (gx < 0 || gz < 0 || gx >= nx || gz >= nz) return 0; return H[gz * nx + gx]; }
const maxStep = Math.max(...steps);
const out = { pts: path, lapLen: m.lapLen, minClr: m.minClr, avgClr: m.avgClr, maxStep, res, src: 'roadloop' };
fs.writeFileSync('public/arena/circuit.json', JSON.stringify(out));
console.log(`LOOP: ${m.lapLen.toFixed(0)} m, ${path.length} pts, avgClr ${m.avgClr.toFixed(2)} m, minClr ${m.minClr.toFixed(2)} m, tight(<2m) ${m.tight}, maxStep ${maxStep.toFixed(2)} m, revolutions ${m.revs.toFixed(2)}`);
function debugImage(path, file) {
  const SC = +(process.env.PPM || 3);
  const W = Math.round(nx * res * SC), Hh = Math.round(nz * res * SC);
  const img = newImage(W, Hh, [10, 12, 16]);
  for (let gz = 0; gz < nz; gz++) for (let gx = 0; gx < nx; gx++) {
    const k = gz * nx + gx; if (!drv[k] && !B[k]) continue;
    const px = Math.round(gx * res * SC), py = Math.round(gz * res * SC);
    const c = B[k] ? [90, 34, 34] : (F[k] & 1) ? [96, 96, 104] : [42, 46, 54];
    for (let dy = 0; dy < SC; dy++) for (let dx = 0; dx < SC; dx++) setPx(img, px + dx, py + dy, c);
  }
  for (let gz = 0; gz < nz; gz++) for (let gx = 0; gx < nx; gx++) { const k = gz * nx + gx; if (!ok[k]) continue;
    const px = Math.round(gx * res * SC), py = Math.round(gz * res * SC);
    for (let dy = 0; dy < SC; dy++) for (let dx = 0; dx < SC; dx++) setPx(img, px + dx, py + dy, [40, 120, 70]); }
  for (let i = 0; i < path.length; i++) { const a = path[i], b = path[(i + 1) % path.length];
    line(img, (a[0] - x0) / res * SC, (a[1] - z0) / res * SC, (b[0] - x0) / res * SC, (b[1] - z0) / res * SC, [255, 220, 60]); }
  text(img, `LOOP ${m.lapLen.toFixed(0)}M CLR ${m.avgClr.toFixed(1)}/${m.minClr.toFixed(1)} REV ${m.revs.toFixed(2)}`, 8, 8, [255, 255, 255], 2);
  fs.writeFileSync(file, png(W, Hh, img.px));
  console.log('wrote', file);
}
debugImage(path, process.env.OUT || '/home/user/shots/roadloop.png');
