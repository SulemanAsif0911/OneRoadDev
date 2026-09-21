/**
 * Vehicle physics — CyberKhyal's car model.
 *
 * Architecture (all at 120 Hz, fixed step):
 *   • per-wheel suspension  — springs, dampers, weight transfer, kerbs, landings
 *   • per-wheel slip model  — slip ratio κ (from the wheel's own spin state) and slip angle α,
 *                             combined through a friction ellipse in slip space and a
 *                             Pacejka-flavoured curve, so wheelspin, lock-up and drifting all
 *                             fall out of one mechanism instead of being special-cased
 *   • drivetrain            — torque curve, 6-speed box with a shift cut, RWD/AWD/FWD, nitro
 *   • assists               — TC, ABS, stability and counter-steer scale it from sim to party
 *
 * The wheel spin state is integrated every step, so a locked wheel really does lose lateral grip
 * and a spinning wheel really does smoke.
 */
import * as THREE from 'three';
import type { Arena } from './arena';

export type CarSpec = {
  id: string;
  label: string;
  fullName: string;
  klass: string;
  mass: number;
  power: number;
  torque: number;         // Nm at the crank
  redline: number;
  idle: number;
  gears: number[];
  finalDrive: number;
  drivetrain: 'RWD' | 'AWD' | 'FWD';
  grip: number;           // peak friction coefficient
  brakeTorque: number;    // Nm at the wheels, total
  downforce: number;
  cgHeight: number;
  wheelBase: number;
  trackWidth: number;
  wheelRadius: number;
  length: number;
  width: number;
  height: number;
  unitsPerMeter: number;
  groundY: number;
  driveBias: number;      // rear share of torque for AWD
  nitro: number;
  steeringLock: number;   // degrees at low speed
};

export type Wheel = {
  local: THREE.Vector3;
  steer: number;
  spin: number;            // visual rotation (rad)
  omega: number;           // real angular velocity (rad/s)
  compression: number;
  load: number;
  grounded: boolean;
  contact: THREE.Vector3;
  contactNormal: THREE.Vector3;
  slipAngle: number;
  slipRatio: number;
  force: THREE.Vector2;    // longitudinal, lateral (car frame)
  smoke: number;
  skid: number;
  locked: boolean;
  front: boolean;
  left: boolean;
  driven: boolean;
};

export type CarInput = {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  boost: boolean;
  shiftUp?: boolean;
  shiftDown?: boolean;
};

export type AssistSettings = { tc: number; abs: number; stability: number; counterSteer: number; autoShift: boolean };

const G = 9.81;
const RHO = 1.225;
const ALPHA_PEAK = 0.148;   // rad — slip angle at peak lateral force (~8.5°)
const KAPPA_PEAK = 0.115;   // slip ratio at peak longitudinal force
const TYRE_CURVE = 1.62;    // pacejka shape factor

export const ASSIST_PRESETS: Record<string, AssistSettings> = {
  arcade: { tc: 0.9, abs: 0.9, stability: 0.75, counterSteer: 0.85, autoShift: true },
  sport: { tc: 0.65, abs: 0.7, stability: 0.4, counterSteer: 0.6, autoShift: true },
  pro: { tc: 0.25, abs: 0.3, stability: 0.12, counterSteer: 0.3, autoShift: true },
  sim: { tc: 0, abs: 0, stability: 0, counterSteer: 0, autoShift: false },
};

export class CarSim {
  spec: CarSpec;
  assists: AssistSettings;

  pos = new THREE.Vector3();
  quat = new THREE.Quaternion();
  vel = new THREE.Vector3();
  angVel = new THREE.Vector3();     // local: x pitch, y yaw, z roll
  wheels: Wheel[] = [];

  rpm = 900;
  gear = 1;
  shiftTimer = 0;
  clutch = 1;
  nitro = 1;
  nitroActive = 0;
  throttleSmooth = 0;
  brakeSmooth = 0;
  steerSmooth = 0;
  wheelspin = 0;
  drifting = 0;
  driftTime = 0;
  odometer = 0;
  airborne = 0;
  onGround = false;
  impactSpeed = 0;
  lastImpact = 0;
  wallContact = 0;
  gLat = 0;
  gLong = 0;
  speedKmh = 0;
  private suspK: number;
  private suspD: number;
  private travel = 0.16;
  private velLatPrev = 0;
  private speedPrev = 0;
  private ghEff: number[] = [0, 0, 0, 0];
  private sm = {
    fwd: new THREE.Vector3(),
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    tmp: new THREE.Vector3(),
    q: new THREE.Quaternion(),
    inv: new THREE.Quaternion(),
    F: new THREE.Vector3(),
    M: new THREE.Vector3(),
    frontFx: 0, frontFy: 0, rearFx: 0, rearFy: 0,
    loadFront: 0, loadRear: 0,
  };

