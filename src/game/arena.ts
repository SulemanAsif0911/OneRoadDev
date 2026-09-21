/**
 * Arena — the frozen city.
 *
 * The map GLB is a diorama: it is scaled by META.metersPerUnit so a car is car-sized next to it.
 * Physics never touches the triangle soup. `tools/gen-arena.mjs` bakes the city into:
 *
 *   public/arena/grid.bin   1 m grid: int16 surface height (0.05 m steps), blocked byte, flags byte
 *   public/arena/props.json ~500 small colliders (lamp posts, planters, railings) that shatter
 *   public/arena/circuit.json  the racing line: one closed loop of world-space points
 *
 * `Arena` loads those once and answers the three questions physics asks every frame:
 * height under a point, is this point a wall, what props are near me.
 */
import * as THREE from 'three';

export type ArenaMeta = {
  src: string;
  metersPerUnit: number;
  res: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  nx: number;
  nz: number;
  quant: number;
};

export type Prop = { x: number; z: number; r: number; h: number; y: number; alive: boolean; hit: number };

export const FLAG_PAINTED = 1;
export const FLAG_STEEP = 2;
export const FLAG_TERRAIN = 4;
export const FLAG_OBSTACLE = 8;

const CLIFF_STEP = 0.55;      // a height difference bigger than this inside one cell is a cliff
const MAX_SLOPE = 0.85;       // ~40 degrees: the steepest ground the car is allowed to ride

export class Arena {
  meta: ArenaMeta;
  height: Float32Array;     // surface height per cell (NaN-ish -9999 = void)
  blocked: Uint8Array;      // solid structure
  flags: Uint8Array;
  props: Prop[] = [];
  circuit: { pts: [number, number][]; lapLen: number; minClr: number; avgClr: number } | null = null;

  // scratch
  private tmp = new Float32Array(4);

  constructor(meta: ArenaMeta, grid: ArrayBuffer) {
    this.meta = meta;
    const { nx, nz } = meta;
    const dv = new DataView(grid);
    this.height = new Float32Array(nx * nz);
    this.blocked = new Uint8Array(nx * nz);
    this.flags = new Uint8Array(nx * nz);
    for (let k = 0; k < nx * nz; k++) {
      this.height[k] = dv.getInt16(k * 4, true) * meta.quant;
      this.blocked[k] = dv.getUint8(k * 4 + 2);
      this.flags[k] = dv.getUint8(k * 4 + 3);
    }
  }

  get nx() { return this.meta.nx; }
  get nz() { return this.meta.nz; }
  get res() { return this.meta.res; }

  cellIndex(x: number, z: number) {
    const gx = Math.floor((x - this.meta.x0) / this.meta.res);
    const gz = Math.floor((z - this.meta.z0) / this.meta.res);
    if (gx < 0 || gz < 0 || gx >= this.meta.nx || gz >= this.meta.nz) return -1;
    return gz * this.meta.nx + gx;
  }

  /** true when a point can be occupied by a car (flat, not blocked, not steep) */
  isOpen(x: number, z: number) {
    const k = this.cellIndex(x, z);
    if (k < 0) return false;
    if (this.blocked[k]) return false;
    if (this.flags[k] & (FLAG_STEEP | FLAG_TERRAIN)) return false;
    if (this.height[k] < -900) return false;
    return true;
  }

