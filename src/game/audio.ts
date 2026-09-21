/**
 * CyberKhyal — engine, tyre and wind audio.
 *
 * Synthesised rather than sampled: an engine note follows the tachometer (two detuned saw stacks
 * plus a sub, through a lowpass that opens with throttle), the tyres are filtered noise driven by
 * slip, and wind follows speed. Nothing is loaded from disk, so the race starts instantly.
 */

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engines: OscillatorNode[] = [];
  private engineFilter!: BiquadFilterNode;
  private sub!: OscillatorNode;
  private subGain!: GainNode;
  private tyreGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private started = false;
  private muted = false;
  private volume = { master: 0.75, engine: 0.8, tyres: 0.55 };

  get ready() { return this.started; }

  async resume() {
    if (this.started || typeof window === 'undefined') return;
    const Ctor: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    try { await ctx.resume(); } catch { /* autoplay policy: will retry on the next gesture */ }

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume.master;
    this.master.connect(ctx.destination);

    // ---- engine: three saw layers + a sub, through a throttle-driven lowpass
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 5;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.master);
    const ratios = [0.5, 1, 1.5, 2.02];
    for (const r of ratios) {
      const osc = ctx.createOscillator();
      osc.type = r < 1 ? 'square' : 'sawtooth';
      osc.frequency.value = 60 * r;
      const g = ctx.createGain();
      g.gain.value = r < 1 ? 0.5 : r > 1.6 ? 0.18 : 0.34;
      osc.connect(g).connect(this.engineFilter);
      osc.start();
      this.engines.push(osc);
    }
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 40;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.24;
    this.sub.connect(this.subGain).connect(this.master);
    this.sub.start();

    // ---- tyres + wind share a noise buffer
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise.buffer = buf;
    noise.loop = true;

    const tyreFilter = ctx.createBiquadFilter();
    tyreFilter.type = 'bandpass';
    tyreFilter.frequency.value = 2400;
    tyreFilter.Q.value = 1.1;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    noise.connect(tyreFilter).connect(this.tyreGain).connect(this.master);

    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise.connect(this.windFilter).connect(this.windGain).connect(this.master);

    noise.start();
    this.started = true;
  }

  setVolumes(v: { master: number; engine: number; tyres: number }) {
    this.volume = v;
    if (!this.started) return;
    this.master.gain.value = this.muted ? 0 : v.master;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.started) this.master.gain.value = m ? 0 : this.volume.master;
  }

  update(o: { rpm: number; throttle: number; speed: number; slip: number; airborne: boolean; gear: number }) {
    if (!this.started || !this.ctx) return;
    const t = this.ctx.currentTime;
    const base = Math.max(22, (o.rpm / 60) * 2.05);
    for (let i = 0; i < this.engines.length; i++) {
      const r = [0.5, 1, 1.5, 2.02][i];
      this.engines[i].frequency.setTargetAtTime(base * r, t, 0.02);
    }
    this.sub.frequency.setTargetAtTime(base * 0.5, t, 0.03);
    const load = 0.22 + 0.78 * o.throttle;
    const revs = Math.min(1, o.rpm / 7600);
    this.engineGain.gain.setTargetAtTime(this.volume.engine * (0.16 + 0.5 * revs) * load * (o.airborne ? 0.7 : 1), t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(420 + 2600 * o.throttle + 1400 * revs, t, 0.06);
    this.subGain.gain.setTargetAtTime(this.volume.engine * 0.1 * (0.3 + revs), t, 0.08);

    const speedN = Math.min(1, o.speed / 85);
    this.tyreGain.gain.setTargetAtTime(this.volume.tyres * Math.min(1, o.slip) * (o.airborne ? 0.15 : 1) * 0.5, t, 0.05);
    this.windGain.gain.setTargetAtTime(this.volume.tyres * speedN * speedN * 0.32, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + 1800 * speedN, t, 0.1);
  }

  impact(strength: number) {
    if (!this.started || !this.ctx || strength < 0.5) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const decay = 0.08 + Math.min(0.5, strength / 30);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-(i / ctx.sampleRate) / decay);
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420 + strength * 30;
    const g = ctx.createGain();
    g.gain.value = Math.min(0.6, 0.1 + strength / 45) * this.volume.master;
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + 0.4);
  }

  ui(kind: 'tick' | 'go' | 'click' | 'ok' | 'bad' = 'click') {
    if (!this.started || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = kind === 'go' ? 880 : kind === 'tick' ? 440 : kind === 'ok' ? 660 : kind === 'bad' ? 180 : 300;
    o.type = kind === 'bad' ? 'sawtooth' : 'triangle';
    o.frequency.setValueAtTime(f, t);
    if (kind === 'go') o.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.25);
    const dur = kind === 'go' ? 0.5 : 0.09;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * this.volume.master, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  dispose() {
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.started = false;
    this.engines = [];
  }
}