  constructor(spec: CarSpec, assists: AssistSettings, start: { x: number; z: number; yaw: number; y?: number }) {
    this.spec = spec;
    this.assists = assists;
    this.suspK = (spec.mass * G) / (4 * this.travel * 0.38);
    this.suspD = this.suspK * 0.38;
    const halfTrack = spec.trackWidth / 2, halfBase = spec.wheelBase / 2;
    const defs = [
      { x: -halfTrack, z: -halfBase, front: true, left: true },
      { x: halfTrack, z: -halfBase, front: true, left: false },
      { x: -halfTrack, z: halfBase, front: false, left: true },
      { x: halfTrack, z: halfBase, front: false, left: false },
    ];
    const awd = spec.drivetrain === 'AWD';
    this.wheels = defs.map((d) => ({
      local: new THREE.Vector3(d.x, 0, d.z),
      steer: 0, spin: 0, omega: 0, compression: 0.38, load: spec.mass * G / 4,
      grounded: true, contact: new THREE.Vector3(), contactNormal: new THREE.Vector3(0, 1, 0),
      slipAngle: 0, slipRatio: 0, force: new THREE.Vector2(), smoke: 0, skid: 0, locked: false,
      front: d.front, left: d.left,
      driven: awd || (spec.drivetrain === 'FWD' ? d.front : !d.front),
    }));
    this.reset(start);
  }

  forwardAxis(out = new THREE.Vector3()) { return out.set(0, 0, -1).applyQuaternion(this.quat); }

  reset(start: { x: number; z: number; yaw: number; y?: number }) {
    this.pos.set(start.x, start.y ?? 0, start.z);
    this.quat.setFromEuler(new THREE.Euler(0, start.yaw, 0, 'YXZ'));
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.rpm = this.spec.idle;
    this.gear = 1;
    this.shiftTimer = 0;
    this.clutch = 1;
    this.nitro = 1;
    this.nitroActive = 0;
    this.throttleSmooth = 0;
    this.brakeSmooth = 0;
    this.steerSmooth = 0;
    this.wheelspin = 0;
    this.drifting = 0;
    this.driftTime = 0;
    this.airborne = 0;
    this.onGround = true;
    this.speedPrev = 0;
    this.velLatPrev = 0;
    for (const w of this.wheels) {
      w.omega = 0; w.spin = 0; w.steer = 0; w.load = this.spec.mass * G / 4;
      w.compression = 0.38; w.smoke = 0; w.skid = 0; w.locked = false;
      this.ghEff[this.wheels.indexOf(w)] = Number.NaN;
    }
  }

  /** Place the car so its springs rest on whatever surface is under the wheels. */
  settle(arena: Arena) {
    const s = this.spec;
    let rest = -Infinity;
    for (const w of this.wheels) {
      const hub = new THREE.Vector3().copy(w.local).applyQuaternion(this.quat).add(this.pos);
      rest = Math.max(rest, arena.heightAt(hub.x, hub.z));
    }
    if (!Number.isFinite(rest)) rest = 0;
    this.pos.y = rest + s.wheelRadius + this.travel * (1 - 0.38);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    for (const w of this.wheels) w.compression = 0.38;
    return this;
  }

  private engineTorque(rpm: number) {
    const s = this.spec;
    const n = Math.max(0, Math.min(1.25, rpm / s.redline));
    // fat mid-range, softened top end, hard limiter
    const curve = Math.exp(-Math.pow((n - 0.72) * 2.05, 2)) * 0.94 + Math.exp(-Math.pow((n - 0.3) * 3.4, 2)) * 0.32;
    const limiter = rpm > s.redline ? Math.max(0, 1 - (rpm - s.redline) / 350) : 1;
    return s.torque * Math.max(0.12, curve) * limiter;
  }

  private gearRatio() {
    const s = this.spec;
    return s.gears[Math.max(0, Math.min(s.gears.length - 1, this.gear - 1))] * s.finalDrive;
  }

