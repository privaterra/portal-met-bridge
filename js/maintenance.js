// maintenance.js — the Meticulous cleaning & maintenance schedule, the dates
// it was last done, the reminder of what comes next, and a check of the piston
// after every brew. Pure: no DOM, no network, so it is unit-tested.
//
// The schedule is the one Meticulous publishes (MAINTENANCE_SOURCE). The
// routine cleaning — after every shot, and the daily / as-required drip tray
// and shower-screen flush — is shown for reference but not tracked: only the
// weekly, monthly and three-monthly jobs have a date and a reminder.

export const MAINTENANCE_SOURCE = {
  title: 'Meticulous — Maintenance and Repairs',
  url: 'https://meticuloushome.com/pages/maintenance-and-repairs',
  retrieved: '2026-11-14',
};

const COOL = 'Disconnect the mains power and make sure the machine is completely cool before starting.';

export const MAINTENANCE_TASKS = [
  {
    id: 'weekly',
    name: 'Internal cleaning',
    when: 'Weekly',
    every: { days: 7 },
    soonDays: 1,
    steps: ['Remove the shower screen and wash it with dish soap and water.', 'Move the motor to RAISE to clean the inside of the cylinder using a damp microfiber cloth.'],
    warnings: [COOL],
  },
  {
    id: 'monthly',
    name: 'Chamber cleaning',
    when: 'After each month — or sooner if you see scale or sediment inside the cylinder',
    every: { months: 1 },
    soonDays: 5,
    covers: ['weekly'],
    steps: [
      'Remove the drip tray and the scale module.',
      'Remove the shower screen and wash it.',
      'Move the motor to RAISE to clean the inside of the cylinder.',
      'Use only water mixed with dish soap (without added chlorine or solvents) and a toothbrush; other brushes are fine as long as they have a plastic handle.',
      'Soak the toothbrush in the soapy water and clean the inside of the cylinder thoroughly.',
    ],
    warnings: [COOL],
  },
  {
    id: 'deep',
    name: 'Deep cleaning',
    when: 'After 3 months — or sooner if you see pressure leaks',
    every: { months: 3 },
    soonDays: 14,
    covers: ['weekly', 'monthly'],
    steps: [
      'Remove the piston to perform a deep cleaning (Meticulous links a video on disassembling the piston and replacing the shower screen).',
      'Use only water mixed with dish soap (without added chlorine or solvents) and a toothbrush; other brushes are fine as long as they have a plastic handle.',
      'Soak the toothbrush in the soapy water and clean both the inside of the cylinder and the piston itself thoroughly.',
      'Completely dry the cylinder, shower screen and gasket before re-inserting them, to ensure a good grip.',
      'Apply a small amount of approved grease to the bottom 2 cm of the piston.',
    ],
    warnings: [COOL],
  },
];

/** Shown for reference; not tracked. */
export const MAINTENANCE_ROUTINE = [
  { when: 'For every shot', name: 'Surface cleaning', steps: ['With a microfiber cloth, wipe the interior and top area of the cylinder to remove any remaining coffee particles.', 'Wipe the surface of the shower screen.', 'Clean the portafilter thoroughly.'] },
  { when: 'Daily / as required', name: 'Drip tray and shower screen', steps: ['Empty any residual water from the drip tray through the draining channels at the back; wash it by hand with a zero-scratch sponge when needed (it is not dishwasher safe).', 'Flush the shower screen: fill the chamber with water, place an empty cup underneath and raise the piston to flush out any coffee grounds.', 'Never use a blind basket: there is nowhere for the pressure to go.'] },
];

export const MAINTENANCE_WARNINGS = [
  'Never immerse the machine, scale module or electronics in water.',
  'Never use alcohol (or alcohol-based cleaners) to clean the inside or outside of the machine.',
  'Never add liquids like vinegar, alcohol or solvents to the chamber.',
  'Never use abrasive materials (dishwashing sponges, scouring pads) on the aesthetic surfaces.',
];

