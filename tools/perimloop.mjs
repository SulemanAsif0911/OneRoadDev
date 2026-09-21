/**
 * Perimeter circuit builder.
 *
 * The baked city is a set of drivable "rooms" (the whole network is not connected), so the race
 * has to live inside one of them. Instead of stitching two disjoint A* routes (which collapses
 * into out-and-back spurs), this traces the boundary of the room inset by INSET metres: a closed
 * loop that follows the shape of the place, keeps a real safety margin and uses all of it.
 *
 * Writes public/arena/circuit.json + a debug PNG (OUT / PPM env).
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
const MAXSTEP = +(process.env.MAXSTEP || 0.6);
const ROADONLY = process.env.ROADONLY === '1';
const INSET = +(process.env.INSET || 4.2);
const pass = new Uint8Array(nx * nz);
for (let k = 0; k < nx * nz; k++) {
  if (!drv[k] || clr[k] < MINCLR) continue;
  if (ROADONLY && !(F[k] & 1)) continue;
  pass[k] = 1;
}
// label the rooms and keep the biggest
const comp = new Int32Array(nx * nz).fill(-1); const sizes = []; const members = [];
{
  const st = new Int32Array(nx * nz);
  const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let k = 0; k < nx * nz; k++) {
    if (!pass[k] || comp[k] >= 0) continue;
    const id = sizes.length; let sp = 0; st[sp++] = k; comp[k] = id; let s = 0; const list = [];
    while (sp > 0) { const c = st[--sp]; s++; list.push(c); const x = c % nx, z = (c - x) / nx;
      for (const [dx, dz] of NB8) { const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nk = b * nx + a;
        if (!pass[nk] || comp[nk] >= 0) continue; if (Math.abs(H[nk] - H[c]) > MAXSTEP) continue; comp[nk] = id; st[sp++] = nk; } }
    sizes.push(s); members.push(list);
  }
}
const order = sizes.map((s, i) => i).sort((a, b) => sizes[b] - sizes[a]);
console.log('rooms:', order.slice(0, 5).map((i) => `#${i}:${(sizes[i] * res * res).toFixed(0)}m2`).join(' '));
const big = order[0];
const room = new Uint8Array(nx * nz);
for (const c of members[big]) room[c] = 1;

// inset region: room cells at least INSET from anything not in the room
const inset = new Uint8Array(nx * nz);
for (const c of members[big]) if (clr[c] >= INSET) inset[c] = 1;
// keep the biggest 4-connected part of the inset (small blobs would give silly loops)
let bestIns = null;
{
  const seen = new Int32Array(nx * nz).fill(-1);
  const q = new Int32Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) {
    if (!inset[k] || seen[k] >= 0) continue;
    let qh = 0, qt = 0; q[qt++] = k; seen[k] = 1; const list = [];
    while (qh < qt) { const c = q[qh++]; list.push(c); const x = c % nx, z = (c - x) / nx;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const nk = b * nx + a;
        if (!inset[nk] || seen[nk] >= 0) continue; seen[nk] = 1; q[qt++] = nk; } }
    if (!bestIns || list.length > bestIns.length) bestIns = list;
  }
}
// Morphological opening of the inset region: a boundary trace of a room with thin fingers or
// narrow necks produces hairpins that no car can drive, so anything thinner than 2*OPEN metres
// is eroded away and then grown back. What is left is the room's "body", and its outline is a
// lap a car can actually follow.
function chamfer(mask) {
  const d = new Float32Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) d[k] = mask[k] ? INF : 0;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { const k = z * nx + x; const v = d[k]; if (v === 0) continue;
    if (x > 0) d[k] = Math.min(d[k], d[k - 1] + 1); if (z > 0) d[k] = Math.min(d[k], d[k - nx] + 1);
    if (x > 0 && z > 0) d[k] = Math.min(d[k], d[k - nx - 1] + d2); if (x < nx - 1 && z > 0) d[k] = Math.min(d[k], d[k - nx + 1] + d2); }
  for (let z = nz - 1; z >= 0; z--) for (let x = nx - 1; x >= 0; x--) { const k = z * nx + x; if (d[k] === 0) continue;
    if (x < nx - 1) d[k] = Math.min(d[k], d[k + 1] + 1); if (z < nz - 1) d[k] = Math.min(d[k], d[k + nx] + 1);
    if (x < nx - 1 && z < nz - 1) d[k] = Math.min(d[k], d[k + nx + 1] + d2); if (x > 0 && z < nz - 1) d[k] = Math.min(d[k], d[k + nx - 1] + d2); }
  for (let k = 0; k < nx * nz; k++) d[k] *= res;
  return d;
}
const OPEN = +(process.env.OPEN || 4.5);
let ins = new Uint8Array(nx * nz);
for (const c of bestIns) ins[c] = 1;
if (OPEN > 0) {
  const eroded = new Uint8Array(nx * nz);
  for (const c of bestIns) if (clr[c] >= INSET + OPEN) eroded[c] = 1;
  const dEro = chamfer(eroded);
  const opened = new Uint8Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) if (room[k] && dEro[k] <= OPEN) opened[k] = 1;
  // keep the biggest 4-connected part again (the opening can split a room in two)
  const seen = new Int32Array(nx * nz).fill(-1); const q = new Int32Array(nx * nz); let keep2 = null;
  for (let k = 0; k < nx * nz; k++) {
    if (!opened[k] || seen[k] >= 0) continue;
    let qh = 0, qt = 0; q[qt++] = k; seen[k] = 1; const list = [];
    while (qh < qt) { const c = q[qh++]; list.push(c); const x = c % nx, z = (c - x) / nx;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a2 = x + dx, b2 = z + dz; if (a2 < 0 || b2 < 0 || a2 >= nx || b2 >= nz) continue; const nk = b2 * nx + a2;
        if (!opened[nk] || seen[nk] >= 0) continue; seen[nk] = 1; q[qt++] = nk; } }
    if (!keep2 || list.length > keep2.length) keep2 = list;
  }
  if (keep2 && keep2.length > 200) {
    ins = new Uint8Array(nx * nz);
    for (const c of keep2) ins[c] = 1;
    bestIns = keep2;
  }
}
console.log(`inset ${INSET}m region: ${(bestIns.length * res * res).toFixed(0)} m2 (opened at ${OPEN} m)`);

// Moore boundary tracing around the inset region (clockwise in image coords)
const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
let start = bestIns[0];
for (const c of bestIns) { const x = c % nx, z = (c - x) / nx;
  const sx = start % nx, sz = (start - (start % nx)) / nx;
  if (z < sz || (z === sz && x < sx)) start = c; }
const trace = [];
{
  let cur = start, dir = 6;               // came from the east
  const guard = bestIns.length * 12;
  for (let step = 0; step < guard; step++) {
    trace.push(cur);
    let found = -1;
    for (let i = 1; i <= 8; i++) {
      const d = (dir + i) % 8;
      const x = (cur % nx) + N8[d][0], z = ((cur - (cur % nx)) / nx) + N8[d][1];
      if (x < 0 || z < 0 || x >= nx || z >= nz) continue;
      const nk = z * nx + x;
      if (ins[nk]) { found = nk; dir = (d + 4) % 8; break; }
    }
    if (found < 0) break;                  // isolated cell
    cur = found;
    if (cur === start && trace.length > 8) break;
  }
}
console.log('boundary cells:', trace.length);
// world points
let pts = trace.map((k) => { const x = k % nx, z = (k - x) / nx; return [x0 + x * res, z0 + z * res]; });
// DP simplify (closed loop)
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
const SIMP = +(process.env.DPTOL || 1.4);
let simp = dp(pts.concat([pts[0]]), SIMP); simp.pop();
// remove near-duplicates (closed loop corners repeat)
simp = simp.filter((p, i) => { const q = simp[(i + 1) % simp.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]) > 1.0; });
// Catmull-Rom resample + smoothing constrained to stay inside the room with clearance
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)];
}
const SPACING = +(process.env.SPACING || 3.0);
const dense = [];
const n = simp.length;
for (let i = 0; i < n; i++) {
  const p0 = simp[(i - 1 + n) % n], p1 = simp[i], p2 = simp[(i + 1) % n], p3 = simp[(i + 2) % n];
  const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const steps = Math.max(2, Math.round(seg / SPACING));
  for (let s = 0; s < steps; s++) dense.push(catmull(p0, p1, p2, p3, s / steps));
}
// ---------------------------------------------------------------- clearance test used by the path
// The car is not a point: the loop has to fit the LARGEST car the game can spawn (a 5.6 x 2.1 m
// luxury class), so every candidate point is tested with a body-shaped probe set and the clearance
// is read from the (bilinear sampled) distance field instead of the raw cell value.
const CAR_HL = +(process.env.CARHL || 2.8);      // half length of the biggest car
const CAR_HW = +(process.env.CARHW || 1.05);     // half width of the biggest car
const MARGIN = +(process.env.MARGIN || 0.45);    // how much air we insist on around the body
const PROBES = [];
for (const fx of [-1, -0.5, 0, 0.5, 1]) for (const fz of [0]) PROBES.push([fx, fz]);
for (const fz of [-1, -0.5, 0.5, 1]) for (const fx of [-1, 1]) PROBES.push([fx * 0.35, fz]);
function clrAt(x, z) {
  const fx = (x - x0) / res, fz = (z - z0) / res;
  const gx = Math.max(0, Math.min(nx - 2, Math.floor(fx))), gz = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - gx)), tz = Math.max(0, Math.min(1, fz - gz));
  const k = gz * nx + gx;
  return clr[k] * (1 - tx) * (1 - tz) + clr[k + 1] * tx * (1 - tz) + clr[k + nx] * (1 - tx) * tz + clr[k + nx + 1] * tx * tz;
}
function heightAt(x, z) {
  const fx = (x - x0) / res, fz = (z - z0) / res;
  const gx = Math.max(0, Math.min(nx - 2, Math.floor(fx))), gz = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - gx)), tz = Math.max(0, Math.min(1, fz - gz));
  const k = gz * nx + gx;
  return H[k] * (1 - tx) * (1 - tz) + H[k + 1] * tx * (1 - tz) + H[k + nx] * (1 - tx) * tz + H[k + nx + 1] * tx * tz;
}
/** smallest clearance any part of the car body has when it sits at (x,z) pointing along (tx,tz) */
function bodyClr(x, z, tx, tz) {
  const rx = -tz, rz = tx;
  let m = 1e9;
  for (const [f, r] of PROBES) {
    const px = x + tx * f * CAR_HL + rx * r * CAR_HW, pz = z + tz * f * CAR_HL + rz * r * CAR_HW;
    if (px < x0 || pz < z0 || px > x0 + nx * res || pz > z0 + nz * res) return -1;
    const c = clrAt(px, pz); if (c < m) m = c;
  }
  return m;
}
function heightDelta(x, z, tx, tz) {
  const rx = -tz, rz = tx;
  let lo = 1e9, hi = -1e9;
  for (const [f, r] of PROBES) {
    const px = x + tx * f * CAR_HL + rx * r * CAR_HW, pz = z + tz * f * CAR_HL + rz * r * CAR_HW;
    if (px < x0 || pz < z0 || px > x0 + nx * res || pz > z0 + nz * res) return 99;
    const h = heightAt(px, pz); if (h < lo) lo = h; if (h > hi) hi = h;
  }
  return hi - lo;
}
const MAXBODYSTEP = +(process.env.MAXBODYSTEP || 0.45);
let projected = 0;
function fit(x, z, tx, tz) { return bodyClr(x, z, tx, tz) >= MARGIN && heightDelta(x, z, tx, tz) <= MAXBODYSTEP; }
function project(x, z, tx, tz, maxR = 22) {
  if (fit(x, z, tx, tz)) return [x, z];
  projected++;
  const gx = Math.round((x - x0) / res), gz = Math.round((z - z0) / res);
  let best = [x, z], bestC = -99;
  for (let R = 0; R <= maxR; R++) {
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== R) continue;
      const px = x0 + (gx + dx) * res, pz = z0 + (gz + dz) * res;
      if (!fit(px, pz, tx, tz)) continue;
      const c = bodyClr(px, pz, tx, tz) - Math.hypot(dx, dz) * 0.08;   // prefer staying close
      if (c > bestC) { bestC = c; best = [px, pz]; }
    }
    if (bestC > -90 && R >= 2) break;
  }
  if (bestC <= -90) return [x, z];
  return best;
}
// resample the simplified trace, keeping a local tangent for each point
function tangentAt(i) {
  const a = dense[(i - 1 + dense.length) % dense.length], b = dense[(i + 1) % dense.length];
  const dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1;
  return [dx / L, dz / L];
}
function segFits(ax, az, bx, bz) {
  const L = Math.hypot(bx - ax, bz - az); if (L < 0.01) return true;
  const tx = (bx - ax) / L, tz = (bz - az) / L;
  const steps = Math.max(2, Math.ceil(L / 1.2));
  for (let s = 1; s < steps; s++) { const x = ax + tx * L * s / steps, z = az + tz * L * s / steps; if (!fit(x, z, tx, tz)) return false; }
  return true;
}
// Dead-end removal. The boundary of a region with thin fingers walks up a finger and back out
// again, which is a spur no car can race. A spur is a stretch of the outline that comes back
// close to where it left (within SPURCLOSE) after travelling much further than that -- cut
// straight across it whenever the car can drive the cut. Real lap corners never satisfy that.
function arcBetween(path, i, k) {
  let L = 0; const N2 = path.length;
  for (let q = 0; q < k; q++) { const u = path[(i + q) % N2], v = path[(i + q + 1) % N2]; L += Math.hypot(v[0] - u[0], v[1] - u[1]); }
  return L;
}
const SPURCLOSE = +(process.env.SPURCLOSE || 3.5);
const SPURMIN = +(process.env.SPURMIN || 9.0);
const SPURREACH = +(process.env.SPURREACH || 70);
function despur(path, rounds = 40) {
  let cuts = 0;
  for (let r = 0; r < rounds; r++) {
    const N2 = path.length; let done = false;
    for (let i = 0; i < N2 && !done; i++) {
      const a = path[i];
      for (let k = 4; k <= Math.min(SPURREACH, Math.floor(N2 / 2) - 1); k++) {
        const b = path[(i + k) % N2];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > SPURCLOSE) continue;
        const arc = arcBetween(path, i, k);
        if (arc < SPURMIN) continue;
        if (!segFits(a[0], a[1], b[0], b[1])) continue;
        // cut: keep a, drop the k-1 points in between, keep b onwards
        const keep = [];
        for (let q = 0; q < N2; q++) { const d = (q - i + N2) % N2; if (d > 0 && d < k) continue; keep.push(path[q]); }
        path = keep; cuts++; done = true; break;
      }
    }
    if (!done) break;
  }
  return [path, cuts];
}
let path = dense.map((p, i) => { const t = tangentAt(i); return project(p[0], p[1], t[0], t[1]); });
{
  const r = despur(path.slice());
  path = r[0];
  console.log(`spur removal: ${r[1]} cuts -> ${path.length} points`);
}