  step(dt: number, input: CarInput, arena: Arena, others?: { x: number; z: number; r: number; vx: number; vz: number; yaw: number }[]) {
    const s = this.spec, sm = this.sm;
    const fwd = this.forwardAxis(sm.fwd);
    const right = sm.right.set(-fwd.z, 0, fwd.x);
    const up = sm.up.set(0, 1, 0).applyQuaternion(this.quat);
    const speed = this.vel.length();
    const velFwd = this.vel.dot(fwd);
    const velLat = this.vel.dot(right);
    this.speedKmh = speed * 3.6;

    /* ------------------------------------------------------------- steering -- */
    const lock = THREE.MathUtils.degToRad(s.steeringLock) * (1 - Math.min(0.66, speed / 92));
    const steerTarget = input.steer * lock;
    const steerRate = 5.6 + 3.4 / (1 + speed * 0.06);
    this.steerSmooth += THREE.MathUtils.clamp(steerTarget - this.steerSmooth, -steerRate * dt, steerRate * dt);
    this.wheels[0].steer = this.steerSmooth;
    this.wheels[1].steer = this.steerSmooth;

    /* ----------------------------------------------------- engine + gearbox -- */
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const shift = (dir: number) => {
      if (this.shiftTimer > 0) return;
      const next = this.gear + dir;
      if (next < 1 || next > s.gears.length) return;
      this.gear = next;
      this.shiftTimer = 0.115;
      this.clutch = 0.04;
    };
    if (this.assists.autoShift) {
      if (this.rpm > s.redline * 0.955 && this.gear < s.gears.length && this.throttleSmooth > 0.15) shift(1);
      else if (this.rpm < s.redline * 0.42 && this.gear > 1 && this.brakeSmooth < 0.2) shift(-1);
    }
    if (input.shiftUp) shift(1);
    if (input.shiftDown) shift(-1);
    this.clutch = Math.min(1, this.clutch + dt * 6);

    const throttle = THREE.MathUtils.damp(this.throttleSmooth, THREE.MathUtils.clamp(input.throttle, 0, 1), 11, dt);
    const brake = THREE.MathUtils.damp(this.brakeSmooth, THREE.MathUtils.clamp(input.brake, 0, 1), 17, dt);
    this.throttleSmooth = throttle;
    this.brakeSmooth = brake;

    const boosting = !!input.boost && this.nitro > 0.02;
    if (boosting) { this.nitro = Math.max(0, this.nitro - dt / 3.6); this.nitroActive = Math.min(1, this.nitroActive + dt * 6); }
    else { this.nitro = Math.min(1, this.nitro + dt * 0.04); this.nitroActive = Math.max(0, this.nitroActive - dt * 2.5); }

    const ratio = this.gearRatio();
    let engineTq = this.engineTorque(this.rpm) * throttle * this.clutch * (boosting ? s.nitro : 1);
    if (throttle < 0.04) engineTq = -this.rpm * 0.045 * this.clutch;    // overrun
    const axleTqTotal = engineTq * ratio * 0.9;

    /* --------------------------------------------------------- suspension ---- */
    let groundedCount = 0, loadFront = 0, loadRear = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const hub = sm.tmp.copy(w.local).applyQuaternion(this.quat).add(this.pos);
      const raw = arena.heightAt(hub.x, hub.z);
      // The tyre rolls up a step instead of teleporting onto it: rate-limit how fast the ground
      // under a wheel may change, which is what keeps kerbs as jolts instead of launches.
      let gh = this.ghEff[i];
      if (!Number.isFinite(gh)) gh = raw;
      else {
        const maxStep = 3.4 * dt;
        gh += THREE.MathUtils.clamp(raw - gh, -maxStep, maxStep);
      }
      this.ghEff[i] = gh;
      const groundY = gh;
      const gap = hub.y - groundY;
      const compression = THREE.MathUtils.clamp(1 - (gap - s.wheelRadius) / this.travel, 0, 1);
      const contacting = gap - s.wheelRadius <= this.travel * 0.98;
      const rate = THREE.MathUtils.clamp((compression - w.compression) / Math.max(dt, 1e-4), -9, 9);
      w.compression = compression;
      w.grounded = contacting;
      if (contacting) groundedCount++;
      // spring (bounded by the bump stop) + damper (bounded so a step edge cannot spike it)
      const spring = this.suspK * compression * this.travel;
      const damper = THREE.MathUtils.clamp(this.suspD * rate * this.travel, -s.mass * G * 0.3, s.mass * G * 0.3);
      let load = contacting ? Math.max(0, spring + damper) : 0;
      load = Math.min(load, s.mass * G * 0.75);
      w.load = load;
      w.contact.set(hub.x, groundY, hub.z);
      arena.normalAt(hub.x, hub.z, w.contactNormal);
      if (w.front) loadFront += load; else loadRear += load;
    }
    this.onGround = groundedCount > 0;
    this.airborne = this.onGround ? 0 : this.airborne + dt;
    const totalLoad = loadFront + loadRear;
    const ceiling = s.mass * G * (this.onGround ? 3.1 : 1);
    if (totalLoad > ceiling && totalLoad > 0) {
      const k = ceiling / totalLoad;
      for (const w of this.wheels) w.load *= k;
      loadFront *= k; loadRear *= k;
    }
    sm.loadFront = loadFront; sm.loadRear = loadRear;

