import * as fs from 'node:fs';
import * as THREE from 'three';
import { Arena } from '../src/game/arena.ts';
import { CarSim, specFromCarJson, ASSIST_PRESETS } from '../src/game/physics.ts';
const base = 'public/arena/';
const meta = JSON.parse(fs.readFileSync(base + 'meta.json', 'utf8'));
const grid = fs.readFileSync(base + 'grid.bin');
const arena = new Arena(meta, grid.buffer.slice(grid.byteOffset, grid.byteOffset + grid.byteLength));
const circuit = JSON.parse(fs.readFileSync(base + 'circuit.json', 'utf8'));
const pts = circuit.pts as [number, number][]; const N = pts.length;
const carJson = JSON.parse(fs.readFileSync('public/cars/cars.json', 'utf8'));
const list = Array.isArray(carJson) ? carJson : carJson.cars;
const spec = specFromCarJson(list.find((c: any) => c.id === '2017_lamborghini_huracan_mansory'));
const car = new CarSim(spec, ASSIST_PRESETS.sport, { x: pts[0][0], z: pts[0][1], yaw: 0 });
car.settle(arena);
const dt = 1 / 120;
let stuckFor = 0;
for (let step = 0; step < 60 / dt; step++) {
  // drive straight along +X for a while then straight ahead: just full throttle straight
  car.step(dt, { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false }, arena);
  if (car.vel.length() < 1) stuckFor += dt; else stuckFor = 0;
  if (stuckFor > 2) {
    console.log(`STUCK at t=${(step * dt).toFixed(1)} pos=(${car.pos.x.toFixed(1)},${car.pos.z.toFixed(1)}) y=${car.pos.y.toFixed(2)} yawState=${car.angVel.toArray().map(v => v.toFixed(2))}`);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(car.quat);
    console.log(`fwd=(${fwd.x.toFixed(2)},${fwd.z.toFixed(2)}) vel=(${car.vel.x.toFixed(2)},${car.vel.z.toFixed(2)}) wall=${car.wallContact.toFixed(2)}`);
    console.log('wheels:', car.wheels.map((w) => `g${w.grounded ? 1 : 0} c${w.compression.toFixed(2)} k${w.slipRatio.toFixed(2)} L${(w.load / 1000).toFixed(1)}`).join(' '));
    const gx = Math.round((car.pos.x - meta.x0) / meta.res), gz = Math.round((car.pos.z - meta.z0) / meta.res);
    let s = '';
    for (let dz = -6; dz <= 6; dz++) {
      let row = '';
      for (let dx = -6; dx <= 6; dx++) {
        const k = (gz + dz) * meta.nx + (gx + dx);
        const solid = arena.solidAt(meta.x0 + (gx + dx) * meta.res, meta.z0 + (gz + dz) * meta.res);
        row += solid > 1.5 ? '#' : solid > 0.9 ? '@' : solid > 0.5 ? '~' : '.';
      }
      s += `${(meta.z0 + (gz + dz) * meta.res).toFixed(0).padStart(4)} ${row}\n`;
    }
    console.log(s);
    // heights
    let hs = '';
    for (let dz = -4; dz <= 4; dz++) { let row = ''; for (let dx = -4; dx <= 4; dx++) { const k = (gz + dz) * meta.nx + (gx + dx); row += (grid.readInt16LE(k * 4) * 0.05).toFixed(1).padStart(6); } hs += row + '\n'; }
    console.log('height field (m):\n' + hs);
    break;
  }
}