const SMOOTHPASS = +(process.env.SMOOTHPASS || 30);
for (let it = 0; it < SMOOTHPASS; it++) {
  const out = path.map((p) => p.slice());
  for (let i = 0; i < path.length; i++) {
    const a = path[(i - 1 + path.length) % path.length], b = path[(i + 1) % path.length];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const tx = path[i][0] + (mx - path[i][0]) * 0.45, tz = path[i][1] + (mz - path[i][1]) * 0.45;
    const before = bodyClr(path[i][0], path[i][1], dx, dz);
    const after = bodyClr(tx, tz, dx, dz);
    // A lap is not the outline of the room, it is the racing line inside it: the point is allowed
    // to cut the corner as long as the car still fits, which is what turns a boundary trace into
    // something worth driving.
    if (after >= Math.min(MARGIN + 0.25, before)) out[i] = [tx, tz];
  }
  path = out;
}
// final safety pass: any point that still does not fit gets pushed to the best nearby spot
for (let i = 0; i < path.length; i++) {
  const a = path[(i - 1 + path.length) % path.length], b = path[(i + 1) % path.length];
  let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  if (!fit(path[i][0], path[i][1], dx, dz)) path[i] = project(path[i][0], path[i][1], dx, dz);
}
// one last smoothing sweep so the repairs do not leave kinks, then re-check
for (let it = 0; it < 6; it++) {
  const out = path.map((p) => p.slice());
  for (let i = 0; i < path.length; i++) {
    const a = path[(i - 1 + path.length) % path.length], b = path[(i + 1) % path.length];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const tx = path[i][0] + (mx - path[i][0]) * 0.35, tz = path[i][1] + (mz - path[i][1]) * 0.35;
    const before = bodyClr(path[i][0], path[i][1], dx, dz);
    const after = bodyClr(tx, tz, dx, dz);
    if (after >= before - 0.02 && bodyClr(tx, tz, dx, dz) >= MARGIN) out[i] = [tx, tz];
  }
  path = out;
}
// metrics
let lapLen = 0, maxTurn = 0, totalTurn = 0;
for (let i = 0; i < path.length; i++) {
  const a = path[i], b = path[(i + 1) % path.length], c = path[(i + 2) % path.length];
  lapLen += Math.hypot(b[0] - a[0], b[1] - a[1]);
  const v1x = b[0] - a[0], v1z = b[1] - a[1], v2x = c[0] - b[0], v2z = c[1] - b[1];
  const ang = Math.atan2(v1x * v2z - v1z * v2x, v1x * v2x + v1z * v2z);
  maxTurn = Math.max(maxTurn, Math.abs(ang)); totalTurn += Math.abs(ang);
}
const cs = [], bods = [], hs = [];
for (let i = 0; i < path.length; i++) {
  const a = path[(i - 1 + path.length) % path.length], b = path[(i + 1) % path.length];
  let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  cs.push(clrAt(path[i][0], path[i][1]));
  bods.push(bodyClr(path[i][0], path[i][1], dx, dz));
  hs.push(heightAt(path[i][0], path[i][1]));
}
let maxStep = 0; for (let i = 0; i < hs.length; i++) maxStep = Math.max(maxStep, Math.abs(hs[(i + 1) % hs.length] - hs[i]));
const minBody = Math.min(...bods);
// the tightest corner on the lap decides how fast the lap can ever be (v = sqrt(a_lat * R))
let minRadius = 1e9;
for (let i = 0; i < path.length; i++) {
  const p0 = path[(i - 4 + path.length) % path.length], p1 = path[i], p2 = path[(i + 4) % path.length];
  const ax = p1[0] - p0[0], az = p1[1] - p0[1], bx = p2[0] - p1[0], bz = p2[1] - p1[1];
  const cross = ax * bz - az * bx, la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
  const k = Math.abs(2 * cross / (la * lb * lc || 1e-6));
  if (k > 1e-6) minRadius = Math.min(minRadius, 1 / k);
}
const vCorner = Math.sqrt(9.6 * minRadius) * 3.6;
const out = { pts: path, lapLen, minClr: Math.min(...cs), avgClr: cs.reduce((a, b) => a + b, 0) / cs.length, minBodyClr: minBody, maxStep, minRadius, res, src: 'perimloop', inset: INSET };
fs.writeFileSync('public/arena/circuit.json', JSON.stringify(out));
console.log(`LOOP: ${lapLen.toFixed(0)} m, ${path.length} pts, avgClr ${out.avgClr.toFixed(2)} m, minClr ${out.minClr.toFixed(2)} m, minBodyClr ${minBody.toFixed(2)} m (margin ${MARGIN}), maxStep ${maxStep.toFixed(2)} m, revs ${(totalTurn / (2 * Math.PI)).toFixed(2)}, worst turn ${(maxTurn * 57.3).toFixed(0)} deg, minR ${minRadius.toFixed(0)} m (${vCorner.toFixed(0)} km/h), projected ${projected}`);

