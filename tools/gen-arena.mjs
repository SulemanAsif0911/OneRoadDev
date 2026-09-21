/**
 * CyberKhyal arena baker.
 * Reads the map GLB and produces runtime assets:
 *   public/arena/grid.bin  - int16 height field (world meters, 0.05m quantization) + flags
 *   public/arena/meta.json - grid geometry + world transform
 * Surface = the largest near-flat surface in a cell; blocked = geometry >1.1m above it.
 * Run:  node tools/gen-arena.mjs <map.glb> <metersPerModelUnit>
 */
import fs from 'fs';
import path from 'path';
import { loadGLB, readAccessor, buildScene, xf } from './glb.mjs';

const FILE = process.argv[2] || 'sports_car_racing_moscow.glb';
const S = +(process.argv[3] || 14);           // world meters per model unit
const RES = 1.0;                              // world meters per cell
const CROP_W = (process.env.CROP || '-150,170,-120,180').split(',').map(Number); // world coords x0,x1,z0,z1
const OBSTACLE_H = +(process.env.OBST || 2.0);  // meters above surface => blocked
const PROP_MAX = +(process.env.PROPMAX || 2.6);
const PROP_MIN = +(process.env.PROPMIN || 0.7);
const FLAT_NY = 0.72;                          // |normal.y| for "flat enough to drive"

const d = loadGLB(FILE);
const { g, world } = buildScene(d);
const NX = Math.round((CROP_W[1] - CROP_W[0]) / RES), NZ = Math.round((CROP_W[3] - CROP_W[2]) / RES);
const cx = (wx) => (wx - CROP_W[0]) / RES, cz = (wz) => (wz - CROP_W[2]) / RES;

// per-cell: histogram of flat-surface heights (quantized 0.25m), max top, painted, min
const NH = 240;                               // 0.25m bins over -30..30m
const hist = new Map();                       // cell -> Uint16Array(NH)
const maxTop = new Float32Array(NX * NZ).fill(-1e9);
const minTop = new Float32Array(NX * NZ).fill(1e9);
const slopeSum = new Float32Array(NX * NZ), slopeMax = new Float32Array(NX * NZ), slopeCnt = new Float32Array(NX * NZ);
const props = [];   // [x, z, radius, height] cylinders for car collision (lamp posts, planters, railings)
const painted = new Uint8Array(NX * NZ);
const grp = new Array(NX * NZ).fill(null);
const groupName = {};
(function walk(i, cur) { const n = g.nodes[i]; let c2 = cur; if (['Big', 'Midterm', 'Small', 'road'].includes(n.name)) c2 = n.name; groupName[i] = c2; for (const ch of n.children || []) walk(ch, c2); })(g.scenes[g.scene || 0].nodes[0], 'other');