export const MAINTENANCE_GREASE = {
  note: 'Use a food-safe silicone grease for the O-rings and moving components — these exact products, as performance varies between lubricants:',
  products: ['Molykote 111 Compound', 'Super Lube O-Ring Silicone Grease'],
  parts: ['Central piston O-ring: 34 mm inner × 3 mm cross-section (40 mm outer), hardness 50, silicone VMQ/MVQ, food safe — 1 needed', 'Transparent O-rings: 45 mm inner × 4 mm cross-section (53 mm outer), hardness 70, VMQ, food safe — 2 needed', 'Silicone gasket, E61-compatible (Cafelat or similar): 73 mm OD × 57 mm ID × 8.5 mm'],
};

const DAY = 86400000;
const TASK_IDS = MAINTENANCE_TASKS.map((t) => t.id);

/** A log from storage or a file, brought to { weekly: [ms, …], monthly: […], deep: […] } — newest first, bounded, nothing from the future. */
export function cleanMaintenanceLog(raw, { now = Date.now() } = {}) {
  const out = {};
  for (const id of TASK_IDS) {
    const xs = Array.isArray(raw?.[id]) ? raw[id] : [];
    out[id] = [...new Set(xs.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0 && x <= now + DAY).map((x) => Math.round(x)))].sort((a, b) => b - a).slice(0, 50);
  }
  return out;
}

/** The log with a job recorded as done at `at` (ms). */
export function recordMaintenance(log, id, at, opts) {
  if (!TASK_IDS.includes(id) || !Number.isFinite(Number(at))) return cleanMaintenanceLog(log, opts);
  const next = cleanMaintenanceLog(log, opts);
  return cleanMaintenanceLog({ ...next, [id]: [Number(at), ...next[id]] }, opts);
}

/** The log without the newest entry of a job (a date entered by mistake). */
export function undoMaintenance(log, id, opts) {
  const next = cleanMaintenanceLog(log, opts);
  if (TASK_IDS.includes(id)) next[id] = next[id].slice(1);
  return next;
}

/** Two logs merged (a backup into what is here): every date of both. */
export function mergeMaintenanceLogs(a, b, opts) {
  const x = cleanMaintenanceLog(a, opts);
  const y = cleanMaintenanceLog(b, opts);
  return cleanMaintenanceLog(Object.fromEntries(TASK_IDS.map((id) => [id, [...x[id], ...y[id]]])), opts);
}

/** `ms` plus a schedule interval; months are calendar months (31 Jan + 1 month = the end of February). */
export function addInterval(ms, every) {
  const d = new Date(ms);
  if (every?.months) {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + every.months);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  if (every?.days) d.setDate(d.getDate() + every.days);
  return d.getTime();
}

/**
 * Where one job stands. `lastAt` is the last time it — or a bigger job that
 * includes it (a deep cleaning covers the chamber and the internal cleaning) —
 * was done. state: 'never' (no date entered) | 'ok' | 'soon' | 'due' (overdue).
 */
export function taskStatus(task, log, { now = Date.now(), shots = [] } = {}) {
  const clean = cleanMaintenanceLog(log, { now });
  const own = clean[task.id][0] ?? null;
  let lastAt = own;
  let coveredBy = null;
  for (const big of MAINTENANCE_TASKS) {
    if (!(big.covers || []).includes(task.id)) continue;
    const at = clean[big.id][0];
    if (at != null && (lastAt == null || at > lastAt)) {
      lastAt = at;
      coveredBy = big.id;
    }
  }
  if (lastAt == null) return { id: task.id, state: 'never', lastAt: null, ownAt: null, coveredBy: null, dueAt: null, daysLeft: null, dueInDays: null, brewsSince: null };
  const dueAt = addInterval(lastAt, task.every);
  const daysLeft = (dueAt - now) / DAY;
  const dueInDays = calendarDays(now, dueAt); // whole days on the calendar: done now + a week reads "in 7 days"
  const state = daysLeft < 0 ? 'due' : daysLeft <= (task.soonDays ?? 1) ? 'soon' : 'ok';
  const brewsSince = (shots || []).filter((s) => Number(s?.startedAt) > lastAt && !s.inProgress && s.source !== 'demo').length;
  return { id: task.id, state, lastAt, ownAt: own, coveredBy, dueAt, daysLeft, dueInDays, brewsSince };
}

