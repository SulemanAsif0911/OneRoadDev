/**
 * CyberKhyal — the race HUD.
 *
 * Reads the session's hud() snapshot on a 15 Hz tick (numbers do not need 60 Hz and React should
 * not be in the render loop) and lays out position, timing, speed, standings and the countdown.
 */
'use client';
import { useEffect, useRef, useState } from 'react';
import type { Session, SessionHud, Standing } from '@/game/session';
import type { Settings } from '@/game/settings';
import { formatTime } from '@/game/settings';

type Props = {
  session: Session;
  settings: Settings;
  you: string;
  onExit: () => void;
};

const EMPTY: SessionHud | null = null;

export function Hud({ session, settings, you, onExit }: Props) {
  const [hud, setHud] = useState<SessionHud | null>(EMPTY);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: string }[]>([]);
  const toastId = useRef(0);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 66) return;
      last = t;
      setHud(session.hud());
      for (const e of session.takeEvents()) {
        if (e.kind === 'finish') push(`${settings.name || 'You'} finished — ${formatTime(e.data)}`, 'ok');
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, settings.name]);

  function push(text: string, kind = 'info') {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }

  // lap flash: watch the lap counter instead of polling every frame
  const [flash, setFlash] = useState<{ lap: number; time: number; delta: number | null } | null>(null);
  const lastLapRef = useRef(0);
  useEffect(() => {
    if (!hud) return;
    if (hud.lastLap != null && hud.lap !== lastLapRef.current) {
      lastLapRef.current = hud.lap;
      setFlash({ lap: hud.lap - 1, time: hud.lastLap, delta: hud.lapDelta });
      const id = ++toastId.current;
      setTimeout(() => setFlash((f) => (f && f.time === hud.lastLap ? null : f)), 2600);
      void id;
    }
  }, [hud]);

  if (!hud) return null;
  const toUnits = settings.units === 'mph' ? 1 / 1.609344 : 1;
  const unitLabel = settings.units === 'mph' ? 'MPH' : 'KM/H';
  const rpmPct = Math.min(1, hud.rpm / (hud.redline || 8000));
  const best = hud.bestLap;
  const lapDown = hud.lapTime > 0 && best != null && hud.lapTime > best * 1.6;

  return (
    <div className="ck-hud">
      {/* ---- top left: position + lap */}
      <div className="hud-corner hud-tl">
        <div className="hud-lap">
          <div className="pos">
            {hud.position}
            <small>/{hud.total}</small>
          </div>
          <div className="of">
            <div style={{ letterSpacing: '0.2em', fontSize: 11, color: 'var(--text-faint)' }}>POSITION</div>
            <div className="mono" style={{ fontSize: 15, marginTop: 6 }}>
              LAP {Math.min(hud.lap, hud.laps)}/{hud.laps}
            </div>
          </div>
        </div>
        {hud.wrongWay && (
          <div className="hud-card" style={{ borderColor: 'rgba(255,59,87,0.5)', color: '#ffb3c0' }}>
            <b style={{ letterSpacing: '0.12em' }}>WRONG WAY</b>
          </div>
        )}
        {hud.offTrack && !hud.wrongWay && (
          <div className="hud-card" style={{ borderColor: 'rgba(255,200,74,0.45)', color: '#ffe0a3' }}>
            <b style={{ letterSpacing: '0.12em' }}>OFF TRACK</b>
          </div>
        )}
      </div>

      {/* ---- top right: timing */}
      <div className="hud-corner hud-tr">
        <div className="hud-card" style={{ textAlign: 'right' }}>
          <div className="hud-clock">
            <small>Lap time</small>
            <span style={{ color: lapDown ? 'var(--hot)' : undefined }}>{formatTime(hud.lapTime)}</span>
          </div>
        </div>
        <div className="hud-card" style={{ textAlign: 'right', minWidth: 190 }}>
          <div className="mini faint">Best</div>
          <div className="hud-clock best" style={{ fontSize: 17 }}>{formatTime(best)}</div>
          <div className="mini faint" style={{ marginTop: 6 }}>Last</div>
          <div className="hud-clock best" style={{ fontSize: 17, color: 'var(--text-dim)' }}>{formatTime(hud.lastLap)}</div>
        </div>
        <div className="hud-card" style={{ textAlign: 'right' }}>
          <div className="mini faint">Race</div>
          <div className="mono" style={{ fontSize: 15 }}>{formatTime(hud.raceTime, false)}</div>
        </div>
      </div>

      {/* ---- bottom left: speed, gear, rpm, nitro */}
      <div className="hud-corner hud-bl">
        <div className="hud-speed">
          <div className="num">{Math.round(hud.speed * toUnits)}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="unit">{unitLabel}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="hud-gear">{hud.gear === -1 ? 'R' : hud.gear === 0 ? 'N' : hud.gear}</span>
              {hud.drifting && <span className="tag" style={{ background: 'rgba(255,200,74,0.22)', color: '#ffdc8a' }}>DRIFT</span>}
              {hud.airborne && <span className="tag" style={{ background: 'rgba(34,211,238,0.2)', color: '#a5f0ff' }}>AIR</span>}
            </span>
          </div>
        </div>
        <div className="rpm"><i style={{ width: `${rpmPct * 100}%` }} /></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="mini faint" style={{ letterSpacing: '0.22em' }}>NITRO</span>
          <div className="bar-track" style={{ width: 150 }}>
            <i style={{ width: `${hud.nitrous * 100}%`, background: 'linear-gradient(90deg,#22d3ee,#6d8bff)' }} />
          </div>
        </div>
      </div>

      {/* ---- bottom right: standings */}
      <div className="hud-corner hud-br">
        <div className="hud-standings">
          {hud.standings.slice(0, 8).map((s: Standing) => (
            <div className="standing" key={s.id} data-you={s.id === you ? '1' : '0'}>
              <span className="p">{s.position}</span>
              <span className="swatch" style={{ width: 10, height: 10, borderRadius: 3, background: s.color, display: 'inline-block' }} />
              <span className="n">{s.name}</span>
              <span className="t">{s.finished ? 'FIN' : s.best != null ? formatTime(s.best, false) : `L${s.lap}`}</span>
            </div>
          ))}
        </div>
        <div className="hud-keys">
          <kbd>{settings.bindings.camera?.[0]?.replace('Key', '') || 'C'}</kbd> camera
          <kbd style={{ marginLeft: 8 }}>{settings.bindings.reset?.[0]?.replace('Key', '') || 'R'}</kbd> reset
          <button className="btn sm ghost" style={{ pointerEvents: 'auto', marginLeft: 10 }} onClick={onExit}>ESC menu</button>
        </div>
      </div>

      {/* ---- countdown / banners */}
      {hud.countdown > 0.02 && (
        <div className="ck-banner cd">
          <div className="big" key={Math.ceil(hud.countdown)}>{Math.ceil(hud.countdown)}</div>
          <div className="sub">{settings.name || 'Driver'} — get ready</div>
        </div>
      )}
      {hud.countdown > -0.9 && hud.countdown <= 0.02 && hud.racing && (
        <div className="ck-banner go">
          <div className="big">GO</div>
        </div>
      )}

      {flash && (
        <div className="lapflash" key={flash.time}>
          <b>
            LAP {Math.min(flash.lap, hud.laps)}
            {flash.lap >= hud.laps ? ' — FINAL' : ''}
          </b>
          <span>
            {formatTime(flash.time)}
            {flash.delta != null && (
              <em style={{ fontStyle: 'normal', color: flash.delta < 0 ? 'var(--good)' : 'var(--hot)', marginLeft: 10 }}>
                {flash.delta < 0 ? '−' : '+'}{Math.abs(flash.delta / 1000).toFixed(3)}
              </em>
            )}
          </span>
        </div>
      )}

      <div className="ck-toast">
        {toasts.map((t) => <div className="toast" key={t.id}>{t.text}</div>)}
      </div>
    </div>
  );
}