const BIN0 = -30, BINW = 0.25;
function addHist(k, y) {
  const b = Math.round((y - BIN0) / BINW);
  if (b < 0 || b >= NH) return;
  let a = hist.get(k); if (!a) { a = new Uint16Array(NH); hist.set(k, a); }
  if (a[b] < 65000) a[b] += 1;
}
let tris = 0;
for (let i = 0; i < g.nodes.length; i++) {
  const n = g.nodes[i]; if (n.mesh === undefined) continue;
  const gm = groupName[i] || 'other';
  for (const p of g.meshes[n.mesh].primitives) {
    const pos = readAccessor(d, p.attributes.POSITION), idx = p.indices !== undefined ? readAccessor(d, p.indices) : null;
    // collect a prop collider for small standalone objects (>=0.7m tall, footprint < 25 m2)
    {
      const a2 = g.accessors[p.attributes.POSITION];
      if (a2.min && a2.max) {
        const Mn = world[i];
        let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
        for (let c = 0; c < 8; c++) { const q = xf(Mn, [(c & 1 ? a2.max : a2.min)[0], (c & 2 ? a2.max : a2.min)[1], (c & 4 ? a2.max : a2.min)[2]]);
          for (let k2 = 0; k2 < 3; k2++) { mn[k2] = Math.min(mn[k2], q[k2] * S); mx[k2] = Math.max(mx[k2], q[k2] * S); } }
        const w = mx[0] - mn[0], dd = mx[2] - mn[2], h = mx[1] - mn[1];
        const areaF = w * dd;
        const thin = Math.min(w, dd) < 1.6;
        if (h >= PROP_MIN && areaF < 25 && h > 0.4 && (h <= PROP_MAX || thin) && !/peilou|huanjing|jiaotang/.test(n.name || '')) {
          props.push([+((mn[0] + mx[0]) / 2).toFixed(2), +((mn[2] + mx[2]) / 2).toFixed(2), +(Math.max(w, dd) * 0.45).toFixed(2), +h.toFixed(2), +mn[1].toFixed(2), +(n.name || '').slice(0, 20)]);
        }
      }
    }
    const M = world[i]; const Wp = new Float32Array(pos.length);
    for (let v = 0; v < pos.length / 3; v++) { const q = xf(M, [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]); Wp[v * 3] = q[0] * S; Wp[v * 3 + 1] = q[1] * S; Wp[v * 3 + 2] = q[2] * S; }
    const cnt = idx ? idx.length : pos.length / 3;
    for (let t = 0; t < cnt; t += 3) {
      const ia = idx ? idx[t] : t, ib = idx ? idx[t + 1] : t + 1, ic = idx ? idx[t + 2] : t + 2;
      const A = [Wp[ia * 3], Wp[ia * 3 + 1], Wp[ia * 3 + 2]], B = [Wp[ib * 3], Wp[ib * 3 + 1], Wp[ib * 3 + 2]], C = [Wp[ic * 3], Wp[ic * 3 + 1], Wp[ic * 3 + 2]];
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const nl = Math.hypot(nx, ny, nz) || 1; ny /= nl;
      const ymaxT = Math.max(A[1], B[1], C[1]), yminT = Math.min(A[1], B[1], C[1]);
      const P = [A, B, C].map(p => [cx(p[0]), cz(p[2])]);
      const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]))), x1 = Math.min(NX - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]))), y1 = Math.min(NZ - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
      const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
      if (Math.abs(area) < 1e-9) continue;
      tris++;
      const flat = Math.abs(ny) > FLAT_NY;
      const slope = Math.acos(Math.min(1, Math.abs(ny))) * 180 / Math.PI;
      for (let zz = y0; zz <= y1; zz++) for (let xx = x0; xx <= x1; xx++) {
        const w0 = ((P[1][0] - P[0][0]) * (zz + 0.5 - P[0][1]) - (xx + 0.5 - P[0][0]) * (P[1][1] - P[0][1])) / area;
        const w1 = ((xx + 0.5 - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (zz + 0.5 - P[0][1])) / area;
        const w2 = 1 - w0 - w1; if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
        const k = zz * NX + xx; const y = A[1] * w2 + B[1] * w1 + C[1] * w0;
        if (ymaxT > maxTop[k]) { maxTop[k] = ymaxT; grp[k] = gm + '|' + (n.name || '').slice(0, 24); }
        if (yminT < minTop[k]) minTop[k] = yminT;
        slopeSum[k] += slope; slopeCnt[k] += 1; slopeMax[k] = Math.max(slopeMax[k], slope);
        if (flat) { addHist(k, y); if (gm === 'road') painted[k] = 1; }
      }
    }
  }
}
console.log(`rasterized ${tris} triangles into ${NX}x${NZ} = ${(NX * NZ / 1000).toFixed(0)}k cells`);

