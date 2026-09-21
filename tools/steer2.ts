import { CarSim, specFromCarJson, ASSIST_PRESETS } from '../src/game/physics.ts';
import * as THREE from 'three';
const flat = { heightAt: () => 0, normalAt: (_x: number, _z: number, o: any) => o.set(0, 1, 0), solidAt: () => 0, propsNear: () => [], strikeProp: () => {} } as any;
const mk = () => new CarSim(specFromCarJson({ id: 'a', klass: 'A', wheelBase: 2.6, trackWidth: 1.6, wheelRadius: 0.33, realLength: 4.5, realWidth: 1.9, realHeight: 1.2, unitsPerMeter: 100, groundY: 0 }),
  { ...ASSIST_PRESETS.sport, stability: 0 }, { x: 0, z: 0, yaw: 0 });
const dt = 1 / 120;
for (const target of [10, 20, 40, 70, 110]) {
  const car = mk(); car.settle(flat);
  // ramp to 1 over 1.0 s at constant throttle, then hold
  let maxYaw = 0, maxLat = 0, minR = 1e9;
  for (let i = 0; i < 12 / dt; i++) {
    const t = i * dt;
    const steer = Math.min(1, t / 1.0);
    const v = car.vel.length();
    const throttle = Math.min(1, Math.max(0, 0.32 + (target / 3.6 - v) * 0.25));
    car.step(dt, { throttle, brake: v > target / 3.6 * 1.05 ? 0.4 : 0, steer, handbrake: false, boost: false }, flat);
    if (t > 3) { maxYaw = Math.max(maxYaw, Math.abs(car.angVel.y)); maxLat = Math.max(maxLat, Math.abs(car.gLat)); if (Math.abs(car.angVel.y) > 0.05) minR = Math.min(minR, car.vel.length() / Math.abs(car.angVel.y)); }
  }
  const e = new THREE.Euler().setFromQuaternion(car.quat, 'YXZ');
  console.log(`target ${target} km/h: final v=${(car.vel.length() * 3.6).toFixed(0)} yawRate=${car.angVel.y.toFixed(2)} maxYaw=${maxYaw.toFixed(2)} maxLatG=${maxLat.toFixed(2)} minRadius=${minR.toFixed(1)}m slip=${(car.wheels[0].slipAngle * 57.3).toFixed(0)}deg steer=${(car.wheels[0].steer * 57.3).toFixed(0)}deg yawDeg=${(e.y * 57.3).toFixed(0)}`);
}
