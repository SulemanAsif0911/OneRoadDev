/**
 * CyberKhyal — player settings.
 *
 * Everything the player can change lives here, is versioned, and is stored locally so the
 * menu, the HUD, the input layer and the renderer all read the same object.
 */

export type AssistName = 'arcade' | 'sport' | 'pro' | 'sim';
export type CameraName = 'chase' | 'far' | 'hood' | 'bumper' | 'orbit';
export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export type Bindings = Record<BindAction, string[]>;
export type BindAction =
  | 'throttle' | 'brake' | 'left' | 'right' | 'handbrake' | 'boost' | 'reset' | 'camera' | 'lookBack' | 'chat';

export type Settings = {
  name: string;
  car: string;
  assist: AssistName;
  camera: CameraName;
  fov: number;
  quality: QualityName;
  shadows: boolean;
  bloom: boolean;
  particles: boolean;
  skidmarks: boolean;
  nameTags: boolean;
  units: 'kmh' | 'mph';
  steeringSensitivity: number;
  steeringSmooth: number;
  gamepad: boolean;
  touch: boolean;
  volumeMaster: number;
  volumeEngine: number;
  volumeTyres: number;
  cameraShake: number;
  invertLook: boolean;
  bindings: Bindings;
};

export const ACTIONS: { id: BindAction; label: string; hint: string }[] = [
  { id: 'throttle', label: 'Throttle', hint: 'Accelerate' },
  { id: 'brake', label: 'Brake / Reverse', hint: 'Slow down, then reverse' },
  { id: 'left', label: 'Steer left', hint: '' },
  { id: 'right', label: 'Steer right', hint: '' },
  { id: 'handbrake', label: 'Handbrake', hint: 'Locks the rear axle — start a drift' },
  { id: 'boost', label: 'Nitro', hint: 'Extra power while it lasts' },
  { id: 'reset', label: 'Reset to track', hint: 'Recover from a crash' },
  { id: 'camera', label: 'Change camera', hint: '' },
  { id: 'lookBack', label: 'Look back', hint: 'Hold to look behind' },
  { id: 'chat', label: 'Chat', hint: 'Open the chat box' },
];

export const DEFAULT_BINDINGS: Bindings = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  boost: ['ShiftLeft', 'ShiftRight'],
  reset: ['KeyR'],
  camera: ['KeyC'],
  lookBack: ['KeyB'],
  chat: ['KeyT'],
};

export const DEFAULT_SETTINGS: Settings = {
  name: '',
  car: '2017_lamborghini_huracan_mansory',
  assist: 'sport',
  camera: 'chase',
  fov: 68,
  quality: 'high',
  shadows: true,
  bloom: true,
  particles: true,
  skidmarks: true,
  nameTags: true,
  units: 'kmh',
  steeringSensitivity: 0.9,
  steeringSmooth: 0.55,
  gamepad: true,
  touch: true,
  volumeMaster: 0.75,
  volumeEngine: 0.8,
  volumeTyres: 0.55,
  cameraShake: 0.7,
  invertLook: false,
  bindings: DEFAULT_BINDINGS,
};

const KEY = 'cyberkhyal.settings.v1';

export function loadSettings(): Settings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, name: autoName() };
    const saved = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      bindings: { ...DEFAULT_BINDINGS, ...(saved.bindings || {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try { window.localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export function autoName() {
  const words = ['Falcon', 'Khyal', 'Comet', 'Vector', 'Sable', 'Nitro', 'Ember', 'Onyx', 'Zenith', 'Rift', 'Apex', 'Drift'];
  const w = words[Math.floor(Math.random() * words.length)];
  return `${w}${Math.floor(10 + Math.random() * 89)}`;
}

export const QUALITY: Record<QualityName, { shadowSize: number; pixelRatio: number; bloom: boolean; anisotropy: number; label: string }> = {
  low: { shadowSize: 1024, pixelRatio: 0.75, bloom: false, anisotropy: 1, label: 'Low' },
  medium: { shadowSize: 2048, pixelRatio: 1, bloom: false, anisotropy: 2, label: 'Medium' },
  high: { shadowSize: 3072, pixelRatio: 1, bloom: true, anisotropy: 4, label: 'High' },
  ultra: { shadowSize: 4096, pixelRatio: 1.5, bloom: true, anisotropy: 8, label: 'Ultra' },
};

export const KEY_LABEL: Record<string, string> = {
  Space: 'Space', ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
  AltLeft: 'L Alt', AltRight: 'R Alt', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
};

export function keyLabel(code: string) {
  if (!code) return '—';
  if (KEY_LABEL[code]) return KEY_LABEL[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

export function formatTime(ms: number | null | undefined, showMs = true): string {
  if (ms == null || !isFinite(ms)) return '--:--.---';
  if (ms < 0) ms = 0;
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const mss = Math.floor(ms % 1000);
  const base = `${m}:${String(s).padStart(2, '0')}`;
  return showMs ? `${base}.${String(mss).padStart(3, '0')}` : base;
}

export function formatGap(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return '—';
  return `+${(ms / 1000).toFixed(3)}`;
}