// choose surface height per cell
const height = new Float32Array(NX * NZ).fill(-9999);
const blocked = new Uint8Array(NX * NZ);
const flags = new Uint8Array(NX * NZ);   // bit0 painted, bit1 steep, bit2 noFlat(terrain), bit3 obstacle
let stats = { flat: 0, terrain: 0, blocked: 0, painted: 0, steep: 0 };
for (let k = 0; k < NX * NZ; k++) {
  const a = hist.get(k);
  let surf = -9999, surfBin = -1, bestArea = 0, flatTotal = 0;
  if (a) {
    // smooth histogram lightly and take the dominant bin
    let best = 0;
    for (let b = 1; b < NH - 1; b++) { const v = a[b] * 2 + a[b - 1] + a[b + 1]; if (v > best) { best = v; surfBin = b; } }
    bestArea = best; flatTotal = a.reduce((s, v) => s + v, 0);
    // refine: weighted mean of neighbouring bins
    let num = 0, den = 0;
    for (let b = Math.max(0, surfBin - 2); b <= Math.min(NH - 1, surfBin + 2); b++) { num += a[b] * (BIN0 + (b + 0.5) * BINW); den += a[b]; }
    surf = den > 0 ? num / den : BIN0 + (surfBin + 0.5) * BINW;
    stats.flat++;
  }
  if (surf < -9000) { // no flat surface -> terrain
    if (maxTop[k] > -1e8) { surf = maxTop[k]; flags[k] |= 4; stats.terrain++; } else { height[k] = -9999; continue; }
  }
  height[k] = surf;
  const hi = Math.max(maxTop[k] > -1e8 ? maxTop[k] : surf, minTop[k] > -1e8 ? minTop[k] : surf);
  if (hi - surf > OBSTACLE_H) { blocked[k] = 1; flags[k] |= 8; stats.blocked++; }
  const sl = slopeCnt[k] > 0 ? slopeMax[k] : 0;
  if (sl > 40) { flags[k] |= 2; stats.steep++; }
  if (painted[k]) { flags[k] |= 1; stats.painted++; }
}
console.log('cells:', stats);

// --- drive-surface opening ----------------------------------------------------
// Trees, planters, benches, kiosks and lamp heads are wide enough to be picked as the
// "dominant flat surface" of a cell, which would put 6 m tree canopies in the middle of a
// street. A morphological opening of the height field (erode = min, then dilate = max, disc
// radius HOPEN) removes everything narrower than the structuring element, so the drive surface
// becomes the actual ground. Raised objects are then re-marked as blocked below, which keeps
// the collision honest while the car stays on the road *level* next to them.
const HOPEN = +(process.env.HOPEN || 2);
{
  const spread = (src, pick) => {
    const out = new Float32Array(NX * NZ);
    for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
      const k = z * NX + x; let v = src[k], got = src[k] > -900;
      for (let dz = -HOPEN; dz <= HOPEN; dz++) for (let dx = -HOPEN; dx <= HOPEN; dx++) {
        if (dx * dx + dz * dz > HOPEN * HOPEN) continue;
        const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= NX || b >= NZ) continue;
        const w = src[b * NX + a]; if (w < -900) continue;
        if (!got) { v = w; got = true; } else v = pick(v, w);
      }
      out[k] = got ? v : -9999;
    }
    return out;
  };
  const er = spread(height, Math.min);
  const di = spread(er, Math.max);
  let raised = 0;
  for (let k = 0; k < NX * NZ; k++) {
    if (height[k] < -900) continue;
    if (di[k] > -900 && height[k] - di[k] > 0.01) { height[k] = di[k]; raised++; }
  }
  console.log(`height opening r=${HOPEN}m lowered ${raised} cells (trees/props removed from the drive surface)`);
  // rebuild blocked + steep from the cleaned drive surface
  for (let k = 0; k < NX * NZ; k++) {
    if (height[k] < -900) continue;
    const hi = Math.max(maxTop[k] > -1e8 ? maxTop[k] : height[k], minTop[k] > -1e8 ? minTop[k] : height[k]);
    blocked[k] = hi - height[k] > OBSTACLE_H ? 1 : 0;
    if (blocked[k]) flags[k] |= 8; else flags[k] &= ~8;
  }
  // steepness from the drive surface gradient (40% = tan(21.8 deg))
  for (let z = 1; z < NZ - 1; z++) for (let x = 1; x < NX - 1; x++) {
    const k = z * NX + x; if (height[k] < -900) continue;
    const hL = height[k - 1], hR = height[k + 1], hD = height[k - NX], hU = height[k + NX];
    let g = 0;
    if (hL > -900 && hR > -900) g = Math.max(g, Math.abs(hR - hL) / (2 * RES));
    if (hD > -900 && hU > -900) g = Math.max(g, Math.abs(hU - hD) / (2 * RES));
    if (g > 0.4) flags[k] |= 2; else flags[k] &= ~2;
  }
}

