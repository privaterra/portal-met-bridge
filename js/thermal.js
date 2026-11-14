// thermal.js — "Temperatures and power" as a record.
//
// The machine's "sensors" stream carries its temperature probes, the heater
// and motor power and the piston position. The Shots tab graphs them live;
// this module turns a stretch of those readings into a record that can be
// kept, listed, compared, analysed and exported (History → Temperatures and
// power):
//
//   buildRecord()      readings + the brew they belong to → a record
//   summarizeRecord()  the numbers a record is judged by
//   seriesOf()         one reading over time, for a graph
//   analyzeRecords()   the numbers side by side and what stands out
//   thermalCsvRows()   a record as a table
//
// Time inside a record is seconds from the moment the brew started (t = 0), so
// records line up when they are overlaid; the warm-up is negative time. A
// record without a brew counts from its first reading.
//
// Pure: no DOM, no storage, no clock unless one is passed in.

/** Every reading a record carries, in graph order. `kind` picks the graph: temperatures or power. */
export const THERMAL_SERIES = {
  status: { label: 'Status temperature (what the screen shows)', short: 'Status', unit: '°C', kind: 'temp', digits: 1 },
  ext1: { label: 'External 1 (boiler side)', short: 'External 1', unit: '°C', kind: 'temp', digits: 1 },
  ext2: { label: 'External 2 (brew head)', short: 'External 2', unit: '°C', kind: 'temp', digits: 1 },
  barUp: { label: 'Heater bar, upper', short: 'Bar up', unit: '°C', kind: 'temp', digits: 1 },
  barMid: { label: 'Heater bar, middle', short: 'Bar mid', unit: '°C', kind: 'temp', digits: 1 },
  barDown: { label: 'Heater bar, lower', short: 'Bar down', unit: '°C', kind: 'temp', digits: 1 },
  tube: { label: 'Tube', short: 'Tube', unit: '°C', kind: 'temp', digits: 1 },
  motor: { label: 'Motor temperature', short: 'Motor', unit: '°C', kind: 'temp', digits: 1 },
  heater: { label: 'Heater power', short: 'Heater', unit: '%', kind: 'power', digits: 0 },
  motorPower: { label: 'Motor power', short: 'Motor power', unit: '%', kind: 'power', digits: 0 },
  motorPos: { label: 'Piston position', short: 'Piston', unit: '', kind: 'power', digits: 1 },
};
export const THERMAL_KEYS = Object.keys(THERMAL_SERIES);
export const TEMP_KEYS = THERMAL_KEYS.filter((k) => THERMAL_SERIES[k].kind === 'temp');
export const POWER_KEYS = THERMAL_KEYS.filter((k) => THERMAL_SERIES[k].kind === 'power');