    /* ------------------------------------------------------------- tyres ---- */
    const a = s.wheelBase * 0.5;
    const yawRate = this.angVel.y;
    const eps = 2.5;
    // velocity of each axle along the car's right axis: v = v_cg + omega x r, and for a front
    // axle at r = fwd * a that is -a * yawRate (this sign is what keeps the model stable: the
    // opposite sign makes the tyres reinforce the yaw and every car spins)
    const vFront = velLat - yawRate * a;
    const vRear = velLat + yawRate * a;
    const alphaFront = Math.atan2(vFront, Math.max(Math.abs(velFwd), eps)) - this.steerSmooth;
    const alphaRear = Math.atan2(vRear, Math.max(Math.abs(velFwd), eps));

    const driveShareF = s.drivetrain === 'FWD' ? 1 : s.drivetrain === 'AWD' ? (1 - s.driveBias) : 0;
    const driveShareR = s.drivetrain === 'RWD' ? 1 : s.drivetrain === 'AWD' ? s.driveBias : 0;

    // brake torque at each wheel (front-biased, handbrake locks the rear)
    const brakeF = (brake * s.brakeTorque * 0.62) / 2;
    const brakeR = (brake * s.brakeTorque * 0.38) / 2 + (input.handbrake ? (s.brakeTorque * 0.55) / 2 : 0);

    let frontFx = 0, frontFy = 0, rearFx = 0, rearFy = 0;
    let maxDriveSlip = 0;
    for (const w of this.wheels) {
      const driveTq = w.driven ? (axleTqTotal * (w.front ? driveShareF : driveShareR)) / 2 : 0;
      let brakeTq = (w.front ? brakeF : brakeR) * (w.grounded ? 1 : 0.35);
      const wheelR = s.wheelRadius;

      if (!w.grounded) {
        // free wheel: spin down slowly through the air, no tyre force
        const iEff = 1.5 + (w.driven ? 0.03 * ratio * ratio : 0);
        w.omega += ((driveTq - Math.sign(w.omega) * brakeTq * 0.4) / iEff) * dt;
        w.omega = THREE.MathUtils.clamp(w.omega, -320, 320);
        w.slipRatio = 0; w.slipAngle = 0; w.smoke = 0; w.skid = 0; w.locked = false;
        w.force.set(0, 0);
        continue;
      }

      const load = Math.max(120, w.load);
      const mu = s.grip * (1 + (boosting ? 0.05 : 0)) * (1 - Math.min(0.18, Math.max(0, (load - s.mass * G * 0.25) * 0.000017)));
      const cap = mu * load;

      // --- longitudinal slip ratio from the wheel's own spin ------------------
      // (wheel surface speed minus ground speed, normalised; the wheel state is integrated below
      // so a locked wheel loses lateral grip and a spinning one smokes)
      const vRef = Math.max(Math.abs(velFwd), 2.5);
      let kappa = (w.omega * wheelR - velFwd) / vRef;
      kappa = THREE.MathUtils.clamp(kappa, -1.8, 1.8);
      const alpha = w.front ? alphaFront : alphaRear;

      // --- combined slip: friction ellipse in normalised slip space -----------
      const an = alpha / ALPHA_PEAK;
      const kn = kappa / KAPPA_PEAK;
      const sNorm = Math.hypot(an, kn);
      const scale = cap * Math.sin(TYRE_CURVE * Math.atan(Math.max(sNorm, 1e-4)));
      let fx = sNorm > 1e-4 ? scale * (kn / sNorm) : 0;
      let fy = sNorm > 1e-4 ? -scale * (an / sNorm) : 0;
      if (Math.abs(alpha) < 0.012 && Math.abs(kappa) < 0.012) { fx *= 0.35; fy *= 0.35; }   // stiction

      w.slipAngle = alpha;
      w.slipRatio = kappa;
      w.force.set(fx, fy);

      // --- traction control: bleed the surplus drive torque -------------------
      let appliedTq = w.driven ? driveTq : 0;
      if (appliedTq > 0 && kappa > 0.05 && this.assists.tc > 0) {
        const cut = THREE.MathUtils.clamp((kappa - 0.05) / 0.3, 0, 1) * this.assists.tc;
        appliedTq *= 1 - cut;
        maxDriveSlip = Math.max(maxDriveSlip, cut);
      }
      // --- ABS: bleed brake torque when the wheel is past peak slip ------------
      if (this.assists.abs > 0 && brakeTq > 0 && Math.abs(kappa) > KAPPA_PEAK * 1.15) {
        const bleed = THREE.MathUtils.clamp((Math.abs(kappa) - KAPPA_PEAK * 1.15) / 0.5, 0, 1);
        brakeTq *= Math.max(0.1, 1 - bleed);
      }

      // --- wheel spin dynamics ------------------------------------------------
      const iEff = 1.5 + (w.driven ? 0.03 * ratio * ratio : 0);
      const net = appliedTq - Math.sign(w.omega + 1e-6) * brakeTq - fx * wheelR;
      let nextOmega = w.omega + (net / iEff) * dt;
      if (brakeTq > 0 && Math.sign(nextOmega) !== Math.sign(w.omega) && Math.abs(nextOmega * wheelR) < 1.2) nextOmega = 0;
      w.omega = THREE.MathUtils.clamp(nextOmega, -340, 340);
      w.locked = brakeTq > 40 && Math.abs(w.omega) < 3.5 && Math.abs(velFwd) > 3;

      // --- tyre telemetry / effects -------------------------------------------
      const util = sNorm / 1.45;
      w.skid = THREE.MathUtils.clamp((util - 0.82) * 3.2, 0, 1);
      w.smoke = THREE.MathUtils.clamp(w.skid * (1.1 - Math.min(1, Math.abs(velFwd) / 6) * 0.35), 0, 1);

      if (w.front) { frontFx += fx; frontFy += fy; } else { rearFx += fx; rearFy += fy; }
    }
    this.wheelspin = THREE.MathUtils.damp(this.wheelspin, maxDriveSlip, 8, dt);

