// recorder.js — joins the Meticulous status stream and Portal notifications into
// one shot record on a shared clock.
//
// Timebase: the machine reports `time` in ms since its own shot start. The
// first status with extracting=true fixes  wallZero = now − time. Machine
// samples keep the machine's time; Portal samples are stamped
// (now − wallZero) / 1000 when they arrive. Both are then "seconds since the
// machine's shot start".
//
// Lifecycle:  idle → recording (extracting went true, or manual start)
//           → settling (extracting went false; keep capturing drips for a while)
//           → done (finalize → emits 'shot')

export const SETTLE_SEC_DEFAULT = 6;

export class ShotRecorder extends EventTarget {
  constructor({ settleSec = SETTLE_SEC_DEFAULT } = {}) {
    super();
    this.settleSec = settleSec;
    this.reset();
    this.lastExtracting = false;
    this.lastStatusWall = 0;
  }

  reset() {
    this.state = 'idle';
    this.shot = null;
    this.wallZero = null;
    this.extractionEndT = null;
    if (this._settleTimer) clearTimeout(this._settleTimer);
    this._settleTimer = null;
  }

  get isRecording() {
    return this.state === 'recording' || this.state === 'settling';
  }

  /** Called for every socket.io status from the machine. */
  onStatus(s) {
    const now = s.at ?? performance.now();
    this.lastStatusWall = now;
    const rising = s.extracting && !this.lastExtracting;
    const falling = !s.extracting && this.lastExtracting;
    this.lastExtracting = s.extracting;

    if (rising && this.state !== 'recording') {
      if (this.state === 'settling') this._finalize(); // back-to-back shots
      this._start({ machineTimeMs: s.timeMs, profile: s.profile, manual: false, now });
    }
    if (!this.isRecording) return;

    const t = s.timeMs >= 0 && this.state === 'recording' ? s.timeMs / 1000 : (now - this.wallZero) / 1000;
    // Keep the clocks honest: if the machine's time disagrees with our wall
    // estimate by more than 300 ms while extracting, re-anchor.
    if (this.state === 'recording' && s.timeMs >= 0) {
      const estWallZero = now - s.timeMs;
      if (Math.abs(estWallZero - this.wallZero) > 300) this.wallZero = estWallZero;
    }
    this.shot.machine.push({ t: round3(t), p: s.p, f: s.f, w: s.w, g: s.g, temp: s.temp, status: s.name, setpoint: s.setpoints?.active ? s.setpoints[s.setpoints.active] : NaN });
    if (!this.shot.profileName && s.profile) this.shot.profileName = s.profile;
    if (Number.isFinite(s.w)) this.shot.finalWeightG = Math.max(this.shot.finalWeightG || 0, s.w);
    this._emit('sample', { kind: 'machine', t });

    if (falling && this.state === 'recording') {
      this.extractionEndT = round3(t);
      this.state = 'settling';
      this._emit('state', { state: 'settling', t });
      this._settleTimer = setTimeout(() => this._finalize(), this.settleSec * 1000);
    }
  }

  /** Called for every Portal measurement. */
  onPortal(m) {
    if (!this.isRecording) return;
    const now = m.at ?? performance.now();
    const t = (now - this.wallZero) / 1000;
    this.shot.portal.push({ t: round3(t), ec: m.ec, tOut: m.tOut, tInt: m.tInt, status: m.status });
    this._emit('sample', { kind: 'portal', t });
  }

  startManual() {
    if (this.isRecording) return;
    this._start({ machineTimeMs: 0, profile: null, manual: true, now: performance.now() });
  }

  stopManual() {
    if (!this.isRecording) return;
    if (this.state === 'recording') this.extractionEndT = round3((performance.now() - this.wallZero) / 1000);
    this._finalize();
  }

  _start({ machineTimeMs, profile, manual, now }) {
    if (this._settleTimer) clearTimeout(this._settleTimer);
    this.wallZero = now - Math.max(0, machineTimeMs || 0);
    this.shot = {
      id: cryptoId(),
      startedAt: Date.now() - Math.max(0, machineTimeMs || 0),
      profileName: profile || null,
      machine: [],
      portal: [],
      finalWeightG: 0,
      durationSec: 0,
      manual,
      source: 'live',
    };
    this.extractionEndT = null;
    this.state = 'recording';
    this._emit('state', { state: 'recording', shot: this.shot });
  }

  _finalize() {
    if (!this.shot) return;
    if (this._settleTimer) clearTimeout(this._settleTimer);
    this._settleTimer = null;
    const shot = this.shot;
    shot.durationSec = this.extractionEndT ?? round3((performance.now() - this.wallZero) / 1000);
    shot.recordedUntilSec = round3((performance.now() - this.wallZero) / 1000);
    shot.endedAt = Date.now();
    this.state = 'idle';
    this.shot = null;
    this._emit('state', { state: 'idle' });
    this._emit('shot', shot);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

const round3 = (x) => Math.round(x * 1000) / 1000;
function cryptoId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'shot-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
