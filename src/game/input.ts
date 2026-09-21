/**
 * CyberKhyal — input.
 *
 * Keyboard, gamepad and touch all funnel into one small state object, so the physics only ever
 * sees throttle / brake / steer / handbrake / boost. Steering is smoothed here (that is what
 * makes a keyboard feel like a wheel) and the smoothing is exposed in the settings.
 */
import type { Bindings, Settings } from './settings';

export type Controls = {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  boost: boolean;
  // one-shot intents consumed by the session
  reset: boolean;
  camera: boolean;
  lookBack: boolean;
};

const DEADZONE = 0.14;

export class InputManager {
  private keys = new Set<string>();
  private pressed: string[] = [];
  private touch = { throttle: 0, brake: 0, left: 0, right: 0, handbrake: 0, boost: 0 };
  private bindings: Bindings;
  private settings: Settings;
  private steerState = 0;
  private steerVel = 0;
  private padIndex: number | null = null;
  private listeners: (() => void)[] = [];
  enabled = true;
  /** set while the player is typing in a text field so the car does not react to the keyboard */
  private typing = false;
  private onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    this.typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (this.typing) return;
    if (e.repeat) { this.keys.add(e.code); return; }
    this.keys.add(e.code);
    this.pressed.push(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.code); };
  private onBlur = () => { this.keys.clear(); };

  constructor(settings: Settings) {
    this.settings = settings;
    this.bindings = settings.bindings;
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown, { passive: false });
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.onBlur);
    }
  }

  dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.onBlur);
    }
  }

  update(settings: Settings) {
    this.settings = settings;
    this.bindings = settings.bindings;
  }

  private held(action: keyof Bindings) {
    for (const code of this.bindings[action] || []) if (this.keys.has(code)) return true;
    return false;
  }

  private consume(action: keyof Bindings) {
    const list = this.bindings[action] || [];
    for (let i = 0; i < this.pressed.length; i++) {
      if (list.includes(this.pressed[i])) { this.pressed.splice(i, 1); return true; }
    }
    return false;
  }

  setTouch(part: 'throttle' | 'brake' | 'left' | 'right' | 'handbrake' | 'boost', on: boolean) {
    this.touch[part] = on ? 1 : 0;
  }

  /** read + clear the one-shot intents (call once per frame) */
  read(dt: number): Controls {
    let throttle = this.held('throttle') ? 1 : 0;
    let brake = this.held('brake') ? 1 : 0;
    let steerTarget = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    let handbrake = this.held('handbrake');
    let boost = this.held('boost');

    // ---- gamepad (triggers for throttle/brake, stick for steering, A for handbrake, X for boost)
    if (this.settings.gamepad && typeof navigator !== 'undefined' && navigator.getGamepads) {
      const pads = navigator.getGamepads();
      let pad: Gamepad | null = null;
      for (const p of pads) if (p && p.connected) { pad = p; break; }
      if (pad) {
        const ax = pad.axes[0] ?? 0;
        if (Math.abs(ax) > DEADZONE) steerTarget = Math.sign(ax) * ((Math.abs(ax) - DEADZONE) / (1 - DEADZONE)) ** 1.4;
        const rt = pad.buttons[7]?.value ?? 0;
        const lt = pad.buttons[6]?.value ?? 0;
        if (rt > 0.02) throttle = Math.max(throttle, rt);
        if (lt > 0.02) brake = Math.max(brake, lt);
        if (pad.buttons[0]?.pressed) handbrake = true;
        if (pad.buttons[2]?.pressed) boost = true;
        if (pad.buttons[1]?.pressed) this.pressed.push('KeyC');
        if (pad.buttons[3]?.pressed) this.pressed.push('KeyR');
      }
    }

    // ---- touch
    if (this.touch.right) steerTarget += 1;
    if (this.touch.left) steerTarget -= 1;
    throttle = Math.max(throttle, this.touch.throttle);
    brake = Math.max(brake, this.touch.brake);
    if (this.touch.handbrake) handbrake = true;
    if (this.touch.boost) boost = true;

    // ---- steering feel: sensitivity + smoothing (a curve so small inputs stay gentle)
    const sens = this.settings.steeringSensitivity;
    const shaped = Math.sign(steerTarget) * Math.abs(steerTarget) ** (1.35 - 0.5 * (sens - 0.5));
    const target = this.enabled ? shaped : 0;
    const smooth = 0.06 + 0.5 * this.settings.steeringSmooth;
    this.steerState += (target - this.steerState) * Math.min(1, dt / Math.max(0.016, smooth * 0.35));
    if (Math.abs(this.steerState) < 0.0015) this.steerState = 0;

    const out: Controls = {
      throttle: this.enabled ? throttle : 0,
      brake: this.enabled ? brake : 0,
      steer: this.steerState,
      handbrake: handbrake && this.enabled,
      boost: boost && this.enabled,
      reset: this.enabled && this.consume('reset'),
      camera: this.enabled && this.consume('camera'),
      lookBack: this.enabled && this.held('lookBack'),
    };
    return out;
  }

  clearPressed() { this.pressed.length = 0; }
  get isTyping() { return this.typing; }
}

export function rumble(strength = 0.4, ms = 120) {
  try {
    const pads = navigator.getGamepads?.() || [];
    for (const p of pads) {
      const act = (p as any)?.vibrationActuator;
      if (act?.playEffect) {
        act.playEffect('dual-rumble', { startDelay: 0, duration: ms, weakMagnitude: strength * 0.6, strongMagnitude: strength });
        break;
      }
    }
  } catch { /* not supported */ }
}
