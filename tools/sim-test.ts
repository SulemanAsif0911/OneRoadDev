/** Headless physics validation: acceleration, top speed, braking, cornering, stability. */
import { CarSim, specFromCarJson } from '../src/game/physics.ts';
import * as THREE from 'three';

const flat = {
  heightAt: () => 0,
  normalAt: (_x: number, _z: number, out: any) => out.set(0, 1, 0),
  solidAt: () => 0,
  propsNear: () => [],
  strikeProp: () => {},
} as any;

function makeCar(id: string, klass = 'S') {
  const car = { id, label: id, fullName: id, klass, wheelBase: 2.6, trackWidth: 1.65, wheelRadius: 0.34, realLength: 4.5, realWidth: 1.9, realHeight: 1.2, unitsPerMeter: 100, groundY: 0 };
  return new CarSim(specFromCarJson(car), { tc: 1, abs: 1, stability: 0.6, counterSteer: 0.5, autoShift: true }, { x: 0, z: 0, yaw: 0 });
}
const input = (o: Partial<any> = {}) => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, ...o });

function run(car: CarSim, seconds: number, inp: any, dt = 1 / 120) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) car.step(dt, typeof inp === 'function' ? inp(i * dt) : inp, flat);
}

// --- 0-100 km/h, top speed, quarter mile
for (const id of ['2017_lamborghini_huracan_mansory', '2013_mansory_carbonado_lamborghini_aventador', '2001_bmw_m3_gtr', 'rollsroyce_phantom', '2019_mansory_venatus_lamborghini_urus']) {
  const car = makeCar(id);
  let t100 = -1, t200 = -1, dist = 0; const dt = 1 / 120;
  for (let i = 0; i < 120 / dt; i++) {
    car.step(dt, input({ throttle: 1 }), flat);
    const kmh = car.vel.length() * 3.6;
    dist += car.vel.length() * dt;
    if (t100 < 0 && kmh >= 100) t100 = i * dt;
    if (t200 < 0 && kmh >= 200) t200 = i * dt;
  }
  const kmh = car.vel.length() * 3.6;
  console.log(`${id.padEnd(42)} 0-100=${t100.toFixed(2)}s 0-200=${t200.toFixed(2)}s top=${kmh.toFixed(0)}km/h gear=${car.gear} rpm=${car.rpm.toFixed(0)}`);
}
// --- braking from 100 km/h
{
  const car = makeCar('2001_bmw_m3_gtr');
  run(car, 6, input({ throttle: 1 }));
  const v0 = car.vel.length(); let d = 0; const dt = 1 / 120;
  for (let i = 0; i < 10 / dt; i++) { car.step(dt, input({ brake: 1 }), flat); d += car.vel.length() * dt; if (car.vel.length() < 0.6) break; }
  console.log(`brake 100-0: ${d.toFixed(1)} m (from ${(v0 * 3.6).toFixed(0)} km/h)`);
}
// --- skidpad: hold a steady 90 km/h with a slowly increasing steering angle, find peak lateral g
{
  const car = makeCar('2017_lamborghini_huracan_mansory');
  let maxLat = 0, stable = true, sampleSpeed = 0; const dt = 1 / 120;
  for (let i = 0; i < 14 / dt; i++) {
    const t = i * dt;
    const target = 25;                                   // m/s = 90 km/h
    const throttle = THREE.MathUtils.clamp((target - car.vel.length()) * 0.6 + 0.32, 0, 1);
    const steer = THREE.MathUtils.clamp((t - 3) / 6, 0, 1);   // ramp in over 6 s
    car.step(dt, input({ throttle, steer }), flat);
    if (t > 4 && t < 10) { maxLat = Math.max(maxLat, Math.abs(car.gLat) * 9.81); sampleSpeed = car.vel.length(); }
    if (Math.abs(car.angVel.y) > 3.2) stable = false;
  }
  console.log(`skidpad: peak lateral ${(maxLat / 9.81).toFixed(2)} g at ${(sampleSpeed * 3.6).toFixed(0)} km/h, recovered=${stable}`);
}
// --- stability: 10 s of violent alternating steering must not explode
{
  const car = makeCar('1988_bmw_m3_evolution_ii_e30_1', 'A');
  let bad = 0; const dt = 1 / 120;
  for (let i = 0; i < 10 / dt; i++) {
    const st = Math.sin(i * dt * 5);
    car.step(dt, input({ throttle: 0.7, steer: st, brake: st < -0.5 ? 0.6 : 0, handbrake: i % 400 < 40 }), flat);
    if (!Number.isFinite(car.pos.x) || Math.abs(car.pos.x) > 1e6 || car.vel.length() > 200) { bad++; break; }
  }
  console.log(`stability test: ${bad ? 'FAILED (blow-up)' : 'ok'} pos=(${car.pos.x.toFixed(1)}, ${car.pos.z.toFixed(1)}) v=${car.vel.length().toFixed(1)}m/s yaw=${car.angVel.y.toFixed(2)}`);
}
// --- drift: handbrake into a corner should produce a big slip angle without spinning instantly
{
  const car = makeCar('2001_bmw_m3_gtr');
  run(car, 3, input({ throttle: 1 }));
  let maxSlip = 0; const dt = 1 / 120;
  for (let i = 0; i < 5 / dt; i++) {
    // flick, then hold opposite lock like a player: steer back based on the body slip measured
    const f2 = new THREE.Vector3(0, 0, -1).applyQuaternion(car.quat);
    const velLat = car.vel.x * f2.z - car.vel.z * f2.x;
    const velFwd = car.vel.dot(f2);
    const slip = Math.atan2(velLat, Math.max(Math.abs(velFwd), 3));
    const counter = i < 40 ? 0.85 : THREE.MathUtils.clamp(-slip * 2.2, -1, 1);
    car.step(dt, input({ throttle: 0.8, steer: counter, handbrake: false }), flat);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(car.quat);
    const f3 = new THREE.Vector3(0, 0, -1).applyQuaternion(car.quat);
    const latAng = Math.atan2(car.vel.x * f3.z - car.vel.z * f3.x, car.vel.dot(f3));
    maxSlip = Math.max(maxSlip, Math.abs(latAng * 180 / Math.PI));
  }
  console.log(`drift: max body slip ${maxSlip.toFixed(1)}deg (target 20-60) speed=${(car.vel.length() * 3.6).toFixed(0)}km/h`);
}
// --- kerb / bump response: driving over a 12 cm step must not launch the car
{
  // a 12 cm kerb painted at z in [-30,-24]; the car starts 30 m before it
  const bump = {
    normalAt: (_x: number, _z: number, out: any) => out.set(0, 1, 0),
    heightAt: (_x: number, z: number) => (z < -24 && z > -30 ? 0.12 : 0),
    solidAt: () => 0, propsNear: () => [], strikeProp: () => {},
  } as any;
  const car = makeCar('2017_lamborghini_huracan_mansory');
  car.settle(bump);
  let maxY = -9, kerbJolt = 0; const dt = 1 / 120;
  for (let i = 0; i < 6 / dt; i++) {
    const zBefore = car.pos.z;
    car.step(dt, input({ throttle: 0.75 }), bump);
    if (zBefore > -28 && car.pos.z <= -28) kerbJolt = car.gLong;
    if (car.pos.z > -34) maxY = Math.max(maxY, car.pos.y);
  }
  console.log(`kerb test: 12 cm kerb at ${(car.vel.length() * 3.6).toFixed(0)} km/h -> peak jolt ${kerbJolt.toFixed(2)} g, max ride height ${maxY.toFixed(3)} m, airborne=${car.airborne.toFixed(2)}s`);
}