// --- morphological opening on the raw-blocked mask -----------------------------
// Thin tall objects (lamp posts, signposts, columns, planters) must NOT seal a street:
// they are handled as circle colliders in the physics instead. We open the blocked mask
// with a disc of radius OPEN_R, which keeps real structures and removes slivers.
const OPEN_R = +(process.env.OPEN_R || 2);
const rawTall = blocked.slice();
{
  const er = new Uint8Array(NX * NZ);
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    const k = z * NX + x; if (!rawTall[k]) continue;
    let ok = 1;
    for (let dz = -OPEN_R; dz <= OPEN_R && ok; dz++) for (let dx = -OPEN_R; dx <= OPEN_R; dx++) {
      if (dx * dx + dz * dz > OPEN_R * OPEN_R) continue;
      const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= NX || b >= NZ) { ok = 0; break; }
      if (!rawTall[b * NX + a]) { ok = 0; break; }
    }
    er[k] = ok;
  }
  const di = new Uint8Array(NX * NZ);
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    let any = 0;
    for (let dz = -OPEN_R; dz <= OPEN_R && !any; dz++) for (let dx = -OPEN_R; dx <= OPEN_R; dx++) {
      if (dx * dx + dz * dz > OPEN_R * OPEN_R) continue;
      const a = x + dx, b = z + dz; if (a < 0 || b < 0 || a >= NX || b >= NZ) continue;
      if (er[b * NX + a]) { any = 1; break; }
    }
    di[z * NX + x] = any;
  }
  let removed = 0;
  for (let k = 0; k < NX * NZ; k++) { if (rawTall[k] && !di[k]) removed++; blocked[k] = di[k]; }
  console.log(`opening r=${OPEN_R}m removed ${removed} blocked cells (props now passable, see props.json)`);
}
// fill tiny holes in blocked mask (morphological close) to avoid single-cell snags
const bl2 = blocked.slice();
for (let z = 1; z < NZ - 1; z++) for (let x = 1; x < NX - 1; x++) {
  const k = z * NX + x;
  let n = blocked[k - 1] + blocked[k + 1] + blocked[k - NX] + blocked[k + NX];
  if (!blocked[k] && n >= 3) bl2[k] = 1;
}
for (let k = 0; k < NX * NZ; k++) blocked[k] = bl2[k];

const outDir = path.join('public', 'arena');
fs.mkdirSync(outDir, { recursive: true });
const buf = Buffer.alloc(NX * NZ * 4);
for (let k = 0; k < NX * NZ; k++) {
  const q = Math.max(-32000, Math.min(32000, Math.round(height[k] * 20)));   // 0.05 m
  buf.writeInt16LE(q, k * 4);
  buf.writeUInt8(blocked[k] ? 1 : 0, k * 4 + 2);
  buf.writeUInt8(flags[k], k * 4 + 3);
}
fs.writeFileSync(path.join(outDir, 'grid.bin'), buf);
fs.writeFileSync(path.join(outDir, 'props.json'), JSON.stringify(props.map(p => [p[0], p[1], p[2], p[3], p[4]])));
console.log('prop colliders:', props.length);
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
  src: path.basename(FILE), metersPerUnit: S, res: RES,
  x0: CROP_W[0], z0: CROP_W[2], x1: CROP_W[1], z1: CROP_W[3], nx: NX, nz: NZ,
  quant: 0.05, generated: new Date().toISOString(),
}, null, 2));
console.log('wrote', path.join(outDir, 'grid.bin'), (buf.length / 1024).toFixed(0) + 'KB', 'and meta.json');
