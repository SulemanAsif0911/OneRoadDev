/**
 * CyberKhyal — websocket client.
 *
 * One socket carries the whole game: lobby, deploy, live car transforms, race state and chat.
 * Everything the UI shows is derived from the messages that arrive here, so this file is the
 * only place that knows what the wire looks like.
 */
export type RosterPlayer = {
  id: string; name: string; car: string; color: string; ready: boolean; ping: number;
  lap: number; best: number | null; finished: boolean; finishTime: number | null; position: number;
};

export type RaceResult = {
  id: string; name: string; car: string; color: string; lap: number; best: number | null;
  total: number | null; finished: boolean; position: number; topSpeed: number; drift: number;
};

export type CarSnap = {
  id: string; p: [number, number, number]; q: [number, number, number, number]; v?: [number, number, number];
  sp: number; gear: number; rpm: number; dr: number; bo: number; w?: number[]; hb: number; air: number;
  lap: number; cp: number; best: number | null; finished: boolean; position: number; ww: number;
};

export type ChatLine = { id: string; name: string; color: string; text: string; ts: number; system?: boolean };

export type LobbyState = {
  code: string; state: RoomState; hostId: string | null; laps: number; players: RosterPlayer[];
};

export type RoomState = 'offline' | 'lobby' | 'countdown' | 'racing' | 'finished';

type Handlers = {
  welcome: (m: any) => void;
  room: (m: LobbyState & { you?: string; host?: boolean }) => void;
  state: (m: { state: RoomState; countdownEnd?: number; startedAt?: number; laps?: number }) => void;
  snap: (m: { ts: number; state: RoomState; cars: CarSnap[] }) => void;
  race: (m: { reason: string; results: RaceResult[] }) => void;
  lap: (m: { id: string; name: string; lap: number; time: number; best: number }) => void;
  event: (m: { kind: string; id?: string; name?: string; position?: number; time?: number; hostId?: string }) => void;
  chat: (m: ChatLine) => void;
  error: (m: { code: string; msg: string }) => void;
  joined: (m: { id?: string; name?: string }) => void;
  left: (m: { id: string; name?: string }) => void;
  kick: (m: { msg: string }) => void;
  status: (m: { connected: boolean; rtt: number }) => void;
};

export class Net {
  private ws: WebSocket | null = null;
  private handlers: Partial<Handlers> = {};
  private queue: any[] = [];
  private retry = 0;
  private timer: any = null;
  private pingTimer: any = null;
  private pingSent = 0;
  connected = false;
  rtt = 0;
  you: string | null = null;
  host = false;
  room: LobbyState | null = null;
  countdownEnd = 0;
  startedAt = 0;
  private wantOpen = false;

  on<K extends keyof Handlers>(event: K, fn: Handlers[K]) {
    this.handlers[event] = fn;
    return this;
  }

  private emit<K extends keyof Handlers>(event: K, msg: any) {
    const fn = this.handlers[event];
    if (fn) fn(msg as any);
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.wantOpen = true;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // same origin: the game server that served this page also owns /ws, which is what lets
    // every player on the LAN join the host with nothing but a browser.
    const url = `${proto}//${location.host}/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.emit('status', { connected: true, rtt: this.rtt });
      this.send({ t: 'hello' });
      for (const m of this.queue.splice(0)) this.send(m);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        this.pingSent = Date.now();
        this.send({ t: 'ping', ts: this.pingSent });
      }, 2000);
    };
    ws.onclose = () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      this.emit('status', { connected: false, rtt: this.rtt });
      if (this.wantOpen) this.scheduleRetry();
    };
    ws.onerror = () => { /* onclose handles it */ };
    ws.onmessage = (ev) => this.handle(ev.data);
  }

  private scheduleRetry() {
    clearTimeout(this.timer);
    const delay = Math.min(6000, 500 * 2 ** Math.min(4, this.retry++));
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private handle(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'welcome': this.emit('welcome', m); break;
      case 'pong': this.rtt = Math.max(0, Date.now() - (m.ts || Date.now())); this.emit('status', { connected: true, rtt: this.rtt }); break;
      case 'room': {
        this.you = m.you ?? this.you;
        this.host = !!m.host || m.hostId === this.you;
        this.room = { code: m.code, state: m.state, hostId: m.hostId, laps: m.laps, players: m.players || [] };
        this.emit('room', m);
        break;
      }
      case 'state':
        if (m.state === 'countdown') this.countdownEnd = m.countdownEnd || 0;
        if (m.state === 'racing') this.startedAt = m.startedAt || Date.now();
        if (this.room) this.room.state = m.state;
        this.emit('state', m);
        break;
      case 'snap': this.emit('snap', m); break;
      case 'race': this.emit('race', m); break;
      case 'lap': this.emit('lap', m); break;
      case 'event':
        if (m.kind === 'host') { this.host = m.hostId === this.you; if (this.room) this.room.hostId = m.hostId; }
        if (m.kind === 'finish' && m.id === this.you) this.emit('event', m);
        else this.emit('event', m);
        break;
      case 'player-joined': this.emit('joined', m); break;
      case 'player-left': this.emit('left', m); break;
      case 'chat': this.emit('chat', m); break;
      case 'error': this.emit('error', m); break;
      case 'kick': this.emit('kick', m); break;
      default: break;
    }
  }

  send(msg: any) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    if (this.wantOpen && this.queue.length < 40) this.queue.push(msg);
    return false;
  }

  close() {
    this.wantOpen = false;
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.connected = false;
  }

  /* ------------------------------------------------------------ shorthand -- */
  create(name: string, car: string, color?: string) { this.send({ t: 'create', name, car, color }); }
  join(code: string, name: string, car: string, color?: string) { this.send({ t: 'join', code: String(code).trim(), name, car, color }); }
  setCar(car?: string, name?: string, color?: string) { this.send({ t: 'setCar', car, name, color }); }
  ready(ready: boolean) { this.send({ t: 'ready', ready }); }
  setLaps(laps: number) { this.send({ t: 'laps', laps }); }
  deploy(laps?: number) { this.send({ t: 'start', laps }); }
  restart() { this.send({ t: 'restart' }); }
  chat(text: string) { this.send({ t: 'chat', text }); }
  kick(id: string) { this.send({ t: 'kick', id }); }
  sendCar(pose: { p: number[]; q: number[]; v: number[]; sp: number; gear: number; rpm: number; dr: number; bo: number; w: number[]; hb: number; air: number }) {
    this.send({ t: 'car', p: pose.p, q: pose.q, v: pose.v, sp: pose.sp, gear: pose.gear, rpm: pose.rpm, dr: pose.dr, bo: pose.bo ? 1 : 0, w: pose.w, hb: pose.hb ? 1 : 0, air: pose.air ? 1 : 0 });
  }
  sendInput(input: { th: number; br: number; st: number; hb: boolean; bo: boolean }) {
    this.send({ t: 'input', th: Math.round(input.th * 255), br: Math.round(input.br * 255), st: +input.st.toFixed(3), hb: input.hb ? 1 : 0, bo: input.bo ? 1 : 0 });
  }
}
