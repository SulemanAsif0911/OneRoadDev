/**
 * Bakes public/cars/cars.json: per-car metrics + wheel rig detection.
 * Metrics: real-world size, wheel radius/wheelbase/track, ground offset, forward axis.
 * Wheels: named rig if present, otherwise geometric detection of the 4 corner wheels.
 */
import fs from 'fs';
import path from 'path';
import { loadGLB, readAccessor, buildScene, xf } from './glb.mjs';

const CARS = [
  ['1988_lamborghini_countach.glb', 'Countach 25th', '1988 Lamborghini Countach', 'A'],
  ['1988_bmw_m3_evolution_ii_e30_1.glb', 'M3 E30 Evo II', '1988 BMW M3 Evolution II', 'B'],
  ['2001_bmw_m3_gtr.glb', 'M3 GTR', '2001 BMW M3 GTR', 'A'],
  ['2013_mansory_carbonado_lamborghini_aventador.glb', 'Aventador Carbonado', '2013 Mansory Carbonado Aventador', 'S'],
  ['2017_lamborghini_huracan_mansory.glb', 'Huracán Mansory', '2017 Lamborghini Huracán', 'S'],
  ['2019_mansory_venatus_lamborghini_urus.glb', 'Urus Venatus', '2019 Mansory Venatus Urus', 'B'],
  ['rolls-royce_2020_mansory_wraith.glb', 'Wraith Mansory', '2020 Mansory Wraith', 'C'],
  ['rolls_royce_ghost.glb', 'Ghost', 'Rolls-Royce Ghost', 'C'],
  ['rollsroyce_phantom.glb', 'Phantom', 'Rolls-Royce Phantom', 'C'],
];
// real-world length targets per class so cars are correctly scaled relative to each other
const CLASS_LEN = { S: 4.6, A: 4.5, B: 4.8, C: 5.6 };