  /** ground height with bilinear filtering; falls back to nearest valid cell */
  heightAt(x: number, z: number) {
    const { x0, z0, res, nx, nz } = this.meta;
    const fx = (x - x0) / res - 0.5;
    const fz = (z - z0) / res - 0.5;
    const x0i = Math.floor(fx), z0i = Math.floor(fz);
    const tx = fx - x0i, tz = fz - z0i;
    let acc = 0, wsum = 0;
    let hi = -1e9, lo = 1e9, bestW = -1, bestH = 0;
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= 1; i++) {
        const gx = x0i + i, gz = z0i + j;
        const w = (i ? tx : 1 - tx) * (j ? tz : 1 - tz);
        if (w <= 0) continue;
        if (gx < 0 || gz < 0 || gx >= nx || gz >= nz) continue;
        const h = this.height[gz * nx + gx];
        if (h < -900) continue;
        acc += h * w; wsum += w;
        if (h > hi) hi = h;
        if (h < lo) lo = h;
        if (w > bestW) { bestW = w; bestH = h; }
      }
    }
    if (wsum > 0.001) {
      // A 1 m cell that holds a cliff (a kerb, a stair, the base of a building) must stay a cliff:
      // blending the two levels together invents a ramp that the car can drive up, which looks
      // wrong and launches it. Where the neighbours disagree, take the nearest cell's height.
      if (hi - lo > CLIFF_STEP) return bestH;
      return acc / wsum;
    }
    // nearest valid cell (a few rings)
    const gx = Math.round((x - x0) / res), gz = Math.round((z - z0) / res);
    for (let r = 0; r < 12; r++) {
      let best = -1e9, bestD = 1e9;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const a = gx + dx, b = gz + dz;
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const h = this.height[b * nx + a];
        if (h < -900) continue;
        const d = Math.hypot(dx, dz);
        if (d < bestD) { bestD = d; best = h; }
      }
      if (best > -1e8) return best;
    }
    return 0;
  }

  /** approximate surface normal by central differences */
  normalAt(x: number, z: number, out = new THREE.Vector3()) {
    const d = this.meta.res * 0.5;
    const hL = this.heightAt(x - d, z), hR = this.heightAt(x + d, z);
    const hD = this.heightAt(x, z - d), hU = this.heightAt(x, z + d);
    out.set(hL - hR, 2 * d, hD - hU);
    // Surfaces steeper than the steepest ramp a car can drive are walls: they push sideways
    // (solidAt) and must not tip the chassis or feed the suspension a vertical normal.
    const slope = Math.hypot(out.x, out.z) / (2 * d);
    if (slope > MAX_SLOPE) { const k = MAX_SLOPE / slope; out.x *= k; out.z *= k; }
    out.y = 2 * d;
    return out.normalize();
  }

  /** how deep a point is inside solid geometry (0 = free) */
  solidAt(x: number, z: number) {
    const k = this.cellIndex(x, z);
    if (k < 0) return 2;                          // outside the baked world: treat as solid
    if (this.blocked[k]) return 1;
    if (this.flags[k] & (FLAG_STEEP | FLAG_TERRAIN)) return 0.6;
    if (this.height[k] < -900) return 1;
    return 0;
  }

  /** collision test for a circle (car body). Returns push vector or null. */
  circleVsWorld(x: number, z: number, radius: number, out = new THREE.Vector2()) {
    const { res } = this.meta;
    const n = Math.max(6, Math.ceil((radius * 2.4) / res));
    let pushX = 0, pushZ = 0, hits = 0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * radius, pz = z + Math.sin(a) * radius;
      const k = this.cellIndex(px, pz);
      if (k < 0) {
        // outside: push back toward the world centre-ish
        pushX -= Math.cos(a); pushZ -= Math.sin(a); hits++;
        continue;
      }
      if (this.blocked[k]) {
        // push along the axis from cell centre to the sample point
        pushX += Math.cos(a); pushZ += Math.sin(a); hits++;
      } else if ((this.flags[k] & (FLAG_TERRAIN | FLAG_STEEP)) && !this.isOpen(x, z)) {
        pushX += Math.cos(a) * 0.7; pushZ += Math.sin(a) * 0.7; hits++;
      }
    }
    if (!hits) return null;
    const len = Math.hypot(pushX, pushZ) || 1;
    out.set((pushX / len), (pushZ / len));
    return out;
  }

  /** step-along wall probe: returns the first blocked sample distance along a segment */
  rayHit(x0: number, z0: number, x1: number, z1: number, steps = 6) {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      if (this.solidAt(x, z) >= 1) return { x, z, t };
    }
    return null;
  }

  propsNear(x: number, z: number, radius: number, out: Prop[] = []) {
    out.length = 0;
    for (const p of this.props) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < radius + p.r) out.push(p);
    }
    return out;
  }

  /** resolve prop hits: strong hits knock them out, weak hits slow the car */
  strikeProp(p: Prop, speed: number) {
    p.alive = false;
    p.hit = speed;
  }

  // --- circuit helpers -------------------------------------------------------
  get circuitPts() { return this.circuit?.pts ?? []; }

  nearestCircuitIndex(x: number, z: number, hint = -1) {
    const pts = this.circuitPts;
    const n = pts.length;
    if (!n) return 0;
    let best = 0, bd = Infinity;
    if (hint >= 0) {
      for (let k = -20; k <= 20; k++) {
        const i = (hint + k + n) % n;
        const d = (pts[i][0] - x) ** 2 + (pts[i][1] - z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      if (bd < 2500) return best;
      bd = Infinity;
    }
    for (let i = 0; i < n; i++) {
      const d = (pts[i][0] - x) ** 2 + (pts[i][1] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  circuitTangent(i: number, out = new THREE.Vector2()) {
    const pts = this.circuitPts; const n = pts.length;
    if (!n) return out.set(0, -1);
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    out.set(b[0] - a[0], b[1] - a[1]);
    if (out.lengthSq() < 1e-9) out.set(0, -1);
    return out.normalize();
  }
}

/** Loads every baked asset. Called once at boot behind the loading screen. */
export async function loadArena(base = ''): Promise<Arena> {
  const [metaRes, gridRes, propsRes, circuitRes] = await Promise.all([
    fetch(`${base}/arena/meta.json`),
    fetch(`${base}/arena/grid.bin`),
    fetch(`${base}/arena/props.json`),
    fetch(`${base}/arena/circuit.json`),
  ]);
  if (!metaRes.ok || !gridRes.ok) throw new Error('arena assets missing — run `npm run bake`');
  const meta = (await metaRes.json()) as ArenaMeta;
  const grid = await gridRes.arrayBuffer();
  const arena = new Arena(meta, grid);
  if (propsRes.ok) {
    const raw = (await propsRes.json()) as number[][];
    arena.props = raw.map((p) => ({ x: p[0], z: p[1], r: p[2], h: p[3], y: p[4], alive: true, hit: 0 }));
  }
  if (circuitRes.ok) {
    const c = await circuitRes.json();
    arena.circuit = { pts: c.pts, lapLen: c.lapLen, minClr: c.minClr, avgClr: c.avgClr };
  }
  return arena;
}