// debug render
const SC = +(process.env.PPM || 3);
const W = Math.round(nx * res * SC), Hh = Math.round(nz * res * SC);
const img = newImage(W, Hh, [10, 12, 16]);
for (let gz = 0; gz < nz; gz++) for (let gx = 0; gx < nx; gx++) {
  const k = gz * nx + gx; if (!drv[k] && !B[k]) continue;
  const px = Math.round(gx * res * SC), py = Math.round(gz * res * SC);
  const c = B[k] ? [90, 34, 34] : (F[k] & 1) ? [86, 86, 96] : [38, 42, 50];
  for (let dy = 0; dy < SC; dy++) for (let dx = 0; dx < SC; dx++) setPx(img, px + dx, py + dy, c);
}
for (const c of members[big]) { const px = Math.round((c % nx) * res * SC), py = Math.round(((c - (c % nx)) / nx) * res * SC); setPx(img, px, py, [40, 110, 65]); }
for (const c of bestIns) { const px = Math.round((c % nx) * res * SC), py = Math.round(((c - (c % nx)) / nx) * res * SC); setPx(img, px, py, [60, 150, 90]); }
for (let i = 0; i < path.length; i++) { const a = path[i], b = path[(i + 1) % path.length];
  line(img, (a[0] - x0) / res * SC, (a[1] - z0) / res * SC, (b[0] - x0) / res * SC, (b[1] - z0) / res * SC, [255, 220, 60]); }
// start / finish marker
{ const a0 = path[0]; setPx(img, Math.round((a0[0] - x0) / res * SC), Math.round((a0[1] - z0) / res * SC), [255, 60, 60]); }
text(img, `${lapLen.toFixed(0)}M CLR ${out.avgClr.toFixed(1)}/${out.minClr.toFixed(1)} BODY ${minBody.toFixed(1)} STEP ${maxStep.toFixed(2)}`, 8, 8, [255, 255, 255], 2);
fs.writeFileSync(process.env.OUT || '/home/user/shots/perimloop.png', png(W, Hh, img.px));
console.log('wrote', process.env.OUT || '/home/user/shots/perimloop.png');