const out = [];
for (const [file, label, full, klass] of CARS) {
  const d = loadGLB(file); const { g, world, info, sub, parentOf } = buildScene(d);
  // whole-model bounds
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const o of info) { if (!o.mn) continue; for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], o.mn[k]); mx[k] = Math.max(mx[k], o.mx[k]); } }
  // wheel nodes: outermost nodes matching wheel-ish names, else geometric cluster detection
  const isDesc = (a, b) => { let cur = a; while (cur !== undefined) { if (cur === b) return true; cur = parentOf[cur]; } return false; };
  const matched = [];
  for (let i = 0; i < g.nodes.length; i++) {
    const nm = g.nodes[i].name || '';
    if (/3DWheel\s*(Front|Rear)?\s*[LR]?\s*$|^3DWheel|wheel_?fl|wheel_?fr|wheel_?rl|wheel_?rr|wheelfl|wheelfr|wheelrl|wheelrr/i.test(nm)) matched.push(i);
  }
  let wheelNodes = matched.filter(i => !matched.some(j => j !== i && isDesc(i, j)));
  let wheelInfo = wheelNodes.map(i => ({ i, name: g.nodes[i].name, c: sub[i] ? [(sub[i][0] + sub[i][3]) / 2, (sub[i][1] + sub[i][4]) / 2, (sub[i][2] + sub[i][5]) / 2] : null })).filter(w => w.c);
  let detected = 'name';
  if (wheelInfo.length !== 4) {
    // geometric: candidate meshes that are wheel-ish (round-ish, in lower half, near a corner)
    const cands = [];
    const H = mx[1] - mn[1], L = mx[2] - mn[2], W = mx[0] - mn[0];
    for (let i = 0; i < g.nodes.length; i++) {
      const o = info[i]; if (!o.mn || o.tris < 200) continue;
      const sx = o.mx[0] - o.mn[0], sy = o.mx[1] - o.mn[1], sz = o.mx[2] - o.mn[2];
      const cz = (o.mn[2] + o.mx[2]) / 2, cy = (o.mn[1] + o.mx[1]) / 2, cx2 = (o.mn[0] + o.mx[0]) / 2;
      const maxXZ = Math.max(sx, sz), minXZ = Math.min(sx, sz);
      // wheel: roughly as tall as long, thin in one axis, low, outboard, near front/rear
      if (sy > 0.008 && sy < 0.6 * H && maxXZ < 0.55 * Math.max(L, W) && minXZ > 0.02 * Math.max(L, W)) {
        const low = (cy - mn[1]) / (H || 1);
        const outboard = Math.abs(cx2 - (mn[0] + mx[0]) / 2) / (W || 1);
        const fore = Math.abs(cz - (mn[2] + mx[2]) / 2) / (L || 1);
        if (low < 0.45 && outboard > 0.15 && fore > 0.2) cands.push({ i, score: o.tris * (1 - low), low, outboard, fore, c: [cx2, cy, cz], sy, maxXZ });
      }
    }
    // pick 4 clusters: quadrant representatives with best score
    const quads = { FL: null, FR: null, RL: null, RR: null };
    for (const c of cands) {
      const key = (c.c[2] > (mn[2] + mx[2]) / 2 ? 'F' : 'R') + (c.c[0] > (mn[0] + mx[0]) / 2 ? 'R' : 'L');
      if (!quads[key] || c.score > quads[key].score) quads[key] = c;
    }
    wheelInfo = Object.entries(quads).filter(([, v]) => v).map(([k, v]) => ({ i: v.i, name: g.nodes[v.i].name, q: k, c: v.c, sub: sub[v.i] }));
    for (const w of wheelInfo) w.name = (w.name || '') + '#' + w.q;
    wheelNodes = wheelInfo.map(w => w.i);
    detected = wheelInfo.length === 4 ? 'geometric' : `partial(${wheelInfo.length})`;
  }
  // order wheels: front = smaller z (models face -Z), left = negative x
  const ctr = { x: (mn[0] + mx[0]) / 2, z: (mn[2] + mx[2]) / 2 };
  const wheels = wheelInfo.map(w => ({ node: w.name || g.nodes[w.i].name, i: w.i, x: w.c[0], y: w.c[1], z: w.c[2] }))
    .sort((a, b) => (a.z - b.z) || (a.x - b.x));
  let rig = null;
  if (wheels.length === 4) {
    const frontZ = (wheels[0].z + wheels[1].z) / 2, rearZ = (wheels[2].z + wheels[3].z) / 2;
    const leftX = (wheels[0].x + wheels[2].x) / 2, rightX = (wheels[1].x + wheels[3].x) / 2;
    // wheel radius from the wheel subtree's vertical extent
    const rad = wheels.map(w => { const s = sub[w.i]; return s ? (s[4] - s[1]) / 2 : 0.1; });
    rig = {
      fl: wheels[0].node, fr: wheels[1].node, rl: wheels[2].node, rr: wheels[3].node,
      frontZ: +frontZ.toFixed(4), rearZ: +rearZ.toFixed(4), leftX: +leftX.toFixed(4), rightX: +rightX.toFixed(4),
      radius: +((rad[0] + rad[1] + rad[2] + rad[3]) / 4).toFixed(4),
    };
  }
  const length = mx[2] - mn[2];
  const widthU = mx[0] - mn[0];
  const scaleToReal = CLASS_LEN[klass] / length;      // model units -> meters
  // wheel base / track / radius: prefer rig values, fall back to class-typical proportions
  const fallbackWB = CLASS_LEN[klass] * 0.585, fallbackTrack = widthU * scaleToReal * 0.84, fallbackR = CLASS_LEN[klass] * 0.072;
  let wheelBase = fallbackWB, trackWidth = fallbackTrack, wheelRadius = fallbackR, wheelCenters = null, rigTrust = 'fallback';
  if (rig) {
    const wb = Math.abs(rig.rearZ - rig.frontZ) * scaleToReal, tr = Math.abs(rig.rightX - rig.leftX) * scaleToReal, rr = Math.abs(rig.radius * scaleToReal);
    if (wb > CLASS_LEN[klass] * 0.35 && wb < CLASS_LEN[klass] * 0.78) { wheelBase = wb; rigTrust = 'rig'; }
    if (tr > widthU * scaleToReal * 0.45 && tr < widthU * scaleToReal * 1.25) trackWidth = tr;
    if (rr > CLASS_LEN[klass] * 0.045 && rr < CLASS_LEN[klass] * 0.14) wheelRadius = rr;
    wheelCenters = { fl: wheels[0], fr: wheels[1], rl: wheels[2], rr: wheels[3] };
  }
  const rec = {
    id: file.replace(/\.glb$/, ''), label, fullName: full, klass, file,
    model: { min: mn.map(v => +v.toFixed(4)), max: mx.map(v => +v.toFixed(4)), size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]].map(v => +v.toFixed(4)) },
    realLength: CLASS_LEN[klass], realWidth: +((mx[0] - mn[0]) * scaleToReal).toFixed(3), realHeight: +((mx[1] - mn[1]) * scaleToReal).toFixed(3),
    unitsPerMeter: +(1 / scaleToReal).toFixed(4),
    widthScale: 1,
    wheelBase: +wheelBase.toFixed(3),
    trackWidth: +trackWidth.toFixed(3),
    wheelRadius: +wheelRadius.toFixed(3),
    rig, rigSource: detected, rigTrust,
    wheelCenters: wheelCenters ? { fl: wheelCenters.fl ? [wheelCenters.fl.x, wheelCenters.fl.y, wheelCenters.fl.z] : null,
      fr: wheelCenters.fr ? [wheelCenters.fr.x, wheelCenters.fr.y, wheelCenters.fr.z] : null,
      rl: wheelCenters.rl ? [wheelCenters.rl.x, wheelCenters.rl.y, wheelCenters.rl.z] : null,
      rr: wheelCenters.rr ? [wheelCenters.rr.x, wheelCenters.rr.y, wheelCenters.rr.z] : null } : null,
    groundY: +mn[1].toFixed(4),   // model-space y of the ground contact
    facesForwardNegZ: true,
    yawOffsetDeg: 0,
  };
  // sanity: wheelbase/2 must fit inside the car
  if (rec.wheelBase > rec.realLength * 0.85) rec.wheelBase = +(rec.realLength * 0.6).toFixed(3);
  out.push(rec);
  console.log(`${label.padEnd(20)} len=${rec.realLength} w=${rec.realWidth} h=${rec.realHeight} wb=${rec.wheelBase}(${rigTrust}) trk=${rec.trackWidth} r=${rec.wheelRadius} rig=${detected} centers=${wheelCenters ? JSON.stringify(wheelCenters.fl && wheelCenters.fl.c ? wheelCenters.fl.c.map(v => +v.toFixed(3)) : null) : 'none'}`);
}
fs.mkdirSync(path.join('public', 'cars'), { recursive: true });
fs.writeFileSync(path.join('public', 'cars', 'cars.json'), JSON.stringify(out, null, 1));
console.log('wrote public/cars/cars.json');