    /* --------------------------------------------------------- forces/moments */
    const F = sm.F.set(0, -s.mass * G, 0);
    const M = sm.M.set(0, 0, 0);

    const fW = new THREE.Vector3(fwd.x * frontFx + right.x * frontFy, 0, fwd.z * frontFx + right.z * frontFy);
    const rW = new THREE.Vector3(fwd.x * rearFx + right.x * rearFy, 0, fwd.z * rearFx + right.z * rearFy);
    F.add(fW).add(rW);

    const rF = new THREE.Vector3(fwd.x * a, 0, fwd.z * a);
    const rR = new THREE.Vector3(-fwd.x * a, 0, -fwd.z * a);
    M.add(new THREE.Vector3().copy(rF).cross(fW));
    M.add(new THREE.Vector3().copy(rR).cross(rW));

    const hubOffset = new THREE.Vector3();
    for (const w of this.wheels) {
      if (w.load <= 0) continue;
      F.y += w.load;
      hubOffset.copy(w.local).applyQuaternion(this.quat);
      M.x -= hubOffset.z * w.load;
      M.z += hubOffset.x * w.load;
    }

    // self-aligning torque — the reason a slide self-corrects when you let go
    M.y += -alphaFront * Math.abs(frontFy) * 0.055 - alphaRear * Math.abs(rearFy) * 0.03;

    /* ------------------------------------------------------------- aero ------ */
    const speed2 = this.vel.lengthSq();
    if (speed2 > 0.5) {
      const vn = new THREE.Vector3().copy(this.vel).normalize();
      F.addScaledVector(vn, -0.5 * RHO * 0.68 * 2.15 * speed2);
    }
    F.addScaledVector(up, -0.5 * RHO * s.downforce * 2.3 * speed2);