/** A record keeps one reading a second, and five a second while the brew runs (and a few seconds either side). */
export const IDLE_STEP_SEC = 1;
export const BREW_STEP_SEC = 0.2;
const BREW_MARGIN_SEC = 5;
/** Never more than this many readings in one record (a 30-minute warm-up and a long brew fit several times over). */
export const MAX_READINGS = 20000;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const round = (x, d) => (fin(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const DIGITS = { status: 2, ext1: 2, ext2: 2, barUp: 2, barMid: 2, barDown: 2, tube: 2, motor: 2, heater: 1, motorPower: 1, motorPos: 2, target: 1 };

/**
 * The stretches of `rows` during which the machine was brewing (row.brewing),
 * oldest first. Readings less than `gapSec` apart belong to the same brew.
 */
export function brewSpans(rows, { gapSec = 3 } = {}) {
  const out = [];
  let cur = null;
  for (const r of rows || []) {
    if (!fin(r?.wall)) continue;
    if (r.brewing) {
      if (cur && r.wall - cur.endWall <= gapSec * 1000) cur.endWall = r.wall;
      else {
        cur = { startWall: r.wall, endWall: r.wall };
        out.push(cur);
      }
    }
  }
  return out.filter((s) => s.endWall > s.startWall);
}

/** The saved shot a brew belongs to: the one that started within `toleranceSec` of it. */
export function matchShot(shots, brew, { toleranceSec = 20 } = {}) {
  if (!brew || !fin(brew.startWall)) return null;
  let best = null;
  for (const s of shots || []) {
    if (!s || s.inProgress || !fin(s.startedAt)) continue;
    const d = Math.abs(s.startedAt - brew.startWall);
    if (d <= toleranceSec * 1000 && (!best || d < best.d)) best = { s, d };
  }
  return best ? best.s : null;
}

/**
 * Readings and the brew they belong to → a record.
 *
 * @param {object} o
 * @param {Array} o.rows  readings as the Shots tab holds them: { wall (ms), status, ext1 … motorPos, target, ready, brewing, stage, state, profile }
 * @param {{startWall:number,endWall:number}|null} [o.brew]  when the brew started and ended; null for a record without a brew
 * @param {number} [o.fromWall]  leave out readings before this moment (the previous brew, say)
 * @param {object} [o.info]  what the record is filed under: { shotId, profile, targetC, machine, coffee, roaster, doseG, grind, water, rule, note, source }
 * @param {number} [o.savedAt]  when it was kept (ms)
 * @param {string} [o.id]
 * @returns {object|null} the record, or null when there is nothing to keep
 */
export function buildRecord({ rows, brew = null, fromWall = -Infinity, info = {}, savedAt = Date.now(), id } = {}) {
  let src = (rows || []).filter((r) => r && fin(r.wall) && r.wall >= fromWall).sort((a, b) => a.wall - b.wall);
  if (src.length < 2) return null;
  const hasBrew = !!brew && fin(brew.startWall) && fin(brew.endWall) && brew.endWall > brew.startWall;
  const t0Wall = hasBrew ? brew.startWall : src[0].wall;
  const inBrew = (wall) => hasBrew && wall >= brew.startWall && wall <= brew.endWall;
  const nearBrew = (wall) => hasBrew && wall >= brew.startWall - BREW_MARGIN_SEC * 1000 && wall <= brew.endWall + BREW_MARGIN_SEC * 1000;
  // thin: the probes move slowly, so a second between readings loses nothing outside the brew
  const kept = [];
  let last = -Infinity;
  for (const r of src) {
    const step = (nearBrew(r.wall) ? BREW_STEP_SEC : IDLE_STEP_SEC) * 1000 - 20;
    if (r.wall - last >= step) {
      kept.push(r);
      last = r.wall;
    }
  }
  if (kept[kept.length - 1] !== src[src.length - 1]) kept.push(src[src.length - 1]);
  src = kept.length > MAX_READINGS ? kept.slice(kept.length - MAX_READINGS) : kept;
  const cols = { t: [], target: [], ready: [], brewing: [] };
  for (const k of THERMAL_KEYS) cols[k] = [];
  const events = [];
  let stage = null;
  for (const r of src) {
    const t = round((r.wall - t0Wall) / 1000, 2);
    cols.t.push(t);
    for (const k of THERMAL_KEYS) cols[k].push(round(r[k], DIGITS[k]));
    cols.target.push(round(r.target, DIGITS.target));
    cols.ready.push(r.ready === true ? 1 : r.ready === false ? 0 : null);
    cols.brewing.push(hasBrew ? (inBrew(r.wall) ? 1 : 0) : r.brewing ? 1 : 0);
    const name = typeof r.stage === 'string' ? r.stage.slice(0, 80) : '';
    const state = typeof r.state === 'string' ? r.state.slice(0, 40) : '';
    const key = `${name}\n${state}`;
    if (key !== stage && (name || state)) {
      stage = key;
      events.push({ t, name, state });
    }
  }
  const at0 = src.reduce((best, r) => (Math.abs(r.wall - t0Wall) < Math.abs(best.wall - t0Wall) ? r : best), src[0]);
  const lastWith = (key) => {
    for (let i = src.length - 1; i >= 0; i--) if (src[i][key] !== null && src[i][key] !== undefined && src[i][key] !== '') return src[i][key];
    return null;
  };
  const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const targetC = fin(info.targetC) ? info.targetC : fin(at0.target) ? at0.target : fin(lastWith('target')) ? lastWith('target') : null;
  const rec = {
    id: id || (info.shotId ? `tp-${info.shotId}` : `tp-${Math.round(t0Wall)}-${Math.round(savedAt % 100000)}`),
    kind: 'thermal',
    at: Math.round(t0Wall), // when the brew started (or, without a brew, the first reading): what records are sorted and aligned by
    savedAt: Math.round(savedAt),
    t0Wall: Math.round(t0Wall),
    startedAt: Math.round(src[0].wall),
    endedAt: Math.round(src[src.length - 1].wall),
    brewStartedAt: hasBrew ? Math.round(brew.startWall) : null,
    brewEndedAt: hasBrew ? Math.round(brew.endWall) : null,
    brewSec: hasBrew ? round((brew.endWall - brew.startWall) / 1000, 2) : 0,
    shotId: text(info.shotId) || null,
    profile: text(info.profile) || text(at0.profile) || text(lastWith('profile')) || '',
    targetC: fin(targetC) ? round(targetC, 1) : null,
    machine: text(info.machine),
    coffee: text(info.coffee),
    roaster: text(info.roaster),
    doseG: fin(info.doseG) && info.doseG > 0 ? round(info.doseG, 1) : null,
    grind: text(info.grind),
    water: text(info.water),
    rule: text(info.rule, 400),
    note: text(info.note, 2000),
    source: info.source === 'demo' ? 'demo' : 'live',
    n: src.length,
    cols,
    events,
  };
  rec.summary = summarizeRecord(rec);
  return rec;
}

/** Mean, lowest and highest of one reading between two moments (seconds from the brew start). */
export function statsOf(rec, key, from = -Infinity, to = Infinity) {
  const t = rec?.cols?.t || [];
  const v = rec?.cols?.[key] || [];
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < t.length; i++) {
    if (t[i] < from || t[i] > to || !fin(v[i])) continue;
    n++;
    sum += v[i];
    if (v[i] < min) min = v[i];
    if (v[i] > max) max = v[i];
  }
  return n ? { n, mean: sum / n, min, max } : { n: 0, mean: null, min: null, max: null };
}

/** One reading at a moment: the nearest reading within `withinSec`, else null. */
export function valueAt(rec, key, at, withinSec = 2) {
  const t = rec?.cols?.t || [];
  const v = rec?.cols?.[key] || [];
  let best = null;
  let d = Infinity;
  for (let i = 0; i < t.length; i++) {
    if (!fin(v[i])) continue;
    const di = Math.abs(t[i] - at);
    if (di < d) {
      d = di;
      best = v[i];
    }
  }
  return d <= withinSec ? best : null;
}

/**
 * The numbers a record is judged by. Temperatures are the status temperature
 * unless named otherwise; "brew" means t = 0 … brewSec.
 */
export function summarizeRecord(rec) {
  const t = rec?.cols?.t || [];
  const r1 = (x) => round(x, 1);
  const r2 = (x) => round(x, 2);
  const hasBrew = rec?.brewSec > 0;
  const first = t.length ? t[0] : 0;
  const last = t.length ? t[t.length - 1] : 0;
  const end = hasBrew ? rec.brewSec : last;
  const out = {
    readings: t.length,
    spanSec: r1(last - first),
    leadSec: hasBrew ? r1(Math.max(0, -first)) : 0,
    brewSec: hasBrew ? r1(rec.brewSec) : 0,
    tailSec: hasBrew ? r1(Math.max(0, last - rec.brewSec)) : 0,
    targetC: fin(rec?.targetC) ? rec.targetC : null,
  };
  const all = statsOf(rec, 'status');
  out.minC = r1(all.min);
  out.maxC = r1(all.max);
  const start = hasBrew ? 0 : first;
  out.startStatusC = r1(valueAt(rec, 'status', start));
  out.startExt1C = r1(valueAt(rec, 'ext1', start));
  out.startExt2C = r1(valueAt(rec, 'ext2', start));
  out.startTubeC = r1(valueAt(rec, 'tube', start));
  const bars = ['barUp', 'barMid', 'barDown'].map((k) => valueAt(rec, k, start)).filter(fin);
  out.startBarC = bars.length ? r1(bars.reduce((a, b) => a + b, 0) / bars.length) : null;
  out.startOffsetC = hasBrew && fin(out.startStatusC) && fin(out.targetC) ? r2(out.startStatusC - out.targetC) : null;
  const brew = hasBrew ? statsOf(rec, 'status', 0, end) : { n: 0, mean: null, min: null, max: null };
  out.brewMeanC = r2(brew.mean);
  out.brewMinC = r1(brew.min);
  out.brewMaxC = r1(brew.max);
  out.brewSwingC = brew.n ? r1(brew.max - brew.min) : null;
  out.brewDropC = brew.n && fin(out.startStatusC) ? r1(Math.max(0, out.startStatusC - brew.min)) : null;
  out.brewMeanOffsetC = brew.n && fin(out.targetC) ? r2(brew.mean - out.targetC) : null;
  out.brewExt2MeanC = hasBrew ? r1(statsOf(rec, 'ext2', 0, end).mean) : null;
  const heaterAll = statsOf(rec, 'heater');
  out.heaterMaxPct = r1(heaterAll.max);
  out.heaterMeanPct = r1(heaterAll.mean);
  out.heaterBrewPct = hasBrew ? r1(statsOf(rec, 'heater', 0, end).mean) : null;
  out.heaterLeadPct = hasBrew ? r1(statsOf(rec, 'heater', -Infinity, -0.001).mean) : null;
  const mp = hasBrew ? statsOf(rec, 'motorPower', 0, end) : statsOf(rec, 'motorPower');
  out.motorPowerMeanPct = r1(mp.mean);
  out.motorPowerMaxPct = r1(mp.max);
  const pos = hasBrew ? statsOf(rec, 'motorPos', 0, end) : statsOf(rec, 'motorPos');
  out.pistonTravel = pos.n ? r2(pos.max - pos.min) : null;
  out.motorStartC = r1(valueAt(rec, 'motor', start));
  out.motorEndC = r1(valueAt(rec, 'motor', end));
  out.motorRiseC = fin(out.motorStartC) && fin(out.motorEndC) ? r1(out.motorEndC - out.motorStartC) : null;
  // the warm-up: from the first "heating" stage to the first reading at which the ready-to-brew rule was met
  const ev = Array.isArray(rec?.events) ? rec.events : [];
  const limit = hasBrew ? 0 : last;
  const heat = ev.find((e) => e.t <= limit && /heat/i.test(`${e.name} ${e.state}`));
  out.warmupSec = null;
  out.readyWaitSec = null;
  if (heat) {
    const ready = rec.cols.ready || [];
    let readyT = null;
    for (let i = 0; i < t.length; i++) {
      if (t[i] >= heat.t && t[i] <= limit && ready[i] === 1) {
        readyT = t[i];
        break;
      }
    }
    if (readyT === null) {
      const click = ev.find((e) => e.t >= heat.t && e.t <= limit && /click to start/i.test(e.name));
      if (click) readyT = click.t;
    }
    if (readyT !== null) {
      out.warmupSec = r1(readyT - heat.t);
      if (hasBrew) out.readyWaitSec = r1(Math.max(0, -readyT));
    } else if (hasBrew) out.warmupSec = r1(-heat.t); // never reported ready: heating ran until the brew started
  }
  return out;
}

/** One reading over time, for a graph: only the moments that have a value, between `from` and `to`. */
export function seriesOf(rec, key, { from = -Infinity, to = Infinity } = {}) {
  const t = rec?.cols?.t || [];
  const v = rec?.cols?.[key] || [];
  const xs = [];
  const ys = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] < from || t[i] > to || !fin(v[i])) continue;
    xs.push(t[i]);
    ys.push(v[i]);
  }
  return { xs, ys };
}