/** Every job's status plus the one that comes next (overdue first, then the earliest due date). */
export function maintenanceStatus(log, opts = {}) {
  const tasks = MAINTENANCE_TASKS.map((t) => ({ task: t, ...taskStatus(t, log, opts) }));
  const dated = tasks.filter((t) => t.dueAt != null).sort((a, b) => a.dueAt - b.dueAt);
  const never = tasks.filter((t) => t.state === 'never');
  return { tasks, next: dated[0] || null, never, allNever: never.length === tasks.length };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Whole calendar days from `from` to `to` (local dates): 0 = the same day, negative = `to` is in the past. */
export function calendarDays(from, to) {
  const day = (ms) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  return Math.round((day(to) - day(from)) / DAY);
}

/** "in 3 days" / "tomorrow" / "today" / "2 days ago", from a whole number of calendar days. */
export function daysText(days) {
  if (!Number.isFinite(days)) return '';
  const n = Math.round(days);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${plural(n, 'day')}` : `${plural(-n, 'day')} ago`;
}

/** The reminder line: { state, text } — what to do next, in a sentence. */
export function maintenanceReminder(log, opts = {}) {
  const st = maintenanceStatus(log, opts);
  const fmtDate = opts.fmtDate || ((ms) => new Date(ms).toLocaleDateString());
  if (st.allNever) return { state: 'never', text: 'No cleaning dates entered yet — enter when you last did the weekly, monthly and deep cleaning to get reminders.' };
  const n = st.next;
  const brews = n.brewsSince != null ? ` · ${plural(n.brewsSince, 'brew')} since it was last done` : '';
  const others = st.tasks.filter((t) => t !== n && t.state === 'due').map((t) => t.task.name.toLowerCase());
  const tail = `${others.length ? ` Also overdue: ${others.join(', ')}.` : ''}${st.never.length ? ` No date yet for: ${st.never.map((t) => t.task.name.toLowerCase()).join(', ')}.` : ''}`;
  if (n.state === 'due') return { state: 'due', text: `Overdue: ${n.task.name} — it was due ${daysText(n.dueInDays)} (${fmtDate(n.dueAt)})${brews}.${tail}` };
  return { state: n.state, text: `Next: ${n.task.name} — due ${daysText(n.dueInDays)} (${fmtDate(n.dueAt)})${brews}.${tail}` };
}

// ------------------------------------------------------------------ piston --

const finite = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * Watches the machine's status and sensors streams through one brew and says,
 * once the machine is at rest again, whether the piston did what it should:
 * it travelled, the machine went through its retraction and back to idle, and
 * the piston came to rest (back where it started, or simply stopped). Units of
 * the position are the machine's own; only relative movement is judged.
 *
 *   onSensors({ m_pos, m_pwr, motor_temp }, atMs)
 *   onStatus({ name, state, extracting, p }, atMs)  → a result when a brew's check completes, else null
 *   onNotification(text)                            → kept with the brew it arrived during
 */
export class PistonMonitor {
  constructor({ returnTimeoutSec = 90, minBrewSec = 3, steadySec = 3 } = {}) {
    this.returnTimeoutSec = returnTimeoutSec;
    this.steadySec = steadySec; // the piston counts as stopped once its position has not moved for this long
    this.minBrewSec = minBrewSec;
    this.reset();
  }

  reset() {
    this.phase = 'idle'; // idle | brewing | returning
    this.pos = null;
    this.restPos = null;
    this.brew = null;
  }

  _newBrew(at) {
    // refKnown: the piston's rest position was seen before this brew (false when the page joined mid-brew)
    return { startedAt: at, endedAt: null, startPos: this.restPos, refKnown: this.restPos !== null, lastPos: this.pos, steadyPos: null, movedAt: at, parkedElsewhere: false, travel: 0, posSamples: 0, peakPressureBar: null, motorTempMaxC: null, motorPowerMaxPct: null, sawRetract: false, notifications: [], stages: [] };
  }

  onSensors(d, at = Date.now()) {
    const pos = finite(d?.m_pos);
    if (pos !== null) this.pos = pos;
    const b = this.brew;
    if (this.phase === 'idle') {
      if (pos !== null) this.restPos = pos;
      return;
    }
    if (!b) return;
    if (pos !== null) {
      b.posSamples++;
      if (b.startPos === null) b.startPos = this.restPos ?? pos;
      b.travel = Math.max(b.travel, Math.abs(pos - b.startPos));
      // "moved" = drifted from where it last stood by more than 1 % of the stroke (so a slow, steady crawl still counts as moving)
      if (b.steadyPos === null || Math.abs(pos - b.steadyPos) > Math.max(0.01 * b.travel, 1e-6)) {
        b.steadyPos = pos;
        b.movedAt = at;
      }
      b.lastPos = pos;
    }
    const temp = finite(d?.motor_temp ?? d?.t_motor_temp);
    if (temp !== null) b.motorTempMaxC = Math.max(b.motorTempMaxC ?? -Infinity, temp);
    const pwr = finite(d?.m_pwr);
    if (pwr !== null && this.phase === 'brewing') b.motorPowerMaxPct = Math.max(b.motorPowerMaxPct ?? -Infinity, Math.abs(pwr));
    b.lastSensorAt = at;
  }

  onNotification(text) {
    if (!this.brew) return;
    const t = String(typeof text === 'string' ? text : text?.message || '').trim().slice(0, 200);
    if (t && this.brew.notifications.length < 5) this.brew.notifications.push(t);
  }

  onStatus(s, at = Date.now()) {
    const name = String(s?.name || '');
    const extracting = !!s?.extracting;
    if (this.phase === 'idle') {
      if (extracting) {
        this.phase = 'brewing';
        this.brew = this._newBrew(at);
      }
      return null;
    }
    const b = this.brew;
    if (this.phase === 'brewing') {
      const p = finite(s?.p);
      if (p !== null) b.peakPressureBar = Math.max(b.peakPressureBar ?? -Infinity, p);
      if (name && b.stages[b.stages.length - 1] !== name && b.stages.length < 20) b.stages.push(name);
      if (!extracting) {
        b.endedAt = at;
        this.phase = 'returning';
      } else return null;
    }
    // returning: wait for the retraction to finish and the machine to be at rest again
    if (extracting) {
      // a new brew began before the last one's check finished: close that one as it stands
      const done = this._finish(at, { interrupted: true });
      this.phase = 'brewing';
      this.brew = this._newBrew(at);
      return done;
    }
    if (/retract/i.test(name)) b.sawRetract = true;
    const atRest = /^idle$/i.test(name) || (/idle/i.test(String(s?.state || '')) && !/retract|purge|closing/i.test(name));
    const posKnown = b.posSamples >= 3 && b.travel > 0;
    // at rest = back where it started, or simply stopped: the page may have joined mid-brew, and a machine may park the piston elsewhere
    const nearStart = b.refKnown && b.lastPos !== null && b.startPos !== null && Math.abs(b.lastPos - b.startPos) <= Math.max(0.1 * b.travel, 1e-6);
    const steady = b.movedAt != null && (at - b.movedAt) / 1000 >= this.steadySec;
    const home = !posKnown || nearStart || steady;
    b.parkedElsewhere = posKnown && b.refKnown && !nearStart && steady;
    const waited = (at - b.endedAt) / 1000;
    if (atRest && home) return this._finish(at, { returned: true });
    if (waited >= this.returnTimeoutSec) return this._finish(at, { returned: atRest && home, atRest, home });
    return null;
  }

  _finish(at, { returned = false, atRest = returned, home = returned, interrupted = false } = {}) {
    const b = this.brew;
    this.brew = null;
    this.phase = 'idle';
    this.restPos = this.pos;
    const brewSec = ((b.endedAt ?? at) - b.startedAt) / 1000;
    if (brewSec < this.minBrewSec) return null; // a flicker of "extracting", not a brew
    const posReported = b.posSamples >= 3 && b.travel > 0;
    const returnSec = b.endedAt != null ? (at - b.endedAt) / 1000 : null;
    const problems = [];
    if (!interrupted) {
      if (!atRest) problems.push(`The machine had not gone back to idle ${Math.round(returnSec)} s after the brew ended.`);
      else if (!home) problems.push(`The piston was still moving ${Math.round(returnSec)} s after the brew ended.`);
    }
    for (const n of b.notifications) if (/error|fail|fault|stuck|jam|leak|overheat|motor|piston/i.test(n)) problems.push(`The machine reported: ${n}`);
    const ok = problems.length === 0;
    const round = (v, d = 1) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
    const res = {
      at: Date.now(),
      ok,
      interrupted,
      returned: !!returned,
      posReported,
      sawRetract: b.sawRetract,
      parkedElsewhere: !!b.parkedElsewhere,
      brewSec: round(brewSec),
      returnSec: round(returnSec),
      travel: posReported ? round(b.travel, 2) : null,
      peakPressureBar: round(b.peakPressureBar),
      motorTempMaxC: round(b.motorTempMaxC),
      motorPowerMaxPct: round(b.motorPowerMaxPct, 0),
      problems,
    };
    res.summary = pistonSummary(res);
    return res;
  }
}

/** One sentence on a piston result. */
export function pistonSummary(r) {
  if (!r) return '';
  if (!r.ok) return `Check the piston: ${r.problems.join(' ')}`;
  if (r.interrupted) return 'The next brew began before the piston check finished; nothing wrong was seen.';
  const back = r.returnSec != null && r.returnSec >= 1 ? `${r.returnSec.toFixed(0)} s after the brew` : 'right after the brew';
  return r.posReported
    ? `All operating OK — the piston travelled its stroke${r.sawRetract ? ', retracted' : ''} and was at rest ${back}${r.parkedElsewhere ? ' (parked at a different position than it started from)' : ''}.`
    : `All operating OK — the machine ${r.sawRetract ? 'retracted the piston and ' : ''}was back at idle ${back} (this firmware does not report the piston's position, so its travel is not checked).`;
}

/** A stored piston result brought to plain, bounded fields (it is shown in the page). */
export function cleanPistonResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const r = {
    at: num(raw.at) || 0,
    ok: raw.ok === true,
    interrupted: raw.interrupted === true,
    returned: raw.returned === true,
    posReported: raw.posReported === true,
    sawRetract: raw.sawRetract === true,
    parkedElsewhere: raw.parkedElsewhere === true,
    brewSec: num(raw.brewSec),
    returnSec: num(raw.returnSec),
    travel: num(raw.travel),
    peakPressureBar: num(raw.peakPressureBar),
    motorTempMaxC: num(raw.motorTempMaxC),
    motorPowerMaxPct: num(raw.motorPowerMaxPct),
    problems: (Array.isArray(raw.problems) ? raw.problems : []).filter((p) => typeof p === 'string').map((p) => p.slice(0, 300)).slice(0, 8),
  };
  r.summary = pistonSummary(r);
  return r;
}