    /* ------------------------------------------------------ stability assist - */
    if (this.onGround) {
      const slipNow = Math.abs(Math.atan2(velLat, Math.max(Math.abs(velFwd), 3)));
      if (this.assists.stability > 0) {
        // how far the yaw rate is from a sane value for the current steer and grip
        const maxYaw = (s.grip * G * 1.05) / Math.max(Math.abs(velFwd), 6);
        const targetYaw = THREE.MathUtils.clamp((velFwd / Math.max(7, s.wheelBase)) * Math.tan(this.steerSmooth), -maxYaw, maxYaw);
        const grip12 = THREE.MathUtils.clamp(1 - slipNow / 0.32, 0, 1);
        const k = s.mass * 0.34 * this.assists.stability * (1 + Math.min(1, speed / 45));
        M.y -= THREE.MathUtils.clamp(yawRate - targetYaw, -1.4, 1.4) * k * (0.25 + 0.75 * grip12);
        M.z -= this.angVel.z * s.mass * 0.15 * this.assists.stability;
        M.x -= this.angVel.x * s.mass * 0.2 * this.assists.stability;
      }
      M.z -= this.angVel.z * s.mass * 0.07;
      M.x -= this.angVel.x * s.mass * 0.12;
    }

    /* ------------------------------------------------------------ integrate -- */
    this.vel.addScaledVector(F, dt / s.mass);
    const Ix = s.mass * (s.height * s.height + s.length * s.length) / 12;
    const Iy = s.mass * (s.length * s.length + s.width * s.width) / 12;
    const Iz = s.mass * (s.width * s.width + s.height * s.height) / 12;
    const localM = M.clone().applyQuaternion(this.quat.clone().invert());
    this.angVel.x += (localM.x / Ix) * dt;
    this.angVel.y += (localM.y / Iy) * dt;
    this.angVel.z += (localM.z / Iz) * dt;
    this.angVel.multiplyScalar(1 - Math.min(0.5, dt * (this.onGround ? 1.4 : 0.3)));
    this.angVel.x = THREE.MathUtils.clamp(this.angVel.x, -3.2, 3.2);
    this.angVel.y = THREE.MathUtils.clamp(this.angVel.y, -3.8, 3.8);
    this.angVel.z = THREE.MathUtils.clamp(this.angVel.z, -3.6, 3.6);