/** The x-range a comparison shows: the brews with a little either side, or everything the records hold. */
export function compareRange(records, range = 'brew', { leadSec = 60, tailSec = 15 } = {}) {
  const recs = (records || []).filter(Boolean);
  if (range !== 'brew' || !recs.some((r) => r.brewSec > 0)) return { from: -Infinity, to: Infinity };
  return { from: -leadSec, to: Math.max(...recs.map((r) => r.brewSec || 0)) + tailSec };
}

/** The stage the machine was in at a moment of a record. */
export function stageAt(rec, at) {
  let cur = null;
  for (const e of rec?.events || []) {
    if (e.t <= at + 1e-6) cur = e;
    else break;
  }
  return cur || { name: '', state: '' };
}

export const THERMAL_COLUMNS = ['time_iso', 't_from_brew_start_s', 'brewing', 'status_temp_c', 'target_c', 'external_1_c', 'external_2_c', 'bar_up_c', 'bar_mid_c', 'bar_down_c', 'tube_c', 'motor_c', 'heater_power_pct', 'motor_power_pct', 'piston_position', 'ready', 'state', 'stage'];

/** A record as a table: a header row, then one row per reading. */
export function thermalCsvRows(rec) {
  const c = rec?.cols || {};
  const t = c.t || [];
  const v = (key, i) => (fin(c[key]?.[i]) ? c[key][i] : '');
  const out = [THERMAL_COLUMNS];
  for (let i = 0; i < t.length; i++) {
    const st = stageAt(rec, t[i]);
    out.push([fin(rec.t0Wall) ? new Date(rec.t0Wall + t[i] * 1000).toISOString() : '', t[i], c.brewing?.[i] ? 'yes' : 'no', v('status', i), v('target', i), v('ext1', i), v('ext2', i), v('barUp', i), v('barMid', i), v('barDown', i), v('tube', i), v('motor', i), v('heater', i), v('motorPower', i), v('motorPos', i), c.ready?.[i] === 1 ? 'yes' : c.ready?.[i] === 0 ? 'no' : '', st.state, st.name]);
  }
  return out;
}

