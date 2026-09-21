import { CarSim, specFromCarJson } from '../src/game/physics.ts';
import * as THREE from 'three';
const flat = { heightAt: () => 0, normalAt: (_x: number, _z: number, o: any) => o.set(0, 1, 0), solidAt: () => 0, propsNear: () => [], strikeProp: () => {} } as any;
const car = new CarSim(specFromCarJson({ id: '2001_bmw_m3_gtr', klass: 'A', wheelBase: 2.64, trackWidth: 1.6, wheelRadius: 0.3, realLength: 4.5, realWidth: 1.9, realHeight: 1.2, unitsPerMeter: 100, groundY: 0 }), { tc: 1, abs: 1, stability: 0.6, counterSteer: 0.5, autoShift: true }, { x: 0, z: 0, yaw: 0 });
car.settle(flat);
const dt = 1 / 120;
for (let i = 0; i < 5 * dt * 0; i++) {}
for (let i = 0; i < 4 / dt; i++) car.step(dt, { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false }, flat);
console.log('entry speed', (car.vel.length() * 3.6).toFixed(0));
for (let i = 0; i < 4 / dt; i++) {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(car.quat);
  const velLat = car.vel.x * f.z - car.vel.z * f.x, velFwd = car.vel.dot(f);
  const slip = Math.atan2(velLat, Math.max(Math.abs(velFwd), 3)) * 180 / Math.PI;
  const slide = Math.atan2(velLat, Math.max(Math.abs(velFwd), 3));
  // hold the flick for 0.5 s, then hold lock, then counter-steer proportionally to the slide
  const counter = i < 60 ? 0.9 : i < 130 ? 0.55 : THREE.MathUtils.clamp(-slide * 2.6, -0.95, 0.95);
  car.step(dt, { throttle: 0.8, brake: 0, steer: counter, handbrake: i < 60, boost: false }, flat);
  if (i % 15 === 0) console.log(`t=${(i * dt).toFixed(2)} slip=${slip.toFixed(1)} steer=${counter.toFixed(2)} v=${(car.vel.length() * 3.6).toFixed(0)} yaw=${car.angVel.y.toFixed(2)} gLat=${car.gLat.toFixed(2)}`);
}