    if (this.onGround && up.y < 0.55 && speed < 15) {
      const ax = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0)).applyQuaternion(this.quat.clone().invert());
      this.angVel.addScaledVector(ax, dt * 3.0);
    }
    if (!this.onGround) {
      this.angVel.y += input.steer * dt * 0.55;
      this.angVel.x -= input.brake * dt * 0.3;
    }

    const dq = sm.q.set(this.angVel.x * dt * 0.5, this.angVel.y * dt * 0.5, this.angVel.z * dt * 0.5, 0).multiply(this.quat);
    this.quat.set(this.quat.x + dq.x, this.quat.y + dq.y, this.quat.z + dq.z, this.quat.w + dq.w).normalize();
    this.pos.addScaledVector(this.vel, dt);
    this.odometer += speed * dt;

    /* --------------------------------------------------------------- rpm ----- */
    let omegaAvg = 0, n = 0;
    for (const w of this.wheels) { omegaAvg += w.omega; n++; }
    omegaAvg /= n;
    const rpmFromWheels = (Math.abs(omegaAvg) * ratio * 60) / (2 * Math.PI);
    const targetRpm = this.onGround
      ? THREE.MathUtils.clamp(Math.max(s.idle, rpmFromWheels), s.idle, s.redline * 1.02)
      : Math.min(s.redline, this.rpm + 1500 * dt);
    this.rpm = THREE.MathUtils.damp(this.rpm, targetRpm, this.onGround ? 11 : 2.5, dt);

    for (const w of this.wheels) w.spin += w.omega * dt;

    /* ---------------------------------------------------- drift / telemetry -- */
    const bodySlip = Math.atan2(velLat, Math.max(Math.abs(velFwd), 3));
    this.gLong = (velFwd - this.speedPrev) / Math.max(dt, 1e-4) / G;
    this.gLat = ((velLat - this.velLatPrev) / Math.max(dt, 1e-4) + velFwd * yawRate) / G;
    this.speedPrev = velFwd;
    this.velLatPrev = velLat;
    if (Math.abs(bodySlip) > 0.2 && speed > 11) { this.drifting = Math.min(1, this.drifting + dt * 3); this.driftTime += dt; }
    else this.drifting = Math.max(0, this.drifting - dt * 2.5);

    /* ------------------------------------------------------ world collision -- */
    this.resolveWorld(dt, arena);
    if (others?.length) this.resolveCars(dt, others);

    if (speed < 0.35 && input.throttle < 0.05 && this.onGround) {
      this.vel.multiplyScalar(1 - Math.min(0.9, dt * 7));
      this.angVel.multiplyScalar(1 - Math.min(0.9, dt * 7));
      for (const w of this.wheels) w.omega *= 1 - Math.min(0.9, dt * 9);
    }
    return this;
  }

  private resolveWorld(dt: number, arena: Arena) {
    const s = this.spec;
    const halfW = s.width / 2, halfL = s.length / 2;
    const probes: [number, number][] = [
      [0, -halfL * 0.98], [halfW * 0.85, -halfL * 0.7], [-halfW * 0.85, -halfL * 0.7],
      [halfW, 0], [-halfW, 0],
      [halfW * 0.85, halfL * 0.7], [-halfW * 0.85, halfL * 0.7], [0, halfL * 0.98],
    ];
    const fwd = this.forwardAxis(this.sm.fwd).clone();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    // One contact for the whole body: summing a bounce per probe pumped energy into the car and
    // launched it off kerbs. Accumulate a single averaged normal + depth instead.
    let nx = 0, nz = 0, hits = 0, deepest = 0;
    for (const [lx, lz] of probes) {
      const px = this.pos.x + fwd.x * -lz + right.x * lx;
      const pz = this.pos.z + fwd.z * -lz + right.z * lx;
      const solid = arena.solidAt(px, pz);
      if (solid <= 0) continue;
      hits++;
      deepest = Math.max(deepest, solid);
      const dx = px - this.pos.x, dz = pz - this.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      nx -= dx / len; nz -= dz / len;
    }
    if (hits > 0) {
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      // push out just enough to clear the geometry
      const push = Math.min(0.55, 0.14 + 0.16 * deepest) * (hits > 3 ? 1.6 : 1);
      this.pos.x += nx * push;
      this.pos.z += nz * push;
      const vn = this.vel.x * nx + this.vel.z * nz;      // negative when driving into the wall
      if (vn < 0) {
        const restitution = 0.22;
        this.vel.x -= nx * vn * (1 + restitution);
        this.vel.z -= nz * vn * (1 + restitution);
        const impact = -vn;
        this.lastImpact = performance.now();
        this.impactSpeed = Math.max(this.impactSpeed, impact);
        this.angVel.y += (Math.random() - 0.5) * Math.min(0.5, impact * 0.03);
        this.angVel.z += (Math.random() - 0.5) * Math.min(0.35, impact * 0.02);
        // scrub speed off along the wall so a scrape costs lap time but does not stop the car
        this.vel.multiplyScalar(1 - Math.min(0.18, impact * 0.012));
      }
      this.wallContact = 1;
      // never let a wall push the car under the ground
      const gh = arena.heightAt(this.pos.x, this.pos.z);
      const minY = gh + s.wheelRadius * 0.55;
      if (this.pos.y < minY) this.pos.y = minY;
    } else {
      this.wallContact = Math.max(0, this.wallContact - dt * 4);
    }
    this.impactSpeed = Math.max(0, this.impactSpeed - dt * 8);

    const near = arena.propsNear(this.pos.x, this.pos.z, halfL * 0.9);
    for (const p of near) {
      if (!p.alive) continue;
      const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
      const d = Math.hypot(dx, dz) || 1e-3;
      const minD = p.r + Math.min(halfW, halfL) * 0.8;
      if (d > minD) continue;
      const px = dx / d, pz = dz / d;
      const impact = Math.abs(this.vel.x * px + this.vel.z * pz);
      if (impact > 5) {
        arena.strikeProp(p, impact);
        this.vel.multiplyScalar(1 - Math.min(0.18, impact * 0.004));
        this.impactSpeed = Math.max(this.impactSpeed, impact * 0.35);
      } else {
        this.pos.x -= px * (minD - d) * 0.6;
        this.pos.z -= pz * (minD - d) * 0.6;
        this.vel.x *= 0.96; this.vel.z *= 0.96;
      }
    }
  }

  private resolveCars(dt: number, others: { x: number; z: number; r: number; vx: number; vz: number; yaw: number }[]) {
    const s = this.spec;
    const myR = Math.max(s.width, s.length * 0.62) * 0.5;
    let hit = 0;
    for (const o of others) {
      const dx = this.pos.x - o.x, dz = this.pos.z - o.z;
      const d = Math.hypot(dx, dz);
      const minD = myR + o.r;
      if (d > minD || d < 1e-4 || hit > 2) continue;
      hit++;
      const nx = dx / d, nz = dz / d;
      const overlap = minD - d;
      this.pos.x += nx * overlap * 0.6;
      this.pos.z += nz * overlap * 0.6;
      const vn = (this.vel.x - o.vx) * nx + (this.vel.z - o.vz) * nz;
      if (vn < 0) {
        const j = -(1 + 0.3) * vn * 0.55;
        this.vel.x += nx * j;
        this.vel.z += nz * j;
        this.lastImpact = performance.now();
        this.impactSpeed = Math.max(this.impactSpeed, Math.abs(vn));
        this.angVel.y += (Math.random() - 0.5) * Math.min(0.5, Math.abs(vn) * 0.03);
      }
    }
  }
}