/** What the summary table and the summary CSV show, in order. `digits` null means text. */
export const SUMMARY_FIELDS = [
  { key: 'targetC', label: 'Target', unit: '°C', digits: 1, csv: 'target_c' },
  { key: 'startStatusC', label: 'At brew start', unit: '°C', digits: 1, csv: 'start_status_c' },
  { key: 'startOffsetC', label: 'Start vs target', unit: '°C', digits: 1, signed: true, csv: 'start_vs_target_c' },
  { key: 'brewMeanC', label: 'Mean in brew', unit: '°C', digits: 1, csv: 'brew_mean_c' },
  { key: 'brewMinC', label: 'Lowest in brew', unit: '°C', digits: 1, csv: 'brew_min_c' },
  { key: 'brewMaxC', label: 'Highest in brew', unit: '°C', digits: 1, csv: 'brew_max_c' },
  { key: 'brewDropC', label: 'Drop in brew', unit: '°C', digits: 1, csv: 'brew_drop_c' },
  { key: 'startExt1C', label: 'External 1 at start', unit: '°C', digits: 1, csv: 'start_external_1_c' },
  { key: 'startExt2C', label: 'External 2 at start', unit: '°C', digits: 1, csv: 'start_external_2_c' },
  { key: 'startTubeC', label: 'Tube at start', unit: '°C', digits: 1, csv: 'start_tube_c' },
  { key: 'heaterLeadPct', label: 'Heater before brew', unit: '%', digits: 0, csv: 'heater_before_brew_pct' },
  { key: 'heaterBrewPct', label: 'Heater in brew', unit: '%', digits: 0, csv: 'heater_in_brew_pct' },
  { key: 'motorPowerMeanPct', label: 'Motor power', unit: '%', digits: 0, csv: 'motor_power_mean_pct' },
  { key: 'motorRiseC', label: 'Motor warmed by', unit: '°C', digits: 1, signed: true, csv: 'motor_rise_c' },
  { key: 'pistonTravel', label: 'Piston travel', unit: '', digits: 1, csv: 'piston_travel' },
  { key: 'warmupSec', label: 'Warm-up', unit: 's', digits: 0, span: true, csv: 'warmup_s' },
  { key: 'readyWaitSec', label: 'Ready → brew', unit: 's', digits: 0, span: true, csv: 'ready_to_brew_s' },
  { key: 'brewSec', label: 'Brew', unit: 's', digits: 1, csv: 'brew_s' },
  { key: 'readings', label: 'Readings', unit: '', digits: 0, csv: 'readings' },
];

