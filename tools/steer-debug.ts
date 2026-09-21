import { CarSim, specFromCarJson } from '../src/game/physics.ts';
const flat={heightAt:()=>0,normalAt:(_x,_z,o)=>o.set(0,1,0),solidAt:()=>0,propsNear:()=>[],strikeProp:()=>{}};
const car=new CarSim(specFromCarJson({id:'a',klass:'A',wheelBase:2.6,trackWidth:1.6,wheelRadius:0.33,realLength:4.5,realWidth:1.9,realHeight:1.2,unitsPerMeter:100,groundY:0}),{tc:0,abs:0,stability:0,counterSteer:0,autoShift:true},{x:0,z:0,yaw:0});
car.settle(flat);
const dt=1/120;
for(let i=0;i<2/dt;i++)car.step(dt,{throttle:0.4,brake:0,steer:0,handbrake:false,boost:false},flat);
console.log('before steer: pos',car.pos.x.toFixed(2),car.pos.z.toFixed(2),'yaw',new (await import('three')).Euler().setFromQuaternion(car.quat,'YXZ').y.toFixed(3));
for(let i=0;i<2/dt;i++){car.step(dt,{throttle:0.4,brake:0,steer:1,handbrake:false,boost:false},flat);
 if(i%24===0){const E=new (await import('three')).Euler().setFromQuaternion(car.quat,'YXZ');console.log(`  t=${(i*dt).toFixed(1)} x=${car.pos.x.toFixed(2)} z=${car.pos.z.toFixed(2)} yaw=${(E.y*57.3).toFixed(0)} yawRate=${car.angVel.y.toFixed(2)} v=${(car.vel.length()*3.6).toFixed(0)}kmh steer=${car.wheels[0].steer.toFixed(2)} aF=${car.wheels[0].slipAngle.toFixed(3)}`);}}
const e=new (await import('three')).Euler().setFromQuaternion(car.quat,'YXZ');
console.log('steer=+1 => pos x',car.pos.x.toFixed(2),'z',car.pos.z.toFixed(2),' yaw',e.y.toFixed(3),' yawRate',car.angVel.y.toFixed(2),' (x>0 means the car moved toward +X = its right side)');