/* ------------------------------------------------------------------ specs --- */
const CLASS_PRESETS = {
  S: { mass: 1550, torque: 760, redline: 8600, grip: 1.62, brakeTorque: 9000, downforce: 2.1, steeringLock: 33 },
  A: { mass: 1400, torque: 600, redline: 8000, grip: 1.55, brakeTorque: 8400, downforce: 1.7, steeringLock: 34 },
  B: { mass: 1950, torque: 800, redline: 7000, grip: 1.40, brakeTorque: 8600, downforce: 1.1, steeringLock: 35 },
  C: { mass: 2500, torque: 850, redline: 6200, grip: 1.32, brakeTorque: 9200, downforce: 0.7, steeringLock: 36 },
};

export function specFromCarJson(car: any): CarSpec {
  const klass = (car.klass as keyof typeof CLASS_PRESETS) ?? 'A';
  const p = CLASS_PRESETS[klass] ?? CLASS_PRESETS.A;
  const spec: CarSpec = {
    id: car.id,
    label: car.label,
    fullName: car.fullName,
    klass,
    mass: p.mass,
    power: p.torque * 0.55,
    torque: p.torque,
    redline: p.redline,
    idle: 850,
    gears: [3.45, 2.28, 1.68, 1.31, 1.05, 0.87],
    finalDrive: 3.4,
    drivetrain: 'RWD',
    grip: p.grip,
    brakeTorque: p.brakeTorque,
    downforce: p.downforce,
    cgHeight: 0.45,
    wheelBase: car.wheelBase,
    trackWidth: car.trackWidth,
    wheelRadius: car.wheelRadius,
    length: car.realLength,
    width: car.realWidth,
    height: car.realHeight,
    unitsPerMeter: car.unitsPerMeter,
    groundY: car.groundY,
    driveBias: 0.6,
    nitro: 1.26,
    steeringLock: p.steeringLock,
  };
  const id = String(car.id);
  if (/urus/i.test(id)) Object.assign(spec, { drivetrain: 'AWD', driveBias: 0.42, mass: 2150, torque: 900, redline: 6800, grip: 1.42, height: Math.max(spec.height, 1.6), steeringLock: 35 });
  else if (/aventador|carbonado/i.test(id)) Object.assign(spec, { drivetrain: 'AWD', driveBias: 0.66, torque: 740, redline: 8700, grip: 1.66, mass: 1740 });
  else if (/huracan/i.test(id)) Object.assign(spec, { drivetrain: 'AWD', driveBias: 0.64, torque: 620, redline: 8500, grip: 1.64, mass: 1560 });
  else if (/countach/i.test(id)) Object.assign(spec, { drivetrain: 'RWD', torque: 420, redline: 7600, grip: 1.44, mass: 1490, brakeTorque: 7600, downforce: 1.2 });
  else if (/e30/i.test(id)) Object.assign(spec, { drivetrain: 'RWD', torque: 330, redline: 7600, grip: 1.48, mass: 1200, brakeTorque: 7400, downforce: 1.5 });
  else if (/m3_gtr/i.test(id)) Object.assign(spec, { drivetrain: 'RWD', torque: 500, redline: 8200, grip: 1.56, mass: 1360 });
  else if (/wraith/i.test(id)) Object.assign(spec, { drivetrain: 'RWD', torque: 900, redline: 6000, grip: 1.28, mass: 2500 });
  else if (/ghost/i.test(id)) Object.assign(spec, { drivetrain: 'RWD', torque: 820, redline: 5900, grip: 1.3, mass: 2480 });
  else if (/phantom/i.test(id)) Object.assign(spec, { drivetrain: 'RWD', torque: 760, redline: 5700, grip: 1.29, mass: 2600 });

  // gearing: top gear hits the redline at roughly the car's real top speed
  const topSpeed = 50 + spec.torque * 0.08 + spec.downforce * 5;
  spec.finalDrive = THREE.MathUtils.clamp((spec.redline * 2 * Math.PI * spec.wheelRadius) / (60 * topSpeed * spec.gears[spec.gears.length - 1]), 2.2, 4.8);
  return spec;
}