/** 95 s → "1 min 35 s". */
export const fmtSpan = (sec) => (!fin(sec) ? '–' : sec >= 90 ? `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s` : `${Math.round(sec)} s`);

/** One summary value as text ("92.4 °C", "+0.6 °C", "4 min 10 s", "–"). */
export function fmtSummary(field, value) {
  if (!fin(value)) return '–';
  if (field.span) return fmtSpan(value);
  const s = `${field.signed && value > 0 ? '+' : ''}${value.toFixed(field.digits)}`;
  return field.unit ? `${s} ${field.unit}` : s;
}

/** The summary CSV: a header, then one row per record. */
export function thermalSummaryRows(records) {
  const head = ['brew_started_iso', 'saved_iso', 'profile', 'coffee', 'roaster', 'machine', 'shot_id', ...SUMMARY_FIELDS.map((f) => f.csv), 'note'];
  const out = [head];
  for (const r of records || []) {
    const s = r.summary || summarizeRecord(r);
    out.push([fin(r.at) ? new Date(r.at).toISOString() : '', fin(r.savedAt) ? new Date(r.savedAt).toISOString() : '', r.profile || '', r.coffee || '', r.roaster || '', r.machine || '', r.shotId || '', ...SUMMARY_FIELDS.map((f) => (fin(s[f.key]) ? s[f.key] : '')), r.note || '']);
  }
  return out;
}

/**
 * The selected records side by side and what stands out, in plain words.
 * `labelOf(record)` names a record in the findings (a date, a coffee).
 * Only what the readings show is stated: no advice about the cup.
 */
