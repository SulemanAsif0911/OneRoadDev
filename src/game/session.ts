/**
 * CyberKhyal — the race itself.
 *
 * Owns the renderer, the loaded world, every car (local simulation + interpolated remotes), the
 * camera, the effects and the race logic, and exposes one small `hud()` object that the React
 * layer reads. Everything here runs outside React so the render loop never waits on a re-render.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Arena, loadArena } from './arena';
import { CarSim, CarSpec, ASSIST_PRESETS, specFromCarJson } from './physics';
import { InputManager, Controls, rumble } from './input';
import { QUALITY, Settings } from './settings';
import { Sound } from './audio';

export type CarInfo = {
  id: string; label: string; fullName: string; klass: string; file: string;
  realLength: number; realWidth: number; realHeight: number; unitsPerMeter: number;
  wheelBase: number; trackWidth: number; wheelRadius: number;
  rig: null | { fl?: string; fr?: string; rl?: string; rr?: string; frontZ?: number; rearZ?: number };
};

export type Standing = {
  id: string; name: string; color: string; car: string; lap: number; best: number | null;
  finished: boolean; position: number; you: boolean; gap: number | null;
};

export type SessionHud = {
  speed: number; gear: number; rpm: number; redline: number; nitrous: number;
  throttle: number; brake: number; steer: number;
  drifting: boolean; airborne: boolean; wallContact: boolean; offTrack: boolean; wrongWay: boolean;
  lap: number; laps: number; position: number; total: number;
  lapTime: number; lastLap: number | null; bestLap: number | null; lapDelta: number | null;
  raceTime: number; standings: Standing[]; progress: number;
  countdown: number; racing: boolean; finished: boolean;
  rtt: number; fps: number; cars: number;
};

type WheelRig = { node: THREE.Object3D; q0: THREE.Quaternion; spin: number };

type Remote = {
  id: string; name: string; color: string; car: string;
  root: THREE.Group; body: THREE.Object3D | null; wheels: WheelRig[];
  buf: { t: number; p: THREE.Vector3; q: THREE.Quaternion; speed: number }[];
  tag: THREE.Sprite | null;
  lastSeen: number; wheelAngle: number;
};

const GRID_ROWS = 2;
const GRID_GAP = 7.5;      // metres between grid rows
const GRID_SIDE = 2.1;     // metres from the centreline for each column

const lerp = THREE.MathUtils.lerp;

export class Session {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer | null = null;
  bloom: UnrealBloomPass | null = null;

  arena!: Arena;
  cars: CarInfo[] = [];
  models = new Map<string, THREE.Object3D>();
  sound = new Sound();

  settings: Settings;
  input: InputManager;

  // local car
  sim!: CarSim;
  carId = '';
  playerId = '';
  playerName = '';
  playerColor = '#e8402d';
  rig: THREE.Group | null = null;
  body: THREE.Object3D | null = null;
  wheels: WheelRig[] = [];
  braking = false;

  // world visuals
  private worldRoot: THREE.Group | null = null;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private skid!: THREE.InstancedMesh;
  private skidIndex = 0;
  private skidTime: Float32Array = new Float32Array(0);
  private smoke!: THREE.Points;
  private smokeData: { life: number; vx: number; vy: number; vz: number; size: number }[] = [];
  private smokeIndex = 0;
  private tags: THREE.Sprite[] = [];

  // race
  path: { pts: number[][]; n: number; cum: Float64Array; len: number } | null = null;
  progress = 0;
  lap = 0;
  laps = 3;
  lapStart = 0;
  lastLap: number | null = null;
  bestLap: number | null = null;
  lapDelta: number | null = null;
  raceStart = 0;
  finished = false;
  finishTime: number | null = null;
  position = 1;
  total = 1;
  racing = false;
  countdown = 0;
  wrongWay = false;
  offTrack = false;
  offTrackFor = 0;
  wrongFor = 0;
  private lastIdx = 0;
  private lastLapFlash = 0;
  onLap: ((info: { lap: number; time: number; best: number | null; delta: number | null }) => void) | null = null;
  onEvent: ((kind: string, data?: any) => void) | null = null;

  remotes = new Map<string, Remote>();
  private clock = new THREE.Clock();
  private raf = 0;
  private last = 0;
  private acc = 0;
  private netAcc = 0;
  private inputAcc = 0;
  private lastControls: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, reset: false, camera: false, lookBack: false };
  private cameraModeIndex = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private shake = 0;
  private fps = 60;
  private hudCache: SessionHud | null = null;
  private hudTimer = 0;
  private nitrous = 1;
  private disposed = false;
  private sendCarAcc = 0;
  private pendingEvents: { kind: string; data?: any }[] = [];
  timeScale = 1;
  paused = false;

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.input = new InputManager(settings);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.quality !== 'low', powerPreference: 'high-performance', stencil: false });
    this.renderer.setClearColor(0x05070d, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.25, 1400);
    this.camera.position.set(0, 6, 14);
  }

  /* ------------------------------------------------------------------ load -- */
  async load(onProgress?: (pct: number, label: string) => void) {
    const loader = new GLTFLoader();
    onProgress?.(0.04, 'Reading the city');
    this.arena = await loadArena('');
    if (this.arena.circuit?.pts?.length) this.buildPath(this.arena.circuit.pts as number[][]);
    onProgress?.(0.14, 'Opening the car list');
    const res = await fetch('/cars/cars.json');
    this.cars = await res.json();

    onProgress?.(0.2, 'Building the skyline');
    await this.loadWorld(loader);

    onProgress?.(0.6, 'Warming the engines');
    const huracan = this.cars.find((c) => c.id === this.settings.car) || this.cars[0];
    await this.loadCar(huracan.id, loader, (p) => onProgress?.(0.6 + p * 0.35, `Loading the ${huracan.label}`));
    onProgress?.(1, 'Ready');
  }

  buildPath(pts: number[][]) {
    const n = pts.length;
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    this.path = { pts, n, cum, len: cum[n] };
  }

  private async loadWorld(loader: GLTFLoader) {
    const gltf = await loader.loadAsync('/models/sports_car_racing_moscow.glb');
    const root = gltf.scene;
    root.scale.setScalar(this.arena.meta.metersPerUnit);
    root.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.receiveShadow = true;
        o.frustumCulled = true;
        const m = o.material as THREE.MeshStandardMaterial;
        if (m && m.map) { m.map.anisotropy = QUALITY[this.settings.quality].anisotropy; m.map.colorSpace = THREE.SRGBColorSpace; }
        if (m) m.envMapIntensity = 0.65;
      }
    });
    this.worldRoot = root;
    this.scene.add(root);

    // ---- sky dome: a vertical gradient with a sun blown into it, matching the key light below
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1100, 40, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: {
          top: { value: new THREE.Color('#0a1730') },
          mid: { value: new THREE.Color('#3f5f8a') },
          bottom: { value: new THREE.Color('#c9d6e6') },
          sunDir: { value: new THREE.Vector3(-0.42, 0.42, 0.8).normalize() },
        },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
          varying vec3 vDir; uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; uniform vec3 sunDir;
          void main(){
            float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
            vec3 col = mix(bottom, mid, smoothstep(0.42, 0.62, h));
            col = mix(col, top, smoothstep(0.6, 1.0, h));
            float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
            col += vec3(1.0, 0.86, 0.62) * pow(d, 220.0) * 1.6;
            col += vec3(1.0, 0.8, 0.55) * pow(d, 8.0) * 0.22;
            gl_FragColor = vec4(col, 1.0);
          }`,
      }),
    );
    sky.frustumCulled = false;
    this.scene.add(sky);
    this.scene.fog = new THREE.Fog(new THREE.Color('#8fa5c0'), 260, 1150);

    // ---- lights
    const q = QUALITY[this.settings.quality];
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.35);
    this.sun.position.set(-0.42, 0.42, 0.8).normalize().multiplyScalar(320);
    this.sun.castShadow = this.settings.shadows;
    this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    const cam = this.sun.shadow.camera as THREE.OrthographicCamera;
    cam.near = 1; cam.far = 900; cam.left = -120; cam.right = 120; cam.top = 120; cam.bottom = -120;
    this.sun.shadow.bias = -0.0009;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2b2f38, 0.95);
    this.scene.add(this.hemi);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = envRT.texture;
    this.scene.environmentIntensity = 0.5;

    // ---- skid marks: one instanced pool, faded by shrinking
    const skidGeo = new THREE.PlaneGeometry(0.3, 0.52);
    const skidMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0c, transparent: true, opacity: 0.5, depthWrite: false });
    this.skid = new THREE.InstancedMesh(skidGeo, skidMat, 1400);
    this.skid.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.skid.frustumCulled = false;
    this.skidTime = new Float32Array(1400).fill(-1);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < 1400; i++) this.skid.setMatrixAt(i, zero);
    this.skid.visible = this.settings.skidmarks;
    this.scene.add(this.skid);

    // ---- tyre smoke
    const smokeTexture = makeSmokeTexture();
    const smokeGeo = new THREE.BufferGeometry();
    const COUNT = 420;
    const pos = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) { pos[i * 3 + 1] = -1000; sizes[i] = 1; }
    smokeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    smokeGeo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const smokeMat = new THREE.PointsMaterial({
      size: 2.2, map: smokeTexture, transparent: true, opacity: 0.32, depthWrite: false,
      blending: THREE.NormalBlending, color: 0xdfe6f0, sizeAttenuation: true,
    });
    this.smoke = new THREE.Points(smokeGeo, smokeMat);
    this.smoke.frustumCulled = false;
    this.smoke.visible = this.settings.particles;
    this.scene.add(this.smoke);
    for (let i = 0; i < COUNT; i++) this.smokeData.push({ life: 0, vx: 0, vy: 0, vz: 0, size: 1 });

    // ---- post: a little bloom goes a long way on chrome and lights
    if (this.settings.quality !== 'low') {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.62, 0.86);
      this.bloom.enabled = this.settings.bloom && q.bloom;
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
  }

  async loadCar(id: string, loader?: GLTFLoader, onProgress?: (p: number) => void) {
    if (this.models.has(id)) return this.models.get(id)!;
    const info = this.cars.find((c) => c.id === id);
    if (!info) throw new Error(`unknown car ${id}`);
    const l = loader || new GLTFLoader();
    const gltf = await l.loadAsync(`/models/${info.file}`, (e: any) => {
      if (e?.total) onProgress?.(Math.min(1, e.loaded / e.total));
    });
    const root = gltf.scene;
    root.scale.setScalar(1 / info.unitsPerMeter);
    root.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        const m = o.material as THREE.MeshStandardMaterial;
        if (m) {
          m.envMapIntensity = 1.15;
          if ((m as any).map) (m as any).map.anisotropy = QUALITY[this.settings.quality].anisotropy;
        }
      }
      if (o.isLight) o.visible = false;
    });
    this.models.set(id, root);
    onProgress?.(1);
    return root;
  }

  /* -------------------------------------------------------------- rig setup -- */
  private makeRig(carId: string, color: string, isRemote: boolean): { root: THREE.Group; body: THREE.Object3D | null; wheels: WheelRig[] } {
    const src = this.models.get(carId);
    const root = new THREE.Group();
    const wheels: WheelRig[] = [];
    if (!src) return { root, body: null, wheels };
    const clone = cloneSkinned(src);
    const info = this.cars.find((c) => c.id === carId);
    clone.traverse((o: any) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    root.add(clone);
    if (info?.rig && !isRemote) {
      const names: [keyof typeof info.rig, string][] = [['fl', 'front'], ['fr', 'front'], ['rl', 'rear'], ['rr', 'rear']];
      for (const [key] of names) {
        const name = (info.rig as any)[key] as string | undefined;
        if (!name) continue;
        const base = name.split('#')[0];
        let node: THREE.Object3D | null = null;
        clone.traverse((o) => {
          if (node) return;
          if (o.name === name || o.name === base || o.name.replace(/_\d+$/, '') === base) node = o;
        });
        if (node) wheels.push({ node, q0: (node as THREE.Object3D).quaternion.clone(), spin: 0 });
      }
    }
    return { root, body: clone, wheels };
  }

  /* ----------------------------------------------------------------- spawn -- */
  spawnLocal(id: string, name: string, color: string, carId: string, index = 0, total = 1) {
    this.playerId = id;
    this.playerName = name;
    this.playerColor = color;
    this.carId = carId;
    const spec = this.specFor(carId);
    const slot = gridSlot(index);
    const start = this.pathPoint(slot.s, slot.lateral);
    this.sim = new CarSim(spec, { ...ASSIST_PRESETS[this.settings.assist], autoShift: this.settings.assist !== 'sim' }, { x: start.x, z: start.z, yaw: start.yaw });
    this.sim.settle(this.arena);
    if (this.rig) this.scene.remove(this.rig);
    const { root, body, wheels } = this.makeRig(carId, color, false);
    this.rig = root;
    this.body = body;
    this.wheels = wheels;
    this.scene.add(root);
    this.tintColor(color);
    this.cameraModeIndex = 0;
    this.snapCamera(true);
  }

  private tintColor(color: string) {
    if (!this.body) return;
    const c = new THREE.Color(color);
    this.body.traverse((o: any) => {
      if (!o.isMesh) return;
      const m = o.material as any;
      if (!m) return;
      const mats = Array.isArray(m) ? m : [m];
      for (const mat of mats) {
        if (mat.userData.__orig === undefined) mat.userData.__orig = mat.color ? mat.color.clone() : null;
        const name = (mat.name || '').toLowerCase();
        const looksBody = mat.userData.__orig && !/glass|window|tyre|tire|rubber|brake|light|chrome|glass|interior|leather|dial|screen/.test(name);
        if (looksBody && mat.color && mat.color.getHex() !== 0x000000) {
          const base = mat.userData.__orig as THREE.Color;
          const lum = base.r * 0.3 + base.g * 0.6 + base.b * 0.1;
          if (lum < 0.55 && base.getHex() !== 0xffffff) mat.color.copy(base).lerp(c, 0.55);
        }
      }
    });
  }

  specFor(carId: string): CarSpec {
    const info = this.cars.find((c) => c.id === carId) || this.cars[0];
    return specFromCarJson(info);
  }

  addRemote(id: string, name: string, color: string, carId: string) {
    if (this.remotes.has(id)) return;
    const { root, body, wheels } = this.makeRig(carId, color, true);
    root.visible = false;
    this.scene.add(root);
    const tag = this.makeTag(name, color);
    this.scene.add(tag);
    this.remotes.set(id, { id, name, color, car: carId, root, body, wheels: [], buf: [], tag, lastSeen: performance.now(), wheelAngle: 0 });
  }

  removeRemote(id: string) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.root);
    if (r.tag) { this.scene.remove(r.tag); (r.tag.material as THREE.SpriteMaterial).map?.dispose(); r.tag.material.dispose(); }
    // meshes of a car share geometry between every player using it, so only the scene link goes
    this.remotes.delete(id);
  }

  private makeTag(name: string, color: string): THREE.Sprite {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d')!;
    g.fillStyle = 'rgba(6,9,16,0.72)';
    roundRect(g, 4, 10, 248, 44, 12); g.fill();
    g.strokeStyle = color; g.lineWidth = 2; roundRect(g, 4, 10, 248, 44, 12); g.stroke();
    g.fillStyle = '#eef2ff';
    g.font = 'bold 26px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name.slice(0, 14), 128, 33);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    sp.scale.set(3.1, 0.78, 1);
    sp.visible = this.settings.nameTags;
    return sp;
  }

  applySnapshots(cars: { id: string; p?: number[]; q?: number[]; sp?: number }[], localId: string) {
    const now = performance.now();
    for (const c of cars) {
      if (c.id === localId) continue;
      const r = this.remotes.get(c.id);
      if (!r || !c.p || !c.q) continue;
      r.lastSeen = now;
      r.buf.push({ t: now, p: new THREE.Vector3(c.p[0], c.p[1], c.p[2]), q: new THREE.Quaternion(c.q[0], c.q[1], c.q[2], c.q[3]), speed: c.sp || 0 });
      if (r.buf.length > 24) r.buf.shift();
    }
  }

  /* ------------------------------------------------------------ race logic -- */
  private pathPoint(s: number, lateral = 0) {
    if (!this.path) return { x: 0, z: 0, yaw: 0 };
    const { pts, n, cum, len } = this.path;
    const arc = ((s % len) + len) % len;
    let i = 0;
    while (i < n - 1 && cum[i + 1] <= arc) i++;
    const a = pts[i], b = pts[(i + 1) % n];
    const segLen = Math.max(1e-6, cum[i + 1] - cum[i]);
    const t = (arc - cum[i]) / segLen;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L, nz = dx / L;
    return { x: a[0] + dx * t + nx * lateral, z: a[1] + dz * t + nz * lateral, yaw: Math.atan2(-dx / L, -dz / L) };
  }

  private nearestPath(x: number, z: number, hint: number) {
    if (!this.path) return { idx: 0, off: 0, arc: 0 };
    const { pts, n, cum } = this.path;
    let best = hint, bd = Infinity;
    for (let k = -26; k <= 40; k++) {
      const i = (hint + k + n) % n;
      const d = (pts[i][0] - x) ** 2 + (pts[i][1] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    // refine against the two neighbouring segments
    let bestArc = cum[best], boff = Math.sqrt(bd);
    for (const i of [best, (best - 1 + n) % n]) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const L2 = dx * dx + dz * dz || 1;
      let t = ((x - a[0]) * dx + (z - a[1]) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const px = a[0] + dx * t, pz = a[1] + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < boff) { boff = d; bestArc = cum[i] + t * Math.sqrt(L2); best = i; }
    }
    return { idx: best, off: boff, arc: bestArc };
  }

  startRace(laps: number, startedAt: number) {
    this.laps = Math.max(1, laps || 3);
    this.racing = true;
    this.finished = false;
    this.finishTime = null;
    this.lap = 0;
    this.lastLap = null;
    this.bestLap = null;
    this.lapDelta = null;
    this.lapStart = startedAt || performance.now();
    this.raceStart = startedAt || performance.now();
    this.progress = 0;
    this.nitrous = 1;
    this.lastIdx = 0;
  }

  /** line the local car up on the starting grid (called the moment the host deploys) */
  enterGrid(index: number, total: number) {
    if (!this.sim || !this.path) return;
    const slot = gridSlot(index);
    const start = this.pathPoint(slot.s, slot.lateral);
    this.sim.reset({ x: start.x, z: start.z, yaw: start.yaw });
    this.sim.settle(this.arena);
    const near = this.nearestPath(start.x, start.z, 0);
    this.lastIdx = near.idx;
    this.progress = 0;
    this.lap = 0;
    this.racing = false;
    this.finished = false;
    this.nitrous = 1;
    this.settings.camera = this.settings.camera === 'orbit' ? 'chase' : this.settings.camera;
    this.snapCamera(true);
    void total;
  }

  /** switch cars in the lobby: reload the model if needed, then rebuild sim + rig in place */
  async swapCar(carId: string) {
    if (carId === this.carId) return;
    if (!this.cars.some((c) => c.id === carId)) return;
    await this.loadCar(carId);
    this.carId = carId;
    const yaw = this.sim ? new THREE.Euler().setFromQuaternion(this.sim.quat, 'YXZ').y : 0;
    const at = this.sim ? { x: this.sim.pos.x, z: this.sim.pos.z, yaw } : { x: 0, z: 0, yaw: 0 };
    try {
      this.sim = new CarSim(this.specFor(carId), { ...ASSIST_PRESETS[this.settings.assist], autoShift: this.settings.assist !== 'sim' }, at);
      this.sim.settle(this.arena);
    } catch { /* keep the old sim if the spec is broken */ }
    if (this.rig) this.scene.remove(this.rig);
    const { root, body, wheels } = this.makeRig(carId, this.playerColor, false);
    this.rig = root; this.body = body; this.wheels = wheels;
    this.scene.add(root);
    this.tintColor(this.playerColor);
    this.syncLocal();
  }

  removeAllRemotes() {
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
  }

  finish() {
    this.racing = false;
    this.finished = true;
    this.finishTime = performance.now() - this.raceStart;
    this.pendingEvents.push({ kind: 'finish', data: this.finishTime });
  }

  respawn(reset?: boolean) {
    if (!this.sim || !this.path) return;
    const near = this.nearestPath(this.sim.pos.x, this.sim.pos.z, reset ? 0 : this.lastIdx);
    const p = this.pathPoint(near.arc);
    const spec = this.sim.spec;
    this.sim.reset({ x: p.x, z: p.z, yaw: p.yaw });
    this.sim.settle(this.arena);
    this.lastIdx = near.idx;
    this.progress = near.arc;
    if (reset) { this.wrongFor = 0; this.offTrackFor = 0; }
    this.pendingEvents.push({ kind: 'respawn' });
    void spec;
  }

  private updateRace(dt: number) {
    if (!this.path || !this.sim) return;
    const near = this.nearestPath(this.sim.pos.x, this.sim.pos.z, this.lastIdx);
    const prevArc = this.progress;
    let arc = near.arc;
    // unwrap across the start line
    while (arc - prevArc > this.path.len / 2) arc -= this.path.len;
    while (prevArc - arc > this.path.len / 2) arc += this.path.len;
    const delta = arc - prevArc;
    if (this.racing && delta > 0) this.progress += delta;
    else if (delta > 0 && !this.racing) this.progress = arc;
    this.lastIdx = near.idx;
    this.offTrack = near.off > 7.5;
    if (this.offTrack) this.offTrackFor += dt; else this.offTrackFor = 0;

    // wrong way: facing against the direction of travel while moving
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.sim.quat);
    const a = this.path.pts[this.lastIdx], b = this.path.pts[(this.lastIdx + 1) % this.path.n];
    const tx = b[0] - a[0], tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    const dot = (fwd.x * tx + fwd.z * tz) / tl;
    if (this.racing && dot < -0.35 && this.sim.vel.length() > 4) this.wrongFor += dt; else this.wrongFor = Math.max(0, this.wrongFor - dt * 2);
    this.wrongWay = this.wrongFor > 0.7;

    // lap counting: crossing the start line forwards after covering the circuit
    if (this.racing) {
      const wrapped = arc - prevArc < -this.path.len / 2 && arc < this.path.len * 0.25;
      if (wrapped && this.progress >= this.path.len * 0.85) {
        const now = performance.now();
        const time = now - this.lapStart;
        this.lap += 1;
        this.lastLap = time;
        this.lapDelta = this.bestLap != null ? time - this.bestLap : null;
        if (this.bestLap == null || time < this.bestLap) this.bestLap = time;
        this.lapStart = now;
        this.progress = 0;
        this.lastLapFlash = now;
        this.onLap?.({ lap: this.lap, time, best: this.bestLap, delta: this.lapDelta });
        this.sound.ui(this.lap > this.laps ? 'ok' : 'tick');
        if (this.lap > this.laps) this.finish();
      }
    }
  }

  /* ------------------------------------------------------------------ loop -- */
  start() {
    if (this.raf) return;
    this.clock.start();
    this.last = performance.now();
    const tick = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      const now = performance.now();
      let dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.fps = this.fps * 0.92 + (1 / Math.max(1e-3, dt)) * 0.08;
      if (!this.paused) this.update(dt * this.timeScale, dt);
      else this.render(dt);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clock.stop();
  }

  private update(dt: number, rawDt: number) {
    const controls = this.input.read(rawDt);
    this.lastControls = controls;
    if (controls.camera) {
      const modes = this.cameraModes();
      this.cameraModeIndex = (this.cameraModeIndex + 1) % modes.length;
      this.settings.camera = modes[this.cameraModeIndex];
    }
    if (controls.reset && this.sim) { this.respawn(true); rumble(0.2, 90); }

    // ---- fixed-step physics (same 120 Hz the headless tests use, so what is tuned there is
    //      what the player feels here)
    const STEP = 1 / 120;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < 6) {
      this.sim.step(STEP, {
        throttle: controls.throttle,
        brake: controls.brake,
        steer: controls.steer,
        handbrake: controls.handbrake,
        boost: controls.boost && this.nitrous > 0.01,
      }, this.arena, this.remoteBodies());
      this.acc -= STEP;
      steps++;
    }
    if (this.acc > 0.25) this.acc = 0;

    // nitrous: drains under boost, refills slowly
    if (controls.boost && this.nitrous > 0) this.nitrous = Math.max(0, this.nitrous - rawDt * 0.18);
    else this.nitrous = Math.min(1, this.nitrous + rawDt * 0.055);

    this.updateRace(rawDt);
    this.syncLocal();
    this.updateRemotes(rawDt);
    this.updateEffects(rawDt);
    this.updateCamera(rawDt, controls.lookBack);
    this.updateAudio();

    // ---- network: transforms at 20 Hz (the server's snapshot rate), inputs a little faster
    this.sendCarAcc += rawDt;
    this.inputAcc += rawDt;
    if (this.sendCarAcc > 1 / 20 && this.sim) {
      this.sendCarAcc = 0;
      this.onSendCar?.({
        p: [round2(this.sim.pos.x), round2(this.sim.pos.y), round2(this.sim.pos.z)],
        q: [r3(this.sim.quat.x), r3(this.sim.quat.y), r3(this.sim.quat.z), r3(this.sim.quat.w)],
        v: [round2(this.sim.vel.x), round2(this.sim.vel.y), round2(this.sim.vel.z)],
        sp: Math.round(this.sim.speedKmh),
        gear: this.sim.gear,
        rpm: Math.round(this.sim.rpm),
        dr: this.sim.drifting ? 1 : 0,
        bo: controls.boost && this.nitrous > 0 ? 1 : 0,
        w: this.sim.wheels.map((w) => r3(this.wheelVisualAngle(w))),
        hb: controls.handbrake ? 1 : 0,
        air: this.sim.onGround ? 0 : 1,
      });
    }
    if (this.inputAcc > 1 / 30) {
      this.inputAcc = 0;
      this.onSendInput?.({ th: controls.throttle, br: controls.brake, st: controls.steer, hb: controls.handbrake, bo: controls.boost && this.nitrous > 0 });
    }

    this.render(rawDt);
    this.hudTimer += rawDt;
    if (this.hudTimer > 0.1) { this.hudTimer = 0; this.hudCache = null; }
  }

  onSendCar: ((pose: any) => void) | null = null;
  onSendInput: ((input: any) => void) | null = null;

  /** hulls for car-vs-car contact: position, yaw, radius and the velocity we last heard */
  private remoteBodies() {
    const out: { x: number; z: number; r: number; vx: number; vz: number; yaw: number }[] = [];
    for (const r of this.remotes.values()) {
      if (!r.root.visible) continue;
      const info = this.cars.find((c) => c.id === r.car);
      const yaw = new THREE.Euler().setFromQuaternion(r.root.quaternion, 'YXZ').y;
      const last = r.buf[r.buf.length - 1];
      const prev = r.buf[Math.max(0, r.buf.length - 2)];
      const dt = Math.max(0.016, (last.t - prev.t) / 1000);
      out.push({
        x: r.root.position.x, z: r.root.position.z,
        r: (info?.realLength ?? 4.6) * 0.42,
        vx: (last.p.x - prev.p.x) / dt, vz: (last.p.z - prev.p.z) / dt, yaw,
      });
    }
    return out;
  }

  private wheelVisualAngle(w: any) {
    return w.spin ?? 0;
  }

  private syncLocal() {
    if (!this.rig || !this.sim) return;
    this.rig.position.copy(this.sim.pos);
    this.rig.quaternion.copy(this.sim.quat);
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.sim.wheels[i];
      if (!w) continue;
      const rig = this.wheels[i];
      rig.spin += w.omega * (1 / 120);
      const spinQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), rig.spin);
      if (w.front) {
        const steerQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), w.steer);
        rig.node.quaternion.copy(rig.q0).multiply(steerQ).multiply(spinQ);
      } else {
        rig.node.quaternion.copy(rig.q0).multiply(spinQ);
      }
    }
  }

  private updateRemotes(dt: number) {
    const now = performance.now();
    const renderTime = now - 110;
    for (const r of this.remotes.values()) {
      r.root.visible = false;
      if (r.tag) r.tag.visible = false;
      if (now - r.lastSeen > 6000) continue;
      const buf = r.buf;
      if (buf.length < 2) continue;
      let a = buf[0], b = buf[1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= renderTime && buf[i + 1].t >= renderTime) { a = buf[i]; b = buf[i + 1]; break; }
        if (buf[i + 1].t < renderTime) { a = buf[i + 1]; b = buf[Math.min(i + 2, buf.length - 1)]; }
      }
      const span = Math.max(1, b.t - a.t);
      const t = Math.min(1, Math.max(0, (renderTime - a.t) / span));
      r.root.visible = true;
      r.root.position.lerpVectors(a.p, b.p, t);
      r.root.quaternion.slerpQuaternions(a.q, b.q, t);
      r.wheelAngle += (a.speed / 3.6 / 0.34) * dt;
      for (const w of r.root.children) {
        void w;
      }
      if (r.tag) {
        r.tag.visible = this.settings.nameTags;
        r.tag.position.copy(r.root.position).add(new THREE.Vector3(0, 1.9, 0));
      }
    }
  }

  private updateEffects(dt: number) {
    if (!this.sim) return;
    const skid = this.settings.skidmarks && this.settings.quality !== 'low';
    this.skid.visible = skid;
    const smoke = this.settings.particles && this.settings.quality !== 'low';
    this.smoke.visible = smoke;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < this.sim.wheels.length; i++) {
      const w = this.sim.wheels[i];
      if (!w || w.load <= 0) continue;
      const slip = Math.min(1, Math.abs(w.slipRatio) * 5 + Math.abs(w.slipAngle) * 2.2);
      if (skid && slip > 0.34 && this.sim.onGround) {
        const p = w.contact;
        q.setFromUnitVectors(up, w.contactNormal);
        const yaw = new THREE.Euler().setFromQuaternion(this.sim.quat, 'YXZ').y;
        q.multiply(new THREE.Quaternion().setFromAxisAngle(up, yaw));
        m.compose(new THREE.Vector3(p.x, p.y + 0.012, p.z), q, scl.setScalar(0.75 + slip * 0.5));
        this.skid.setMatrixAt(this.skidIndex, m);
        this.skidTime[this.skidIndex] = performance.now();
        this.skidIndex = (this.skidIndex + 1) % this.skidTime.length;
        this.skid.instanceMatrix.needsUpdate = true;
      }
      if (smoke && slip > 0.5 && i >= 2) this.spawnSmoke(w.contact, slip, dt);
    }
    // fade skids
    const now = performance.now();
    let dirty = false;
    for (let i = 0; i < this.skidTime.length; i++) {
      if (this.skidTime[i] < 0) continue;
      const age = (now - this.skidTime[i]) / 1000;
      if (age > 9) { this.skid.setMatrixAt(i, m.makeScale(0, 0, 0)); this.skidTime[i] = -1; dirty = true; }
    }
    if (dirty) this.skid.instanceMatrix.needsUpdate = true;

    // smoke life
    const pos = this.smoke.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < this.smokeData.length; i++) {
      const s = this.smokeData[i];
      if (s.life <= 0) continue;
      s.life -= dt;
      const k = i * 3;
      pos.setX(i, pos.getX(i) + s.vx * dt);
      pos.setY(i, pos.getY(i) + s.vy * dt);
      pos.setZ(i, pos.getZ(i) + s.vz * dt);
      if (s.life <= 0) pos.setY(i, -1000);
    }
    pos.needsUpdate = true;
    for (const r of this.remotes.values()) {
      for (const w of r.wheels) void w;
    }
  }

  private spawnSmoke(at: THREE.Vector3, strength: number, dt: number) {
    const pos = this.smoke.geometry.getAttribute('position') as THREE.BufferAttribute;
    const i = this.smokeIndex;
    this.smokeIndex = (this.smokeIndex + 1) % this.smokeData.length;
    const s = this.smokeData[i];
    s.life = 1.1 + Math.random() * 0.7;
    s.vx = (Math.random() - 0.5) * 1.6;
    s.vy = 0.6 + Math.random() * 1.1 * strength;
    s.vz = (Math.random() - 0.5) * 1.6;
    pos.setXYZ(i, at.x + (Math.random() - 0.5) * 0.5, at.y + 0.15, at.z + (Math.random() - 0.5) * 0.5);
    void dt;
  }

  private cameraModes(): Settings['camera'][] { return ['chase', 'far', 'hood', 'bumper', 'orbit']; }

  private updateCamera(dt: number, lookBack: boolean) {
    if (!this.sim) return;
    const mode = this.settings.camera;
    const speed = this.sim.speedKmh / 3.6;
    const fov = this.settings.fov + Math.min(14, speed * 0.34);
    this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3);
    this.camera.updateProjectionMatrix();

    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.sim.quat);
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const baseY = this.sim.pos.y;
    let target = new THREE.Vector3();
    let look = new THREE.Vector3();
    if (mode === 'hood') {
      target.copy(this.sim.pos).addScaledVector(fwd, 0.35).addScaledVector(right, 0).add(new THREE.Vector3(0, 1.02, 0));
      look.copy(target).addScaledVector(fwd, 12).add(new THREE.Vector3(0, -0.25, 0));
    } else if (mode === 'bumper') {
      target.copy(this.sim.pos).addScaledVector(fwd, 1.65).add(new THREE.Vector3(0, 0.55, 0));
      look.copy(target).addScaledVector(fwd, 14);
    } else if (mode === 'orbit') {
      const t = performance.now() / 1000 * 0.24;
      const r = 9 + speed * 0.06;
      target.set(this.sim.pos.x + Math.cos(t) * r, baseY + 3.1, this.sim.pos.z + Math.sin(t) * r);
      look.copy(this.sim.pos).add(new THREE.Vector3(0, 0.7, 0));
    } else {
      const dist = mode === 'far' ? 9.2 : 6.0;
      const height = mode === 'far' ? 3.4 : 2.25;
      const back = lookBack ? -1 : 1;
      target.copy(this.sim.pos).addScaledVector(fwd, -dist * back).add(new THREE.Vector3(0, height, 0));
      // keep the camera out of walls
      look.copy(this.sim.pos).addScaledVector(fwd, lookBack ? -6 : 9).add(new THREE.Vector3(0, 0.75, 0));
      const probe = this.arena.solidAt(target.x, target.z);
      if (probe > 0) {
        const inward = this.sim.pos.clone().sub(target).setY(0).normalize();
        target.addScaledVector(inward, 2.2 * probe);
        target.y += 0.7 * probe;
      }
    }
    const follow = mode === 'hood' || mode === 'bumper' ? 24 : mode === 'orbit' ? 7 : 9.5;
    this.camPos.lerp(target, Math.min(1, dt * follow));
    this.camLook.lerp(look, Math.min(1, dt * (follow * 0.85)));
    // a little shake from impacts and kerbs so the car feels like it has weight
    const shakeAmt = (this.sim.wallContact ? 0.22 : 0) + Math.min(0.16, Math.abs(this.sim.gLat) * 0.012) + (this.sim.onGround ? 0 : 0.1);
    this.shake = lerp(this.shake, shakeAmt * this.settings.cameraShake, Math.min(1, dt * 8));
    const jitter = this.shake * 0.28;
    this.camera.position.set(
      this.camPos.x + (Math.random() - 0.5) * jitter,
      Math.max(this.camPos.y + (Math.random() - 0.5) * jitter, this.groundFloor() + 0.45),
      this.camPos.z + (Math.random() - 0.5) * jitter,
    );
    this.camera.lookAt(this.camLook);
    const roll = THREE.MathUtils.clamp(-this.sim.gLat * 0.012, -0.06, 0.06);
    this.camera.rotateZ(roll + (Math.random() - 0.5) * this.shake * 0.012);
    this.sun.target.position.copy(this.sim.pos);
    this.sun.position.copy(this.sim.pos).add(new THREE.Vector3(-0.42, 0.42, 0.8).normalize().multiplyScalar(220));
    this.sun.target.updateMatrixWorld();
  }

  private groundFloor() {
    if (!this.sim) return 0;
    return this.arena.heightAt(this.sim.pos.x, this.sim.pos.z);
  }

  private snapCamera(immediate = false) {
    if (!this.sim) return;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.sim.quat);
    this.camPos.copy(this.sim.pos).addScaledVector(fwd, -6).add(new THREE.Vector3(0, 2.25, 0));
    this.camLook.copy(this.sim.pos).addScaledVector(fwd, 9).add(new THREE.Vector3(0, 0.75, 0));
    if (immediate) this.camera.position.copy(this.camPos);
  }

  private updateAudio() {
    if (!this.sim) return;
    const w = this.sim.wheels;
    const slip = Math.max(...w.map((x) => Math.min(1, Math.abs(x.slipRatio) * 4 + Math.abs(x.slipAngle) * 2)));
    this.sound.update({
      rpm: this.sim.rpm, throttle: this.lastControls.throttle, speed: this.sim.speedKmh,
      slip, airborne: !this.sim.onGround, gear: this.sim.gear,
    });
  }

  private render(dt: number) {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY[this.settings.quality].pixelRatio);
    const needW = Math.max(1, Math.floor(w * dpr)), needH = Math.max(1, Math.floor(h * dpr));
    if (this.canvas.width !== needW || this.canvas.height !== needH) {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(needW / dpr, needH / dpr, false);
      this.renderer.setViewport(0, 0, needW / dpr, needH / dpr);
      this.composer?.setSize(needW / dpr, needH / dpr);
      this.bloom?.setSize(needW / dpr, needH / dpr);
      this.camera.aspect = needW / needH;
      this.camera.updateProjectionMatrix();
    }
    if (this.composer && this.bloom?.enabled) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  /* ------------------------------------------------------------------- api -- */
  setSettings(s: Settings) {
    const prev = this.settings;
    this.settings = s;
    this.input.update(s);
    this.renderer.shadowMap.enabled = s.shadows;
    this.sun.castShadow = s.shadows;
    this.scene.environmentIntensity = s.quality === 'low' ? 0.25 : s.quality === 'ultra' ? 0.7 : 0.5;
    if (this.bloom) this.bloom.enabled = s.bloom && QUALITY[s.quality].bloom;
    if (this.skid) this.skid.visible = s.skidmarks;
    if (this.smoke) this.smoke.visible = s.particles;
    for (const r of this.remotes.values()) if (r.tag) r.tag.visible = s.nameTags;
    if (this.sim && prev.assist !== s.assist) {
      const spec = this.sim.spec;
      this.sim.assists = { ...ASSIST_PRESETS[s.assist], autoShift: s.assist !== 'sim' };
      void spec;
    }
    this.sound.setVolumes({ master: s.volumeMaster, engine: s.volumeEngine, tyres: s.volumeTyres });
  }

  takeEvents() {
    const e = this.pendingEvents.slice();
    this.pendingEvents.length = 0;
    return e;
  }

  hud(): SessionHud {
    if (this.hudCache) return this.hudCache;
    const sim = this.sim;
    const standings: Standing[] = [...this.standingsData()];
    const leader = standings.find((s) => s.position === 1);
    for (const s of standings) {
      s.gap = s.id === this.playerId ? 0 : (this.lap - leader!.lap) * (this.path?.len ?? 0) + (this.progress - 0);
    }
    const st: SessionHud = {
      speed: sim ? Math.round(sim.speedKmh) : 0,
      gear: sim ? sim.gear : 0,
      rpm: sim ? sim.rpm : 0,
      redline: sim ? sim.spec.redline : 8000,
      nitrous: this.nitrous,
      throttle: this.lastControls.throttle,
      brake: this.lastControls.brake,
      steer: this.lastControls.steer,
      drifting: !!sim?.drifting,
      airborne: sim ? !sim.onGround : false,
      wallContact: !!sim && sim.wallContact > 0.2,
      offTrack: this.offTrack && this.offTrackFor > 0.4,
      wrongWay: this.wrongWay,
      lap: Math.min(this.lap + 1, this.laps + 1),
      laps: this.laps,
      position: this.position,
      total: this.total,
      lapTime: this.racing ? performance.now() - this.lapStart : 0,
      lastLap: this.lastLap,
      bestLap: this.bestLap,
      lapDelta: this.lapDelta,
      raceTime: this.racing ? performance.now() - this.raceStart : this.finishTime ?? 0,
      standings,
      progress: this.path ? THREE.MathUtils.clamp(this.progress / this.path.len, 0, 1) : 0,
      countdown: this.countdown,
      racing: this.racing,
      finished: this.finished,
      rtt: 0,
      fps: Math.round(this.fps),
      cars: 1 + [...this.remotes.values()].filter((r) => r.root.visible).length,
    };
    this.hudCache = st;
    return st;
  }

  private standingsSource: Standing[] = [];
  setStandings(list: Standing[]) { this.standingsSource = list; }
  private standingsData() { return this.standingsSource; }

  set player(id: string) { this.playerId = id; }

  dispose() {
    this.disposed = true;
    this.stop();
    this.sound.dispose();
    this.input.dispose();
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
    if (this.rig) this.scene.remove(this.rig);
    if (this.worldRoot) { this.scene.remove(this.worldRoot); disposeTree(this.worldRoot); }
    this.skid?.geometry.dispose();
    (this.skid?.material as THREE.Material | undefined)?.dispose();
    this.smoke?.geometry.dispose();
    (this.smoke?.material as THREE.Material | undefined)?.dispose();
    for (const t of this.tags) { (t.material as THREE.SpriteMaterial).map?.dispose(); t.material.dispose(); }
    this.renderer.dispose();
  }
}

/* ----------------------------------------------------------------- helpers -- */
function gridSlot(index: number) {
  const row = Math.floor(index / GRID_ROWS);
  const col = index % GRID_ROWS;
  const s = -(row * GRID_GAP + 3.5);
  const lateral = (col - (GRID_ROWS - 1) / 2) * GRID_SIDE * 2;
  return { s, lateral };
}

function round2(v: number) { return Math.round(v * 100) / 100; }
function r3(v: number) { return Math.round(v * 1000) / 1000; }

function cloneSkinned(src: THREE.Object3D): THREE.Object3D {
  const clone = src.clone(true);
  const srcNodes: THREE.Object3D[] = [];
  const dstNodes: THREE.Object3D[] = [];
  src.traverse((o) => srcNodes.push(o));
  clone.traverse((o) => dstNodes.push(o));
  for (let i = 0; i < srcNodes.length; i++) {
    const s = srcNodes[i] as any, d = dstNodes[i] as any;
    if (s.isSkinnedMesh && d.isSkinnedMesh) d.bind(s.skeleton, s.bindMatrix);
    if (s.isMesh && d.isMesh) d.material = s.material;
  }
  return clone;
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((c: any) => {
    if (c.geometry) c.geometry.dispose?.();
  });
}

function makeSmokeTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.34)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  return t;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
