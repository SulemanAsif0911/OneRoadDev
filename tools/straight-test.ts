import * as fs from 'node:fs';
import * as THREE from 'three';
import { Arena } from '../src/game/arena.ts';
import { CarSim, specFromCarJson, ASSIST_PRESETS } from '../src/game/physics.ts';
const base = 'public/arena/';
const meta = JSON.parse(fs.readFileSync(base + 'meta.json', 'utf8'));
const grid = fs.readFileSync(base + 'grid.bin');
const arena = new Arena(meta, grid.buffer.slice(grid.byteOffset, grid.byteOffset + grid.byteLength));
const circuit = JSON.parse(fs.readFileSync(base + 'circuit.json', 'utf8'));
const pts = circuit.pts as [number, number][];
// straightest 60 m of the circuit
// best straight: minimise total heading change over 20 points (all local, no chords)
let best = 0, bestScore = 1e9;
for (let i = 0; i < pts.length; i++) {
  let curv = 0;
  for (let k = 0; k < 20; k++) {
    const p0 = pts[(i + k) % pts.length], p1 = pts[(i + k + 1) % pts.length], p2 = pts[(i + k + 2) % pts.length];
    const v1x = p1[0] - p0[0], v1z = p1[1] - p0[1], v2x = p2[0] - p1[0], v2z = p2[1] - p1[1];
    curv += Math.abs(Math.atan2(v1x * v2z - v1z * v2x, v1x * v2x + v1z * v2z));
  }
  if (curv < bestScore) { bestScore = curv; best = i; }
}
console.log('straight from', pts[best], 'to', pts[(best + 20) % pts.length], 'curv(rad)', bestScore.toFixed(3));
// ground smoothness along it
let prevH = arena.heightAt(pts[best][0], pts[best][1]); let maxD = 0;
for (let k = 1; k <= 20; k++) {
  const p = pts[(best + k) % pts.length];
  const h = arena.heightAt(p[0], p[1]);
  maxD = Math.max(maxD, Math.abs(h - prevH));
  prevH = h;
}
console.log('max height step between circuit points (5.2m apart):', maxD.toFixed(3), 'm');

const carJson = JSON.parse(fs.readFileSync('public/cars/cars.json', 'utf8'));
const list = Array.isArray(carJson) ? carJson : carJson.cars;
const cj = list.find((c: any) => c.id === '2017_lamborghini_huracan_mansory');
console.log('car json:', JSON.stringify(cj));
const spec = specFromCarJson(cj);
const car = new CarSim(spec, ASSIST_PRESETS.arcade, { x: pts[best][0], z: pts[best][1], yaw: 0 });
const t0 = new THREE.Vector2(pts[(best + 3) % pts.length][0] - pts[best][0], pts[(best + 3) % pts.length][1] - pts[best][1]).normalize();
car.quat.setFromEuler(new THREE.Euler(0, Math.atan2(-t0.x, -t0.y), 0, 'YXZ'));
car.settle(arena);
console.log('start y', car.pos.y.toFixed(3));
const dt = 1 / 120;
for (let i = 0; i < 6 / dt; i++) {
  car.step(dt, { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false }, arena);
  if (i % 60 === 0) {
    console.log(`t=${(i * dt).toFixed(1)} v=${(car.vel.length() * 3.6).toFixed(0)} y=${car.pos.y.toFixed(3)} comp=${car.wheels.map(w => w.compression.toFixed(2)).join(',')} angVel=${car.angVel.toArray().map(v => v.toFixed(2)).join(',')} impact=${car.impactSpeed.toFixed(1)} wall=${car.wallContact.toFixed(2)}`);
  }
}