export function analyzeRecords(records, { labelOf = (r) => r.id } = {}) {
  const recs = (records || []).filter(Boolean);
  const rows = recs.map((r) => ({ id: r.id, label: labelOf(r), record: r, s: r.summary || summarizeRecord(r) }));
  const findings = [];
  const c1 = (x) => `${x.toFixed(1)} °C`;
  for (const { label, s } of rows) {
    const parts = [];
    if (!(s.brewSec > 0)) {
      parts.push(`no brew in this record — ${fmtSpan(s.spanSec)} of readings${fin(s.minC) && fin(s.maxC) ? `, status temperature ${c1(s.minC)} to ${c1(s.maxC)}` : ''}`);
    } else {
      if (fin(s.startStatusC)) {
        if (fin(s.startOffsetC)) parts.push(Math.abs(s.startOffsetC) < 0.3 ? `the brew started at ${c1(s.startStatusC)}, on the ${c1(s.targetC)} target` : `the brew started at ${c1(s.startStatusC)}, ${c1(Math.abs(s.startOffsetC))} ${s.startOffsetC < 0 ? 'below' : 'above'} the ${c1(s.targetC)} target`);
        else parts.push(`the brew started at ${c1(s.startStatusC)} (the profile's target is not known)`);
      }
      if (fin(s.brewMinC) && fin(s.brewMaxC)) parts.push(s.brewDropC >= 1 ? `it fell ${c1(s.brewDropC)} during the brew (lowest ${c1(s.brewMinC)}, mean ${c1(s.brewMeanC)})` : `it stayed within ${c1(s.brewSwingC)} during the brew (mean ${c1(s.brewMeanC)})`);
      if (fin(s.heaterBrewPct)) parts.push(`the heater averaged ${s.heaterBrewPct.toFixed(0)} % during the brew${fin(s.heaterLeadPct) ? ` and ${s.heaterLeadPct.toFixed(0)} % before it` : ''}`);
      if (fin(s.warmupSec)) parts.push(`the warm-up took ${fmtSpan(s.warmupSec)}${fin(s.readyWaitSec) ? `, then the machine stood ready for ${fmtSpan(s.readyWaitSec)}` : ''}`);
      else if (s.leadSec < 30) parts.push(`only ${fmtSpan(s.leadSec)} of readings before the brew, so the warm-up is not in this record`);
    }
    if (parts.length) findings.push(`${label}: ${parts.join('; ')}.`);
  }
  const brewed = rows.filter((r) => r.s.brewSec > 0);
  if (brewed.length >= 2) {
    const spread = (key, unit, digits, what) => {
      const have = brewed.filter((r) => fin(r.s[key]));
      if (have.length < 2) return;
      const lo = have.reduce((a, b) => (b.s[key] < a.s[key] ? b : a));
      const hi = have.reduce((a, b) => (b.s[key] > a.s[key] ? b : a));
      const d = hi.s[key] - lo.s[key];
      const f = (x) => (unit === 's' ? fmtSpan(x) : `${x.toFixed(digits)} ${unit}`);
      findings.push(d < 10 ** -digits / 2 ? `${what}: the same in all ${have.length} brews (${f(lo.s[key])}).` : `${what}: from ${f(lo.s[key])} (${lo.label}) to ${f(hi.s[key])} (${hi.label}) — ${f(d)} apart.`);
    };
    const targets = [...new Set(brewed.map((r) => r.s.targetC).filter(fin))];
    if (targets.length > 1) findings.push(`The brews have different targets (${targets.sort((a, b) => a - b).map((x) => c1(x)).join(', ')}): compare "start vs target" rather than the temperatures themselves.`);
    spread('startStatusC', '°C', 1, 'Temperature at brew start');
    if (targets.length > 1) spread('startOffsetC', '°C', 1, 'Start vs target');
    spread('brewMeanC', '°C', 1, 'Mean temperature in the brew');
    spread('brewDropC', '°C', 1, 'Drop during the brew');
    spread('heaterBrewPct', '%', 0, 'Heater power in the brew');
    spread('warmupSec', 's', 0, 'Warm-up');
  }
  return { rows, findings, fields: SUMMARY_FIELDS };
}

/** One reading at fixed steps (the mean of each step), for a compact text digest. */
export function resample(rec, key, { from, to, step }) {
  const out = [];
  for (let a = from; a < to - 1e-9; a += step) {
    const s = statsOf(rec, key, a, a + step - 1e-9);
    out.push(s.n ? Math.round(s.mean * 10) / 10 : null);
  }
  return out;
}

/**
 * The selected records as text for an AI model: the summary numbers, the
 * findings, and each record's main readings at coarse steps (30 s before the
 * brew, 2 s during it). Nothing but numbers, profile and coffee names.
 */
