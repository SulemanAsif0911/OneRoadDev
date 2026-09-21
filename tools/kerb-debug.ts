import { CarSim, specFromCarJson } from '../src/game/physics.ts';
const bump = {
  normalAt: (_x: number, _z: number, o: any) => o.set(0, 1, 0),
  heightAt: (_x: number, z: number) => (z < -24 && z > -30 ? 0.12 : 0),
  solidAt: () => 0, propsNear: () => [], strikeProp: () => {},
} as any;
const car = new CarSim(specFromCarJson({ id: 'a', klass: 'S', wheelBase: 2.6, trackWidth: 1.65, wheelRadius: 0.33, realLength: 4.5, realWidth: 1.95, realHeight: 1.2, unitsPerMeter: 100, groundY: 0 }),
  { tc: 0.6, abs: 0.7, stability: 0.4, counterSteer: 0.6, autoShift: true }, { x: 0, z: 0, yaw: 0 });
car.settle(bump);
const dt = 1 / 120;
let prevZ = 0;
for (let i = 0; i < 6 / dt; i++) {
  car.step(dt, { throttle: 0.55, brake: 0, steer: 0, handbrake: false, boost: false }, bump);
  const z = car.pos.z;
  if (z < -18 && z > -36 && i % 4 === 0) {
    console.log(`z=${z.toFixed(1)} y=${car.pos.y.toFixed(3)} vy=${car.vel.y.toFixed(2)} v=${(car.vel.length()*3.6).toFixed(0)} pitch=${car.angVel.x.toFixed(2)} comp=${car.wheels.map(w=>w.compression.toFixed(2)).join(',')} loads=${car.wheels.map(w=>(w.load/9810).toFixed(1)).join(',')}`);
  }
  prevZ = z;
}
