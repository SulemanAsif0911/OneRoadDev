import { CarSim, specFromCarJson } from '../src/game/physics.ts';
const flat = { heightAt: () => 0, normalAt: (_x: number, _z: number, o: any) => o.set(0, 1, 0), solidAt: () => 0, propsNear: () => [], strikeProp: () => {} } as any;
const car = new CarSim(specFromCarJson({ id: '2017_lamborghini_huracan_mansory', klass: 'S', wheelBase: 2.6, trackWidth: 1.65, wheelRadius: 0.33, realLength: 4.5, realWidth: 1.95, realHeight: 1.2, unitsPerMeter: 100, groundY: 0 }),
  { tc: 0.9, abs: 0.9, stability: 0.75, counterSteer: 0.85, autoShift: true }, { x: 0, z: 0, yaw: 0 });
car.settle(flat);
const dt = 1 / 120;
for (let i = 0; i < 40 / dt; i++) {
  car.step(dt, { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false }, flat);
  const bad = !Number.isFinite(car.pos.x) || !Number.isFinite(car.vel.x) || !Number.isFinite(car.rpm) ||
    car.wheels.some((w) => !Number.isFinite(w.omega) || !Number.isFinite(w.load) || !Number.isFinite(w.slipRatio) || !Number.isFinite(w.slipAngle));
  if (bad) {
    console.log('NaN at t=', (i * dt).toFixed(3), 'pos', car.pos.toArray(), 'vel', car.vel.toArray(), 'angVel', car.angVel.toArray(), 'rpm', car.rpm);
    console.log(car.wheels.map((w) => ({ om: w.omega, ld: w.load, c: w.compression, k: w.slipRatio, a: w.slipAngle, g: w.grounded })));
    break;
  }
  if (i > 8.5 / dt && i % 30 === 0) console.log(`t=${(i*dt).toFixed(2)} y=${car.pos.y.toFixed(3)} vy=${car.vel.y.toFixed(3)} comp=${car.wheels.map(w=>w.compression.toFixed(2)).join(',')} loads=${car.wheels.map(w=>(w.load/1000).toFixed(1)).join(',')} ground=${car.wheels.map(w=>w.grounded?1:0).join('')} down=${(0.5*1.225*2.1*2.3*car.vel.lengthSq()/1000).toFixed(1)}kN`);
  if (i % 240 === 0) console.log(`t=${(i*dt).toFixed(1)} v=${(car.vel.length()*3.6).toFixed(0)} kmh gear=${car.gear} rpm=${car.rpm.toFixed(0)} y=${car.pos.y.toFixed(3)}`);
}