export function thermalDigest(records, { labelOf = (r) => r.id } = {}) {
  const { rows, findings } = analyzeRecords(records, { labelOf });
  const lines = ['# Temperatures and power — records from a Meticulous espresso machine', '', 'Time is seconds from the start of the brew (t = 0); negative time is the warm-up. "Status" is the water temperature the machine shows.', ''];
  rows.forEach(({ label, record: r, s }, i) => {
    lines.push(`## Record ${i + 1}: ${label}`);
    lines.push(`Profile: ${r.profile || 'unknown'} · target ${fin(s.targetC) ? `${s.targetC} °C` : 'unknown'} · coffee: ${[r.coffee, r.roaster].filter(Boolean).join(' · ') || 'not given'}${r.rule ? ` · ready-to-brew rule: ${r.rule}` : ''}`);
    lines.push(SUMMARY_FIELDS.map((f) => `${f.label}: ${fmtSummary(f, s[f.key])}`).join(' · '));
    if (r.events?.length) lines.push(`Stages: ${r.events.slice(0, 40).map((e) => `${e.t.toFixed(0)} s ${e.name || e.state}`).join(' → ')}`);
    const t = r.cols.t;
    const first = t[0];
    const last = t[t.length - 1];
    const table = (title, from, to, step) => {
      if (!(to > from)) return;
      const keys = ['status', 'ext1', 'ext2', 'tube', 'heater', 'motorPower'];
      const cols = keys.map((k) => resample(r, k, { from, to, step }));
      lines.push('', `${title} (every ${step} s): t | ${keys.map((k) => THERMAL_SERIES[k].short).join(' | ')}`);
      const n = Math.min(cols[0].length, 60);
      for (let j = 0; j < n; j++) lines.push(`${(from + j * step).toFixed(0)} | ${cols.map((c) => (c[j] === null ? '' : c[j])).join(' | ')}`);
    };
    if (r.brewSec > 0) {
      table('Before the brew', Math.max(first, -900), 0, 30);
      table('During the brew', 0, Math.min(last, r.brewSec + 10), 2);
    } else table('Readings', first, last, Math.max(5, Math.ceil((last - first) / 50)));
    lines.push('');
  });
  if (findings.length) lines.push('## What the numbers show', ...findings.map((f) => `- ${f}`));
  return lines.join('\n');
}

export const THERMAL_AI_SYSTEM = `You review temperature and power logs from a Meticulous espresso machine for its owner. Each record covers a warm-up and one brew: the status (water) temperature against the profile's target, the external probes, the tube, the heater's power and the motor's power.
Work only from the numbers given. Say what the warm-up and the brew looked like, how close the brew was to its target and how steady it stayed, how the records differ, and what the owner could try next (for example waiting longer after "ready", preheating, or a different ready-to-brew rule) — and say plainly when the data cannot support a conclusion. Temperature readings are the machine's own sensors, not a measurement in the coffee bed. Do not invent readings. Write short Markdown: a summary, one section per record, a comparison when there is more than one, and suggestions.`;

// ---------------------------------------------------------------- import --

/**
 * A record from a backup file, brought to the shape buildRecord() writes:
 * bounded strings, finite numbers, columns of equal length. The summary is
 * recomputed from the readings rather than believed. Null when it is not a record.
 */
export function cleanImportedThermal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.cols || typeof raw.cols !== 'object' || !Array.isArray(raw.cols.t)) return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 200) : null;
  if (!id) return null;
  const n = Math.min(raw.cols.t.length, MAX_READINGS);
  if (n < 2) return null;
  const numCol = (a) => Array.from({ length: n }, (_, i) => (Array.isArray(a) && fin(a[i]) ? a[i] : null));
  const cols = { t: numCol(raw.cols.t) };
  if (cols.t.some((x) => x === null)) return null;
  for (let i = 1; i < n; i++) if (cols.t[i] < cols.t[i - 1]) return null; // time must run forwards
  for (const k of [...THERMAL_KEYS, 'target']) cols[k] = numCol(raw.cols[k]);
  cols.ready = Array.from({ length: n }, (_, i) => (raw.cols.ready?.[i] === 1 ? 1 : raw.cols.ready?.[i] === 0 ? 0 : null));
  cols.brewing = Array.from({ length: n }, (_, i) => (raw.cols.brewing?.[i] ? 1 : 0));
  const text = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v) => (fin(v) ? v : null);
  const events = (Array.isArray(raw.events) ? raw.events : [])
    .filter((e) => e && typeof e === 'object' && fin(e.t))
    .slice(0, 500)
    .map((e) => ({ t: e.t, name: text(e.name, 80), state: text(e.state, 40) }))
    .sort((a, b) => a.t - b.t);
  const brewSec = fin(raw.brewSec) && raw.brewSec > 0 ? raw.brewSec : 0;
  const rec = {
    id,
    kind: 'thermal',
    at: num(raw.at) ?? num(raw.t0Wall) ?? 0,
    savedAt: num(raw.savedAt) ?? 0,
    t0Wall: num(raw.t0Wall) ?? num(raw.at) ?? 0,
    startedAt: num(raw.startedAt) ?? 0,
    endedAt: num(raw.endedAt) ?? 0,
    brewStartedAt: brewSec ? num(raw.brewStartedAt) : null,
    brewEndedAt: brewSec ? num(raw.brewEndedAt) : null,
    brewSec,
    shotId: text(raw.shotId) || null,
    profile: text(raw.profile),
    targetC: num(raw.targetC),
    machine: text(raw.machine),
    coffee: text(raw.coffee),
    roaster: text(raw.roaster),
    doseG: fin(raw.doseG) && raw.doseG > 0 ? raw.doseG : null,
    grind: text(raw.grind),
    water: text(raw.water),
    rule: text(raw.rule, 400),
    note: text(raw.note, 2000),
    source: raw.source === 'demo' ? 'demo' : 'live',
    n,
    cols,
    events,
  };
  rec.summary = summarizeRecord(rec);
  return rec;
}

