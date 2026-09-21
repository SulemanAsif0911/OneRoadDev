/**
 * CyberKhyal — the whole front end.
 *
 * Owns the screen state machine (menu → room → grid → race → results), the websocket room
 * protocol and the settings screen, and hands the 3D session everything it needs. The session
 * itself runs outside React; this file only decides what the player sees and what gets sent.
 */
'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Session, type CarInfo, type Standing } from '@/game/session';
import { Net, type ChatLine, type LobbyState, type RosterPlayer } from '@/net/client';
import {
  ACTIONS, DEFAULT_SETTINGS, QUALITY, autoName, formatTime, keyLabel, loadSettings, saveSettings,
  type AssistName, type BindAction, type CameraName, type QualityName, type Settings,
} from '@/game/settings';
import { Hud } from './Hud';

type Screen = 'boot' | 'menu' | 'join' | 'settings' | 'credits' | 'lobby' | 'race' | 'results';

export function CyberKhyal() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const netRef = useRef<Net | null>(null);

  const [screen, setScreen] = useState<Screen>('boot');
  const [progress, setProgress] = useState({ pct: 0, label: 'Starting' });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [room, setRoom] = useState<(LobbyState & { you?: string; host?: boolean }) | null>(null);
  const [you, setYou] = useState<string>('');
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [chatText, setChatText] = useState('');
  const [error, setError] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [simError, setSimError] = useState('');
  const [results, setResults] = useState<{ results: any[]; reason: string } | null>(null);
  const [settingsTab, setSettingsTab] = useState<'controls' | 'graphics' | 'audio' | 'assists' | 'profile'>('controls');
  const [paused, setPaused] = useState(false);
  const [cars, setCars] = useState<CarInfo[]>([]);
  const [isHost, setIsHost] = useState(false);

  /* ------------------------------------------------------------------ boot -- */
  useEffect(() => {
    const s = loadSettings();
    if (!s.name) s.name = autoName();
    setSettings(s);
    let session: Session | null = null;
    let net: Net | null = null;
    (async () => {
      try {
        const canvas = canvasRef.current;
        if (!canvas) return;
        session = new Session(canvas, s);
        sessionRef.current = session;
        await session.load((pct, label) => setProgress({ pct, label }));
        setCars(session.cars);
        // the player's car waits on the grid while the menu is up, camera slowly orbiting it
        session.spawnLocal('solo', s.name, '#e8402d', s.car);
        session.settings.camera = 'orbit';
        session.input.enabled = false;
        session.start();
        setScreen('menu');

        net = new Net();
        netRef.current = net;
        session.onSendCar = (pose) => net!.sendCar(pose);
        session.onSendInput = (input) => net!.sendInput(input);
        net.on('welcome', (m) => { /* track info if we ever want it in the UI */ void m; });
        net.on('room', (m) => {
          setRoom(m);
          setIsHost(!!m.host);
          if (m.you) {
            setYou(m.you);
            if (session) session.player = m.you;      // the car on the grid is *this* player
          }
          if (m.state === 'lobby') {
            setScreen((cur) => (cur === 'race' || cur === 'results' ? 'lobby' : cur === 'lobby' ? 'lobby' : 'lobby'));
            setResults(null);
            session!.input.enabled = false;
            session!.settings.camera = 'orbit';
            session!.racing = false;
            syncRemotes(session!, m);
          }
        });
        net.on('state', (m) => {
          if (m.state === 'countdown') {
            session!.countdown = Math.max(0, ((m.countdownEnd || 0) - Date.now()) / 1000);
            session!.laps = m.laps || 3;
            session!.input.enabled = false;
            session!.settings.camera = s.camera === 'orbit' ? 'chase' : s.camera;
            setScreen('race');
            session!.sound.resume();
          } else if (m.state === 'racing') {
            session!.countdown = 0;
            session!.input.enabled = true;
            session!.racing = true;
            session!.lapStart = m.startedAt || performance.now();
            session!.raceStart = session!.lapStart;
            session!.lap = 0;
            session!.progress = 0;
            setScreen('race');
          } else if (m.state === 'lobby') {
            setScreen('lobby');
            session!.input.enabled = false;
          }
        });
        net.on('snap', (m) => {
          session!.applySnapshots(m.cars as any, net!.you || '');
          const roster = net!.room?.players || [];
          const byId = new Map(roster.map((p) => [p.id, p]));
          const list: Standing[] = [];
          for (const c of m.cars as any[]) {
            const info = byId.get(c.id);
            list.push({
              id: c.id, name: info?.name || 'Racer', color: info?.color || '#888', car: info?.car || '',
              lap: c.lap, best: c.best, finished: c.finished, position: c.position || 0,
              you: c.id === net!.you, gap: null,
            });
          }
          list.sort((a, b) => (a.position || 99) - (b.position || 99));
          session!.setStandings(list);
          const me = list.find((l) => l.you);
          session!.position = me?.position || 1;
          session!.total = list.length || 1;
          if (m.state === 'racing' && !session!.racing) { session!.racing = true; session!.input.enabled = true; }
          void you;
        });
        net.on('lap', (m) => { if (m.id !== net!.you) session!.sound.ui('tick'); });
        net.on('race', (m) => {
          setResults({ results: m.results, reason: m.reason });
          setScreen('results');
          session!.racing = false;
          session!.input.enabled = false;
        });
        net.on('chat', (m) => setChat((c) => [...c.slice(-40), m]));
        net.on('joined', (m) => {
          const r = net!.room;
          if (r && m.id) {
            const p = r.players.find((q) => q.id === m.id);
            if (p) session!.addRemote(p.id, p.name, p.color, p.car);
          }
        });
        net.on('left', (m) => { session!.removeRemote(m.id); });
        net.on('kick', () => { setScreen('menu'); setError('You were removed from the room'); });
        net.on('error', (m) => {
          setBusy(false);
          if (m.code === 'no-room') setError('No room with that code — check the digits');
          else if (m.code === 'full') setError('That room is full (12 racers max)');
          else setError(m.msg || 'Something went wrong');
        });
        net.connect();
      } catch (e: any) {
        setSimError(e?.message || String(e));
      }
    })();
    return () => {
      net?.close();
      session?.dispose();
      sessionRef.current = null;
      netRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------------------------------------------------------- settings -- */
  const applySettings = useCallback((next: Settings) => {
    setSettings(next);
    saveSettings(next);
    sessionRef.current?.setSettings(next);
  }, []);

  const patch = useCallback((p: Partial<Settings>) => {
    applySettings({ ...settings, ...p });
  }, [settings, applySettings]);

  useEffect(() => {
    const s = sessionRef.current;
    if (s) s.settings.name = settings.name;
  }, [settings.name]);

  /* ------------------------------------------------------------ room actions -- */
  const createRoom = () => {
    setError('');
    setBusy(true);
    sessionRef.current?.sound.resume();
    netRef.current?.create(settings.name, settings.car);
    setTimeout(() => setBusy(false), 1200);
  };

  const joinRoom = () => {
    if (joinCode.trim().length !== 4) { setError('Enter the 4-digit code'); return; }
    setError('');
    setBusy(true);
    sessionRef.current?.sound.resume();
    netRef.current?.join(joinCode.trim(), settings.name, settings.car);
    setTimeout(() => setBusy(false), 1500);
  };

  const deploy = () => {
    const net = netRef.current;
    if (!net) return;
    const laps = room?.laps || 3;
    // everyone lines up on the grid the moment the host deploys, so the countdown shows the
    // real grid with the real cars in it
    const roster = net.room?.players || [];
    const idx = Math.max(0, roster.findIndex((p) => p.id === net.you));
    sessionRef.current?.enterGrid(idx, Math.max(1, roster.length));
    net.deploy(laps);
  };

  const leave = () => {
    netRef.current?.close();
    sessionRef.current?.removeAllRemotes();
    setRoom(null);
    setResults(null);
    setScreen('menu');
    const s = sessionRef.current;
    if (s) {
      s.sound.setMuted(false);
      s.input.enabled = false;
      s.settings.camera = 'orbit';
      s.racing = false;
      s.spawnLocal('solo', settings.name, '#e8402d', settings.car);
    }
  };

  const pickCar = (id: string) => {
    patch({ car: id });
    netRef.current?.setCar(id);
    sessionRef.current?.swapCar(id);
  };

  const sc = screen;
  const code = room?.code || '';
  const players = room?.players || [];

  /* ------------------------------------------------------------------ chat -- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        if (screen === 'race') setPaused((p) => !p);
      }
      if (e.code === 'KeyT' && screen === 'race') {
        const el = document.getElementById('ck-chat') as HTMLInputElement | null;
        el?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screen]);

  const sendChat = () => {
    const text = chatText.trim();
    if (!text) return;
    netRef.current?.chat(text);
    setChatText('');
    (document.getElementById('ck-chat') as HTMLInputElement | null)?.blur();
  };

  const standingsRows = results?.results || [];
  const myResult = standingsRows.find((r) => r.id === you);

  return (
    <div className="ck-root">
      <div className="ck-scene"><canvas ref={canvasRef} /></div>
      <div className="ck-vignette" />

      {sc === 'boot' && (
        <div className="ck-loading">
          <div className="inner">
            <div className="brand" style={{ textAlign: 'center' }}>
              <div className="ck-brand-mark" style={{ fontSize: 46 }}>CyberKhyal</div>
            </div>
            <div className="spinner" />
            <div className="bar-track"><i style={{ width: `${Math.round(progress.pct * 100)}%` }} /></div>
            <div className="dim mini">{progress.label} · {Math.round(progress.pct * 100)}%</div>
            {simError && <div style={{ color: 'var(--hot)', maxWidth: 460, textAlign: 'center' }}>{simError}</div>}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ menu -- */}
      {(sc === 'menu' || sc === 'join' || sc === 'settings' || sc === 'credits') && (
        <div className="ck-menu">
          <div className="ck-menu-hero">
            <div className="ck-brand">
              <div className="ck-brand-mark">CyberKhyal</div>
              <div className="ck-brand-sub">Frozen City Grand Prix</div>
              <div className="ck-brand-tag">
                One host, one code, one arena. Create a room, read the four digits out to your friends,
                and when you press Deploy every car in the room drops onto the same circuit at once.
              </div>
            </div>
            <div className="ck-menu-actions">
              <button className="btn primary" onClick={createRoom} disabled={busy}>
                <span className="glyph">＋</span>
                <span className="label">Create Room<small>You host · you deploy · you pick the laps</small></span>
              </button>
              <button className="btn" onClick={() => { setScreen('join'); setError(''); setJoinCode(''); }}>
                <span className="glyph">#</span>
                <span className="label">Enter Code<small>Join a room with its 4-digit code</small></span>
              </button>
              <button className="btn" onClick={() => setScreen('settings')}>
                <span className="glyph">⚙</span>
                <span className="label">Settings<small>Controls, graphics, audio, assists</small></span>
              </button>
              <button className="btn" onClick={() => setScreen('credits')}>
                <span className="glyph">✦</span>
                <span className="label">Credits<small>Built on the models in this repository</small></span>
              </button>
            </div>
            {error && <div style={{ color: 'var(--hot)', fontSize: 13 }}>{error}</div>}
            <div className="row" style={{ gap: 16, color: 'var(--text-faint)', fontSize: 12 }}>
              <span className={netRef.current?.connected ? 'dot' : 'dot'} style={{ background: netRef.current?.connected ? 'var(--good)' : 'var(--hot)' }} />
              {netRef.current?.connected ? 'Server connected' : 'Connecting…'}
              <span className="spacer" />
              <span className="mono">{cars.length} cars</span>
              <span className="mono">3 laps</span>
            </div>
          </div>
          <div />
        </div>
      )}

      {sc === 'join' && (
        <div className="ck-overlay">
          <div className="panel panel-pad" style={{ width: 'min(520px, 94vw)' }}>
            <div className="stack">
              <div>
                <div className="panel-title">Enter room code</div>
                <div className="panel-sub">Ask the host for the four digits on their lobby screen.</div>
              </div>
              <input
                className="input big"
                autoFocus
                inputMode="numeric"
                maxLength={4}
                placeholder="0000"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                onKeyDown={(e) => { if (e.key === 'Enter') joinRoom(); }}
              />
              {error && <div style={{ color: 'var(--hot)', fontSize: 13 }}>{error}</div>}
              <div className="row">
                <button className="btn ghost" onClick={() => setScreen('menu')}>Back</button>
                <span className="spacer" />
                <button className="btn primary" onClick={joinRoom} disabled={joinCode.length !== 4 || busy}>
                  <span className="glyph">▶</span>
                  <span className="label">Join Room</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {sc === 'settings' && (
        <div className="ck-overlay wide">
          <div className="panel" style={{ width: 'min(1000px, 94vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', margin: 'auto' }}>
            <div className="ck-lobby-head">
              <div>
                <div className="panel-title">Settings</div>
                <div className="panel-sub">Everything here is saved on this machine.</div>
              </div>
              <span className="spacer" />
              <div className="tabs">
                {(['controls', 'graphics', 'audio', 'assists', 'profile'] as const).map((t) => (
                  <button key={t} data-on={settingsTab === t ? '1' : '0'} onClick={() => setSettingsTab(t)}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ padding: '8px 28px 12px', overflowY: 'auto' }}>
              {settingsTab === 'controls' && (
                <>
                  {ACTIONS.map((a) => (
                    <div className="setting" key={a.id}>
                      <div className="meta"><b>{a.label}</b><span>{a.hint || ' '}</span></div>
                      <div className="ctl" style={{ gap: 6 }}>
                        {(settings.bindings[a.id as BindAction] || []).map((code, i) => (
                          <button
                            className="btn sm ghost"
                            key={`${a.id}-${i}`}
                            onClick={() => {
                              const el = document.createElement('div');
                              el.tabIndex = 0;
                              const handler = (e: KeyboardEvent) => {
                                e.preventDefault();
                                const next = { ...settings.bindings };
                                next[a.id as BindAction] = [e.code];
                                applySettings({ ...settings, bindings: next });
                                window.removeEventListener('keydown', handler, true);
                                el.remove();
                              };
                              window.addEventListener('keydown', handler, true);
                              el.textContent = 'press a key…';
                              document.body.appendChild(el);
                              el.focus();
                              document.body.removeChild(el);
                            }}
                          >
                            {keyLabel(code)}
                          </button>
                        ))}
                        {(settings.bindings[a.id as BindAction] || []).length > 1 && (
                          <button
                            className="btn sm ghost"
                            title="Reset to default"
                            onClick={() => {
                              const next = { ...settings.bindings };
                              next[a.id as BindAction] = DEFAULT_SETTINGS.bindings[a.id as BindAction];
                              applySettings({ ...settings, bindings: next });
                            }}
                          >↺</button>
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="setting">
                    <div className="meta"><b>Gamepad</b><span>Use a controller when one is plugged in</span></div>
                    <div className="ctl">
                      <div className="switch" data-on={settings.gamepad ? '1' : '0'} onClick={() => patch({ gamepad: !settings.gamepad })} />
                    </div>
                  </div>
                  <div className="setting">
                    <div className="meta"><b>Steering sensitivity</b><span>How far the wheels move for a full input</span></div>
                    <div className="ctl">
                      <input className="slider" type="range" min={0.4} max={1.4} step={0.05}
                        value={settings.steeringSensitivity}
                        style={{ ['--pct' as any]: `${((settings.steeringSensitivity - 0.4) / 1) * 100}%` }}
                        onChange={(e) => patch({ steeringSensitivity: +e.target.value })} />
                      <span className="val">{settings.steeringSensitivity.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="setting">
                    <div className="meta"><b>Steering smoothing</b><span>Higher is calmer with a keyboard, lower is snappier</span></div>
                    <div className="ctl">
                      <input className="slider" type="range" min={0} max={1} step={0.05}
                        value={settings.steeringSmooth}
                        style={{ ['--pct' as any]: `${settings.steeringSmooth * 100}%` }}
                        onChange={(e) => patch({ steeringSmooth: +e.target.value })} />
                      <span className="val">{settings.steeringSmooth.toFixed(2)}</span>
                    </div>
                  </div>
                </>
              )}

              {settingsTab === 'graphics' && (
                <>
                  <div className="setting">
                    <div className="meta"><b>Quality preset</b><span>Shadows, reflections and post-processing</span></div>
                    <div className="ctl">
                      <div className="seg">
                        {(['low', 'medium', 'high', 'ultra'] as QualityName[]).map((q) => (
                          <button key={q} data-on={settings.quality === q ? '1' : '0'} onClick={() => patch({ quality: q })}>{QUALITY[q].label}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="setting">
                    <div className="meta"><b>Camera</b><span>Chase, far chase, hood, bumper or orbit</span></div>
                    <div className="ctl">
                      <div className="seg">
                        {(['chase', 'far', 'hood', 'bumper', 'orbit'] as CameraName[]).map((c) => (
                          <button key={c} data-on={settings.camera === c ? '1' : '0'} onClick={() => { patch({ camera: c }); if (sessionRef.current) sessionRef.current.settings.camera = c; }}>{c}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="setting">
                    <div className="meta"><b>Field of view</b><span>Wider sees more, tighter feels faster</span></div>
                    <div className="ctl">
                      <input className="slider" type="range" min={55} max={95} step={1} value={settings.fov}
                        style={{ ['--pct' as any]: `${((settings.fov - 55) / 40) * 100}%` }}
                        onChange={(e) => patch({ fov: +e.target.value })} />
                      <span className="val">{settings.fov}°</span>
                    </div>
                  </div>
                  {([
                    ['shadows', 'Shadows', 'Sun shadows on cars and buildings'],
                    ['bloom', 'Bloom', 'Glow on lights and chrome'],
                    ['particles', 'Tyre smoke', 'Smoke from a sliding tyre'],
                    ['skidmarks', 'Skid marks', 'Rubber left on the road'],
                    ['nameTags', 'Name tags', 'Floating names over other racers'],
                  ] as const).map(([k, label, hint]) => (
                    <div className="setting" key={k}>
                      <div className="meta"><b>{label}</b><span>{hint}</span></div>
                      <div className="ctl">
                        <div className="switch" data-on={settings[k] ? '1' : '0'} onClick={() => patch({ [k]: !settings[k] } as any)} />
                      </div>
                    </div>
                  ))}
                  <div className="setting">
                    <div className="meta"><b>Camera shake</b><span>Feedback from kerbs, walls and landings</span></div>
                    <div className="ctl">
                      <input className="slider" type="range" min={0} max={1.4} step={0.05} value={settings.cameraShake}
                        style={{ ['--pct' as any]: `${(settings.cameraShake / 1.4) * 100}%` }}
                        onChange={(e) => patch({ cameraShake: +e.target.value })} />
                      <span className="val">{settings.cameraShake.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="setting">
                    <div className="meta"><b>Units</b><span>Speed readout</span></div>
                    <div className="ctl">
                      <div className="seg">
                        <button data-on={settings.units === 'kmh' ? '1' : '0'} onClick={() => patch({ units: 'kmh' })}>km/h</button>
                        <button data-on={settings.units === 'mph' ? '1' : '0'} onClick={() => patch({ units: 'mph' })}>mph</button>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {settingsTab === 'audio' && (
                <>
                  {([
                    ['volumeMaster', 'Master'],
                    ['volumeEngine', 'Engine'],
                    ['volumeTyres', 'Tyres and wind'],
                  ] as const).map(([k, label]) => (
                    <div className="setting" key={k}>
                      <div className="meta"><b>{label}</b><span>{k === 'volumeMaster' ? 'Everything' : ''}</span></div>
                      <div className="ctl">
                        <input className="slider" type="range" min={0} max={1} step={0.02} value={settings[k]}
                          style={{ ['--pct' as any]: `${settings[k] * 100}%` }}
                          onChange={(e) => patch({ [k]: +e.target.value } as any)} />
                        <span className="val">{Math.round(settings[k] * 100)}%</span>
                      </div>
                    </div>
                  ))}
                  <div className="setting">
                    <div className="meta"><b>Test the engine</b><span>Blip the throttle with sound on</span></div>
                    <div className="ctl">
                      <button className="btn sm" onClick={async () => {
                        const s = sessionRef.current;
                        if (!s) return;
                        await s.sound.resume();
                        s.sound.ui('go');
                      }}>Rev</button>
                    </div>
                  </div>
                </>
              )}

              {settingsTab === 'assists' && (
                <>
                  <div className="setting">
                    <div className="meta"><b>Driving assist level</b><span>Traction control, ABS and stability</span></div>
                    <div className="ctl">
                      <div className="seg">
                        {(['arcade', 'sport', 'pro', 'sim'] as AssistName[]).map((a) => (
                          <button key={a} data-on={settings.assist === a ? '1' : '0'} onClick={() => patch({ assist: a })}>{a}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="panel-sub" style={{ padding: '10px 0 18px' }}>
                    <b>arcade</b> keeps the car planted and shifts for you · <b>sport</b> is the default racing feel ·
                    <b> pro</b> expects smooth inputs · <b>sim</b> turns everything off, including auto shifting.
                  </div>
                </>
              )}

              {settingsTab === 'profile' && (
                <>
                  <div className="setting">
                    <div className="meta"><b>Driver name</b><span>Shown in the lobby, on the grid and in the results</span></div>
                    <div className="ctl" style={{ minWidth: 240 }}>
                      <input className="input" maxLength={16} value={settings.name}
                        onChange={(e) => patch({ name: e.target.value.slice(0, 16) })} />
                    </div>
                  </div>
                  <div style={{ marginTop: 14 }}>
                    <div className="mini faint" style={{ marginBottom: 10 }}>Car</div>
                    <div className="cars">
                      {cars.map((c) => (
                        <button className="car-card" key={c.id} data-on={settings.car === c.id ? '1' : '0'} onClick={() => pickCar(c.id)}>
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <b>{c.label}</b>
                            <span className="klass">{c.klass}</span>
                          </div>
                          <span>{c.fullName}</span>
                          <div className="stats">
                            <span>{c.realLength.toFixed(1)} m</span>
                            <span>·</span>
                            <span>{(c.realWidth * 1000).toFixed(0)} mm</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="ck-lobby-foot">
              <button className="btn ghost" onClick={() => setScreen(room ? 'lobby' : 'menu')}>Back</button>
              <span className="spacer" />
              <button className="btn danger sm" onClick={() => { applySettings({ ...DEFAULT_SETTINGS, name: settings.name }); }}>Reset to defaults</button>
            </div>
          </div>
        </div>
      )}

      {sc === 'credits' && (
        <div className="ck-overlay">
          <div className="panel panel-pad" style={{ width: 'min(680px, 94vw)', maxHeight: '88vh', overflowY: 'auto' }}>
            <div className="stack">
              <div>
                <div className="panel-title">CyberKhyal</div>
                <div className="panel-sub">
                  خيل — “horses”. A room-code racing game built around the car models and the city map that
                  live in this repository, rendered in a browser with three.js and simulated at 120 Hz.
                </div>
              </div>
              <div className="setting"><div className="meta"><b>Circuit</b><span>sports_car_racing_moscow.glb — traced, simplified and audited so a 5.6 m car fits every metre of the lap</span></div></div>
              <div className="setting"><div className="meta"><b>Cars</b><span>Nine of the ten models in the repository, scaled to their real dimensions and driven by one per-wheel tyre model</span></div></div>
              <div className="setting"><div className="meta"><b>Physics</b><span>Slip angle and slip ratio per wheel, a friction ellipse, wheel spin dynamics, a seven-speed gearbox, aero and downforce, TC/ABS/stability assists</span></div></div>
              <div className="setting"><div className="meta"><b>Networking</b><span>One Node process: Next.js, the GLB assets and the websocket room server, so every other player only needs a browser pointed at the host</span></div></div>
              <div className="setting"><div className="meta"><b>Built with</b><span>Next.js · React · three.js · Node · WebSocket</span></div></div>
              <div className="row">
                <button className="btn ghost" onClick={() => setScreen('menu')}>Back</button>
                <span className="spacer" />
                <span className="faint mini">Version 1.0</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------- lobby -- */}
      {sc === 'lobby' && room && (
        <div className="ck-overlay wide">
          <div className="panel ck-lobby" style={{ margin: 'auto' }}>
            <div className="ck-lobby-head">
              <div className="ck-code">
                <span className="hint">Room code — read it out</span>
                <div className="digits">
                  {String(code).split('').map((d, i) => <span className="digit" key={i}>{d}</span>)}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="hint" style={{ letterSpacing: '0.18em', fontSize: 11, color: 'var(--text-faint)' }}>Join address</span>
                <span className="mono" style={{ fontSize: 15 }}>{typeof location !== 'undefined' ? location.host : ''}</span>
                <span className="faint mini">Anyone on this network opens that address and types the code</span>
              </div>
              <span className="spacer" />
              <div className="stack" style={{ gap: 8, alignItems: 'flex-end' }}>
                <div className="row">
                  <span className="mini faint">Laps</span>
                  <div className="seg">
                    {[1, 2, 3, 5, 8].map((n) => (
                      <button
                        key={n}
                        data-on={(room.laps || 3) === n ? '1' : '0'}
                        disabled={!isHost}
                        onClick={() => netRef.current?.setLaps(n)}
                      >{n}</button>
                    ))}
                  </div>
                </div>
                <span className="faint mini">{players.length}/12 racers · {players.filter((p) => p.ready).length} ready</span>
              </div>
            </div>

            <div className="ck-grid-players">
              {players.map((p: RosterPlayer) => (
                <div className="pcard" key={p.id} data-you={p.id === you ? '1' : '0'}>
                  <span className="swatch" style={{ background: p.color }} />
                  <div className="who">
                    <b>{p.name}{p.id === you ? ' (you)' : ''}</b>
                    <span>{cars.find((c) => c.id === p.car)?.label || p.car}{p.ping ? ` · ${p.ping} ms` : ''}</span>
                  </div>
                  {room.hostId === p.id && <span className="tag host">HOST</span>}
                  {p.ready && <span className="tag ready">READY</span>}
                </div>
              ))}
              {players.length === 0 && <div className="panel-sub">Waiting for racers…</div>}
            </div>

            <div style={{ padding: '0 28px 6px' }}>
              <div className="mini faint" style={{ marginBottom: 8 }}>Your car</div>
              <div className="cars">
                {cars.map((c) => (
                  <button className="car-card" key={c.id} data-on={settings.car === c.id ? '1' : '0'} onClick={() => pickCar(c.id)}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <b>{c.label}</b><span className="klass">{c.klass}</span>
                    </div>
                    <span>{c.fullName}</span>
                    <div className="stats">
                      <span>{c.realLength.toFixed(1)} m</span><span>·</span><span>{c.wheelBase.toFixed(2)} m wheelbase</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="ck-lobby-foot">
              <button className="btn ghost" onClick={leave}>Leave room</button>
              <span className="spacer" />
              <div className="legend">
                <span><span className={netRef.current?.connected ? 'dot' : 'dot'} style={{ background: netRef.current?.connected ? 'var(--good)' : 'var(--hot)' }} /> {netRef.current?.connected ? 'Connected' : 'Reconnecting…'}</span>
                <span className="mono">{netRef.current?.rtt ? `${netRef.current.rtt} ms` : '—'}</span>
              </div>
              <button className="btn" onClick={() => netRef.current?.ready(!(players.find((p) => p.id === you)?.ready))}>
                {players.find((p) => p.id === you)?.ready ? 'Not ready' : 'I am ready'}
              </button>
              {isHost ? (
                <button className="btn primary" onClick={deploy}>
                  <span className="glyph">🚀</span>
                  <span className="label">Deploy<small>Drops everyone onto the grid</small></span>
                </button>
              ) : (
                <span className="faint mini">Waiting for the host to deploy…</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ race -- */}
      {(sc === 'race' || sc === 'results') && sessionRef.current && (
        <>
          <Hud session={sessionRef.current} settings={settings} you={you} onExit={() => setPaused(true)} />
          <div style={{ position: 'fixed', left: 22, bottom: 22, zIndex: 11, display: 'flex', gap: 8, pointerEvents: 'auto' }}>
            <input
              id="ck-chat"
              className="input"
              style={{ width: 240, opacity: 0.9 }}
              placeholder="Chat… (T)"
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }}
            />
          </div>
          {chat.length > 0 && sc === 'race' && (
            <div style={{ position: 'fixed', left: 22, bottom: 74, zIndex: 11, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 420 }}>
              {chat.slice(-4).map((c, i) => (
                <div key={`${c.ts}-${i}`} style={{ fontSize: 12.5 }}>
                  <b style={{ color: c.color }}>{c.name}</b> <span className="dim">{c.text}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* --------------------------------------------------------- results -- */}
      {sc === 'results' && results && (
        <div className="ck-overlay">
          <div className="panel results">
            <div className="ck-lobby-head">
              <div>
                <div className="panel-title">Race complete</div>
                <div className="panel-sub">
                  {myResult ? `You finished ${ordinal(myResult.position)} of ${standingsRows.length}` : 'Results'}
                  {results.reason === 'timeout' ? ' · timed out' : ''}
                </div>
              </div>
              <span className="spacer" />
              <div className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
                <span className="mini faint">Your best lap</span>
                <span className="mono" style={{ fontSize: 20 }}>{formatTime(myResult?.best ?? null)}</span>
              </div>
            </div>
            <div className="podium">
              {[1, 0, 2].map((slot) => {
                const r = standingsRows[slot];
                if (!r) return <div className="step" key={slot} />;
                const h = slot === 0 ? 96 : slot === 1 ? 72 : 58;
                return (
                  <div className="step" key={slot} data-p={slot + 1}>
                    <span className="swatch" style={{ width: 26, height: 26, borderRadius: 8, background: r.color }} />
                    <b style={{ fontSize: 13.5 }}>{r.name}</b>
                    <div className="bar" style={{ height: h }}>
                      <div style={{ textAlign: 'center', paddingTop: 10, fontFamily: 'var(--mono)', fontSize: 20 }}>{slot + 1}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="results-rows">
              {standingsRows.map((r) => (
                <div className="rrow" key={r.id} data-you={r.id === you ? '1' : '0'} data-p={r.position}>
                  <span className="rank">{r.position}</span>
                  <span className="row" style={{ gap: 10 }}>
                    <span className="swatch" style={{ width: 18, height: 18, borderRadius: 6, background: r.color }} />
                    <b style={{ fontSize: 13.5 }}>{r.name}</b>
                    <span className="faint mini">{cars.find((c) => c.id === r.car)?.label}</span>
                  </span>
                  <span className="num">{formatTime(r.best)}</span>
                  <span className="num">{r.finished ? formatTime(r.total) : r.lap ? `lap ${r.lap}` : 'DNF'}</span>
                </div>
              ))}
            </div>
            <div className="ck-lobby-foot">
              <button className="btn ghost" onClick={leave}>Leave</button>
              <span className="spacer" />
              {isHost ? (
                <button className="btn primary" onClick={() => { netRef.current?.restart(); setResults(null); setScreen('lobby'); }}>
                  <span className="glyph">↻</span>
                  <span className="label">Back to lobby<small>Everyone returns to the grid room</small></span>
                </button>
              ) : (
                <span className="faint mini">Waiting for the host…</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- paused -- */}
      {paused && sc === 'race' && (
        <div className="ck-overlay">
          <div className="panel panel-pad" style={{ width: 'min(520px, 92vw)' }}>
            <div className="stack">
              <div>
                <div className="panel-title">Paused</div>
                <div className="panel-sub">The race keeps running for everyone else — this only pauses your view.</div>
              </div>
              <button className="btn primary" onClick={() => setPaused(false)}>Resume</button>
              <button className="btn" onClick={() => { setPaused(false); setScreen('settings'); }}>Settings</button>
              <button className="btn danger" onClick={() => { setPaused(false); leave(); }}>Leave race</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* keep the remote car list in step with the roster */
function syncRemotes(session: Session, room: LobbyState) {
  const seen = new Set<string>();
  for (const p of room.players) {
    if (p.id === session.playerId) continue;
    seen.add(p.id);
    if (!session.remotes.has(p.id)) session.addRemote(p.id, p.name, p.color, p.car);
  }
  for (const id of [...session.remotes.keys()]) if (!seen.has(id)) session.removeRemote(id);
}