// ------------------------------------------------------------------ demo --

/**
 * Synthetic readings for a demo shot: a seven-minute warm-up to the target,
 * a short wait at ready, the brew with a small dip, and the seconds after it.
 * Plausible shapes, not measurements. Returns readings as buildRecord() takes them.
 */
export function makeDemoThermalRows({ startedAt, durationSec = 30, targetC = 93, seed = 7, leadSec = 420, tailSec = 12, profile = 'Blooming Espresso (demo)' } = {}) {
  let a = seed | 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const noise = (amp) => (rnd() - 0.5) * amp;
  const offset = (seed % 5) * 0.25 - 0.4; // each demo brew starts a little differently
  const readyAt = -(25 + (seed % 4) * 15); // seconds before the brew at which it reached the target
  const rows = [];
  // whole milliseconds, so a long warm-up does not drift off the second
  for (let ms = -leadSec * 1000; ms <= (durationSec + tailSec) * 1000; ms += ms >= -6000 && ms < (durationSec + 6) * 1000 ? 200 : 1000) {
    const t = ms / 1000;
    const brewing = t >= 0 && t <= durationSec;
    const heatFrac = Math.min(1, Math.max(0, (t + leadSec) / (leadSec + readyAt))); // 0 → 1 over the warm-up
    let status = 58 + (targetC + offset - 58) * (1 - Math.exp(-4 * heatFrac)) / (1 - Math.exp(-4));
    if (brewing) status -= 1.6 * Math.sin((Math.PI * Math.min(t, 12)) / 24) - Math.max(0, t - 12) * 0.03;
    else if (t > durationSec) status -= 0.9 - (t - durationSec) * 0.03;
    const heating = t < readyAt;
    const heater = heating ? Math.min(100, 100 - 55 * heatFrac ** 3) : brewing ? 62 + noise(10) : 28 + noise(8);
    const stage = heating ? 'heating' : t < 0 ? 'click to start' : brewing ? (t < 6 ? 'Bloom' : t < 14 ? 'Ramp' : 'Decline') : t < durationSec + 6 ? 'retracting' : 'idle';
    rows.push({
      wall: startedAt + ms,
      status: status + noise(0.08),
      ext1: status + 9.5 + 1.5 * (1 - heatFrac) + noise(0.1),
      ext2: status + 10.2 - 3 * (1 - heatFrac) + noise(0.1),
      barUp: status - 8.5 - 6 * (1 - heatFrac) + noise(0.1),
      barMid: status - 5 - 5 * (1 - heatFrac) + noise(0.1),
      barDown: status - 7.5 - 7 * (1 - heatFrac) + noise(0.1),
      tube: status - 6.5 - 10 * (1 - heatFrac) + noise(0.1),
      motor: 29 + (brewing ? t * 0.04 : t > durationSec ? durationSec * 0.04 : 0) + noise(0.05),
      heater: Math.max(0, Math.min(100, heater)),
      motorPower: brewing ? 22 + 6 * Math.min(1, t / 8) + noise(2) : t > durationSec && t < durationSec + 6 ? 12 : 0,
      motorPos: brewing ? Math.min(60, t * 1.9) : t > durationSec ? Math.max(0, 60 - (t - durationSec) * 10) : 0,
      target: targetC,
      ready: t >= readyAt && t < 0 ? true : t < readyAt ? false : null,
      brewing,
      stage,
      state: brewing ? 'brewing' : heating ? 'heating' : 'idle',
      profile,
    });
  }
  return rows;
}
