// refractometer.js — calibrating the Belka Portal with a refractometer.
//
// The Portal measures conductivity (EC), a refractometer measures everything
// dissolved (TDS). A refractometer reading taken right after a brew pairs the
// two for that coffee: TDS% = k × mean EC per gram (analysis.js fits k per
// coffee from every paired shot). This module holds what Settings →
// Refractometer needs around that fit: the procedure as text, whether a brew
// is recent enough to calibrate with, the reading that is stored on the shot,
// what one more reading does to a coffee's calibration, and the history list.
// The steps are written for the DiFluid R2 Extract (from DiFluid's own guide),
// with a general version for any other refractometer.
// Pure — no DOM, no storage — so it is unit-tested.

import { fitForCoffee, predictTds, extractionYield, beverageOf } from './analysis.js?v=0.21.0';

/** A brew counts as "just taken place" for this long (Settings can change it): the sample should be fresh. */
export const CALIBRATION_WINDOW_MIN = 30;

/**
 * The refractometers the procedure is written for. The R2 Extract's steps and
 * figures follow DiFluid's own guide (read on `retrieved`); "other" is the
 * general practice for a digital coffee refractometer.
 */
export const REFRACTOMETERS = {
  r2extract: {
    name: 'DiFluid R2 Extract',
    url: 'https://digitizefluid.com/products/r2-extract',
    guideUrl: 'https://digitizefluid.com/blogs/difluid-resources/r2-extract-complete-guide',
    retrieved: '2026-11-14',
    specs: 'range 0–30 % TDS · accuracy ±0.03 % · precision ±0.02 % · resolution 0.01 % · a reading in about 4 s · works at 5–40 °C',
    defaultZero: 'brewing',
    zeroedLabel: 'The R2 Extract is zeroed: its screen read 0.00 % after “Zeroing”',
  },
  other: {
    name: 'another refractometer',
    url: '',
    guideUrl: '',
    retrieved: '',
    specs: '',
    defaultZero: 'distilled',
    zeroedLabel: 'The refractometer is zeroed: it reads 0.00 with water on the prism',
  },
};
export const refractometerOf = (model) => REFRACTOMETERS[model] || REFRACTOMETERS.r2extract;

/** What the refractometer was zeroed with. */
export const ZERO_WITH = {
  distilled: 'distilled or deionised water',
  brewing: 'the brewing water',
  none: 'not zeroed this time',
};

/** Two or three readings of one cup should agree to within this (% TDS); more than that and a sample was still settling or evaporating. */
export const READING_SPREAD_WARN = 0.1;

const BREW_STEP = {
  id: 'brew',
  title: 'Pull the shot with the Portal connected',
  text: 'The calibration always follows a brew: the Portal has to have measured the shot the sample comes from.',
  points: [
    'Connect the machine and the Portal, fill in This coffee (the bean name is what readings are grouped by) and brew as usual.',
    'Keep the whole shot in the cup — the reading must describe everything the Portal saw. Do not drink from it yet.',
    'Start the calibration soon after the shot is saved, and let the cup cool while you zero the refractometer: a sample that stands for long evaporates and reads high.',
  ],
};
const CALIBRATE_POINTS = [
  'The pair (mean EC per gram, TDS %) joins the coffee\'s calibration: TDS % = k × mean EC per gram, fitted from every paired brew of that coffee.',
  'One brew gives a first, preliminary k. Five or more, spread over stronger and weaker shots, make the estimate trustworthy inside the range you measured.',
  'The ratio belongs to a coffee, a water and a Portal: keep the water and the Portal\'s mounting the same while you collect readings, and calibrate each new coffee.',
];

/**
 * The procedure, in order, per refractometer. Settings → Refractometer →
 * Detail prints it whole; the guided calibration walks through the same steps
 * one at a time.
 */
export const GUIDES = {
  r2extract: [
    BREW_STEP,
    {
      id: 'zero',
      title: 'Zero the R2 Extract',
      text: 'DiFluid calls this calibration: it shows the R2 Extract what "no coffee" looks like. Do it at the start of every session, and whenever the drop icon appears at the top right of its screen.',
      points: [
        'Rinse the glass at the bottom of the sample dish with clean water and wipe the dish completely dry with the cloth. Tap the button once to switch the R2 Extract on.',
        'Spoon the baseline water onto the prism until it is covered. The brewing water is the simple choice: its own minerals are zeroed out, so what you read afterwards is what the coffee alone added. Distilled or deionised water is a true zero and the most accurate, but the brewing water\'s own reading then has to be subtracted — the calibration asks for it.',
        'Wait 5 seconds for the temperatures to even out. Then tap the button quickly and hold the second press until the screen says Zeroing, and let go.',
        'The screen should read 0.00 %. "Zero Failed" means the dish or the prism was not clean, or the water not at temperature: clean and zero again.',
        'Empty the dish and wipe it completely dry before the coffee.',
      ],
    },
    {
      id: 'sample',
      title: 'Take the coffee sample',
      text: 'Evaporation is what spoils a reading: hot coffee on the prism concentrates and reads high, and so does a drop that is tested again and again.',
      points: [
        'Stir the cup thoroughly and let the coffee cool to near room temperature (the R2 Extract works between 5 and 40 °C).',
        'Spoon the coffee onto the prism with the clean, dry spoon and fill the dish: a larger sample loses proportionally less to evaporation.',
        'For espresso, running the sample through a paper filter first takes the oils out and gives the most accurate reading. It is optional; do it every time or never, and tick the box in the calibration when you did.',
        'Leave the coffee on the prism for 5–10 seconds so the two reach the same temperature, then tap the button once. The TDS appears in about 4 seconds.',
        'For a second and a third reading, rinse and dry the dish and spoon on a fresh sample each time — do not test the drop already on the prism — and leave a few seconds between tests. The readings should agree to within 0.1 % TDS.',
        'Weigh the cup if you can: the beverage weight is what turns TDS into extraction yield.',
      ],
    },
    {
      id: 'calibrate',
      title: 'Calibrate the Portal\'s readings',
      text: 'The reading is stored on the brew and paired with the Portal\'s mean conductivity per gram for it.',
      points: ['Enter the readings as the R2 Extract shows them (it resolves 0.01 % TDS); the app takes their mean as the TDS of the cup, less the brewing water\'s own reading when you zeroed with distilled water.', ...CALIBRATE_POINTS, 'Afterwards rinse the prism with clean water and wipe it dry. The dish is water-resistant; keep water away from the charging port.'],
    },
  ],
  other: [
    BREW_STEP,
    {
      id: 'zero',
      title: 'Zero the refractometer',
      text: 'A refractometer measures against water, so it is zeroed before the sample — every session, and again when the room temperature has changed.',
      points: [
        'Wipe the prism clean and dry with a soft tissue (a drop of water or an alcohol wipe first, if coffee dried on it).',
        'Put a few drops of distilled or deionised water at room temperature on the prism, enough to cover it, and close the lid if it has one. (Zeroing with the brewing water instead takes the water\'s own minerals out of the reading.)',
        'Wait about 30 seconds for the water to reach the prism\'s temperature, then press Zero. A reading afterwards should show 0.00.',
        'Dry the prism again.',
      ],
    },
    {
      id: 'sample',
      title: 'Take the coffee sample',
      text: 'The sample has to stand for the whole cup and be at the prism\'s temperature when it is read.',
      points: [
        'Stir the cup thoroughly — espresso layers, and the last drops are much weaker than the first.',
        'Draw a little from the middle of the cup with a clean pipette. A syringe or paper filter is optional: it removes fines and oils and gives steadier readings; say so in the calibration if you used one, and use it every time or never.',
        'Let the sample cool for about a minute (in the pipette, or on a clean spoon), then put a few drops on the prism.',
        'Wait 20–30 seconds, then take two or three readings, each from a fresh sample. They should agree to within 0.1 % TDS; if they still drift, wait and read again.',
        'Weigh the cup if you can: the beverage weight is what turns TDS into extraction yield.',
      ],
    },
    {
      id: 'calibrate',
      title: 'Calibrate the Portal\'s readings',
      text: 'The reading is stored on the brew and paired with the Portal\'s mean conductivity per gram for it.',
      points: ['Enter the readings; the app takes their mean as the TDS of the cup, less the brewing water\'s own reading when you zeroed with distilled water.', ...CALIBRATE_POINTS, 'Rinse and dry the prism when you are done.'],
    },
  ],
};
export const refractometerGuide = (model) => GUIDES[model] || GUIDES.r2extract;
/** The procedure for the refractometer the app is set up for by default. */
export const REFRACTOMETER_GUIDE = GUIDES.r2extract;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 2) => (finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** When a shot's recording ended, in ms. */
export function shotEndedAt(shot) {
  if (finite(shot?.endedAt) && shot.endedAt > 0) return shot.endedAt;
  const start = Number(shot?.startedAt) || 0;
  return start + Math.max(0, Number(shot?.durationSec) || 0) * 1000;
}

/**
 * The brew a calibration can be made with right now: the newest finished shot.
 * state: 'ready' | 'recording' | 'none' | 'old' | 'no-portal' | 'poor-portal';
 * `shot` is that brew (null for 'none'), `ageMin` how long ago it ended,
 * `leftMin` how long the window stays open, `hasReading` whether it already
 * carries a reading (calibrating again replaces it).
 */
export function calibrationCandidate(shots, { now = Date.now(), windowMin = CALIBRATION_WINDOW_MIN, recording = false } = {}) {
  if (recording) return { state: 'recording', shot: null, ageMin: null, leftMin: null, hasReading: false };
  const shot = (shots || []).filter((s) => s && !s.inProgress).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
  if (!shot) return { state: 'none', shot: null, ageMin: null, leftMin: null, hasReading: false };
  const ageMin = Math.max(0, (now - shotEndedAt(shot)) / 60000);
  const base = { shot, ageMin, leftMin: Math.max(0, windowMin - ageMin), hasReading: Number(shot.refractometer?.tdsPct) > 0 };
  const ec = Number(shot.analysisCache?.meanEcPerG);
  if (!(shot.portal?.length > 0) || !(ec > 0)) return { ...base, state: 'no-portal' };
  if (ageMin > windowMin) return { ...base, state: 'old' };
  if (shot.analysisCache?.status && shot.analysisCache.status !== 'ok') return { ...base, state: 'poor-portal' };
  return { ...base, state: 'ready' };
}

/** The valid readings among those typed (0 < TDS < 30), their mean and their spread. */
export function averageReadings(values) {
  const xs = (values || []).map((v) => (v === '' || v === null || v === undefined ? NaN : Number(v))).filter((v) => finite(v) && v > 0 && v < 30);
  if (!xs.length) return { n: 0, mean: null, spread: null, values: [], steady: true };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const spread = Math.max(...xs) - Math.min(...xs);
  return { n: xs.length, mean: round(mean, 2), spread: round(spread, 2), values: xs.map((v) => round(v, 2)), steady: spread <= READING_SPREAD_WARN + 1e-9 };
}

/**
 * The brewing water's own reading that has to come off the coffee's: only when
 * the refractometer was zeroed with distilled water (a brewing-water zero has
 * already taken it out), and only a plausible one (water reads well under 1 % TDS).
 */
export function netWater(zeroWith, waterTdsPct) {
  const w = Number(waterTdsPct);
  return zeroWith === 'distilled' && finite(w) && w > 0 && w < 1 ? round(w, 2) : 0;
}
/** The coffee's TDS: the reading less the water's own. */
export const netTds = (readingPct, water = 0) => round(Number(readingPct) - (water > 0 ? water : 0), 2);

const cleanNote = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
const zeroKey = (v) => (v in ZERO_WITH ? v : '');

/**
 * The reading as it is stored on a shot (`shot.refractometer`): flat — numbers,
 * strings and booleans only, which is what a restored backup is allowed to carry.
 *   tdsPct, eyPct, at           what every reading has had since v0.1
 *   method                      'guided' (the calibration in Settings) or 'typed' (the Shots tab, an edit)
 *   tds1 … tds3                 the individual readings behind the mean
 *   zeroWith, zeroedAt          what the refractometer was zeroed with, and when
 *   filtered                    the sample went through a filter
 *   waterTdsPct                 the brewing water's own reading, subtracted from the mean (a distilled-water zero)
 *   device                      the refractometer
 *   meanEcPerG                  the Portal's mean EC per gram for the brew when the reading was taken
 *   note
 */
export function buildReading({ readings = [], tdsPct, beverageG, doseG, zeroWith = '', zeroedAt = null, filtered = false, note = '', at = Date.now(), method = 'guided', meanEcPerG = null, waterTdsPct = null, device = '' } = {}) {
  const avg = averageReadings(readings);
  const water = netWater(zeroWith, waterTdsPct);
  const tds = netTds(avg.n ? avg.mean : Number(tdsPct), water);
  if (!(tds > 0 && tds < 30)) return null;
  const out = { tdsPct: tds, eyPct: extractionYield(tds, Number(beverageG) || 0, Number(doseG) || 0), at: finite(at) && at > 0 ? Math.round(at) : Date.now(), method: method === 'guided' ? 'guided' : 'typed' };
  avg.values.slice(0, 3).forEach((v, i) => (out[`tds${i + 1}`] = v));
  if (zeroKey(zeroWith)) out.zeroWith = zeroKey(zeroWith);
  if (finite(zeroedAt) && zeroedAt > 0) out.zeroedAt = Math.round(zeroedAt);
  if (filtered === true) out.filtered = true;
  if (water > 0) out.waterTdsPct = water;
  if (cleanNote(device)) out.device = cleanNote(device).slice(0, 60);
  if (finite(meanEcPerG) && meanEcPerG > 0) out.meanEcPerG = round(meanEcPerG, 4);
  if (cleanNote(note)) out.note = cleanNote(note);
  return out;
}

/**
 * A stored reading with some of its fields changed (the history's Edit, the
 * shot editor's TDS field): what was recorded with it is kept, except the
 * individual readings when the TDS itself was changed — they no longer add up to it.
 */
export function editReading(prev, { tdsPct, beverageG, doseG, at, zeroWith, filtered, note } = {}) {
  const base = prev && typeof prev === 'object' ? { ...prev } : {};
  const tds = tdsPct === undefined ? Number(base.tdsPct) : round(Number(tdsPct), 2);
  if (!(tds > 0 && tds < 30)) return null;
  if (tds !== Number(base.tdsPct)) for (const k of ['tds1', 'tds2', 'tds3', 'waterTdsPct']) delete base[k]; // the typed value is the coffee's TDS as it stands
  base.tdsPct = tds;
  base.eyPct = extractionYield(tds, Number(beverageG) || 0, Number(doseG) || 0);
  if (at !== undefined && finite(Number(at)) && Number(at) > 0) base.at = Math.round(Number(at));
  if (!finite(base.at)) base.at = Date.now();
  if (zeroWith !== undefined) {
    if (zeroKey(zeroWith)) base.zeroWith = zeroKey(zeroWith);
    else delete base.zeroWith;
  }
  if (filtered !== undefined) {
    if (filtered === true) base.filtered = true;
    else delete base.filtered;
  }
  if (note !== undefined) {
    if (cleanNote(note)) base.note = cleanNote(note);
    else delete base.note;
  }
  if (!base.method) base.method = 'typed';
  return base;
}

const fitNumbers = (fit) =>
  fit && fit.calibrated
    ? { calibrated: true, k: round(fit.proportional?.k, 4), shots: fit.shotCount, loocv: finite(fit.proportional?.loocvRmse) ? round(fit.proportional.loocvRmse, 2) : null, model: fit.activeModel, preliminary: !!fit.preliminary }
    : { calibrated: false, k: null, shots: fit?.shotCount || 0, loocv: null, model: 'none', preliminary: true };

/**
 * What one reading does to its coffee's calibration: the fit of the coffee's
 * other paired brews, the fit with this one added, what the app would have
 * estimated for this brew before, and how far off that was.
 * `points` are calibration points ({ id, meanEcPerG, tdsPct, coffeeKey, … }) of
 * every other shot; `coffee` is { coffeeKey, roasterKey, roastLevel }.
 */
export function calibrationImpact(points, coffee, { id, meanEcPerG, tdsPct, reliable = true }, { minShots } = {}) {
  const others = (points || []).filter((p) => p.id !== id);
  const before = fitForCoffee(others, coffee, 'bean', { minShots });
  const point = { id, meanEcPerG, tdsPct, reliable, coffeeKey: coffee?.coffeeKey || '', roasterKey: coffee?.roasterKey || '', roastLevel: coffee?.roastLevel || '' };
  const after = fitForCoffee([...others, point], coffee, 'bean', { minShots });
  const estimateBefore = predictTds(before, meanEcPerG);
  return {
    ratio: meanEcPerG > 0 && tdsPct > 0 ? round(tdsPct / meanEcPerG, 4) : null,
    before: fitNumbers(before),
    after: fitNumbers(after),
    estimateBefore: finite(estimateBefore) ? round(estimateBefore, 2) : null,
    errorBefore: finite(estimateBefore) && tdsPct > 0 ? round(estimateBefore - tdsPct, 2) : null,
  };
}

/** One sentence on what the calibration now is. */
export function impactText(impact, coffeeName = 'this coffee') {
  if (!impact) return '';
  const a = impact.after;
  if (!a.calibrated) return impact.ratio ? `This brew gives ${impact.ratio.toFixed(3)} % TDS per mS/cm, but the Portal's data for it is not good enough to calibrate with.` : 'Not enough to calibrate with yet.';
  const was = impact.before.calibrated ? `was ${impact.before.k.toFixed(3)} from ${impact.before.shots}` : 'the first reading';
  const err = impact.errorBefore !== null ? ` Before this reading the app would have estimated ${impact.estimateBefore.toFixed(2)} % TDS for the brew (${impact.errorBefore >= 0 ? '+' : '−'}${Math.abs(impact.errorBefore).toFixed(2)}).` : '';
  return `${coffeeName}: k = ${a.k.toFixed(3)} % TDS per mS/cm from ${a.shots} paired brew${a.shots === 1 ? '' : 's'} (${was})${a.loocv !== null ? `, leave-one-out error ±${a.loocv.toFixed(2)} % TDS` : ''}${a.preliminary ? ' — preliminary' : ''}.${err}`;
}

/**
 * The history: one row per brew that carries a reading, newest calibration
 * first. Everything a row shows is a number or a bounded string.
 */
export function readingRows(shots) {
  return (shots || [])
    .filter((s) => s && !s.inProgress && Number(s.refractometer?.tdsPct) > 0)
    .map((s) => {
      const r = s.refractometer;
      const c = s.context || {};
      const ec = Number(s.analysisCache?.meanEcPerG);
      const tds = Number(r.tdsPct);
      const readings = [r.tds1, r.tds2, r.tds3].map(Number).filter((v) => finite(v) && v > 0);
      const bev = beverageOf(s);
      const dose = Number(c.doseG) || 0;
      return {
        id: String(s.id),
        at: finite(Number(r.at)) && Number(r.at) > 0 ? Number(r.at) : Number(s.startedAt) || 0,
        shotAt: Number(s.startedAt) || 0,
        bean: String(c.beanName || ''),
        roaster: String(c.roaster || ''),
        profile: String(s.profileName || ''),
        demo: s.source === 'demo',
        tdsPct: tds,
        readings,
        spread: readings.length > 1 ? round(Math.max(...readings) - Math.min(...readings), 2) : null,
        beverageG: finite(bev) && bev > 0 ? round(bev, 1) : null,
        doseG: dose > 0 ? dose : null,
        eyPct: extractionYield(tds, bev, dose) || null,
        meanEcPerG: ec > 0 ? ec : null,
        ratio: ec > 0 ? round(tds / ec, 4) : null,
        portalOk: ec > 0 && (!s.analysisCache?.status || s.analysisCache.status === 'ok'),
        method: r.method === 'guided' ? 'guided' : 'typed',
        zeroWith: zeroKey(String(r.zeroWith || '')),
        zeroedAt: finite(Number(r.zeroedAt)) && Number(r.zeroedAt) > 0 ? Number(r.zeroedAt) : null,
        filtered: r.filtered === true,
        waterTdsPct: finite(Number(r.waterTdsPct)) && Number(r.waterTdsPct) > 0 ? round(Number(r.waterTdsPct), 2) : null,
        device: cleanNote(r.device).slice(0, 60),
        note: cleanNote(r.note),
      };
    })
    .sort((a, b) => b.at - a.at);
}

/**
 * The calibration each coffee has: one row per bean name with paired brews —
 * how many, the fitted k and its leave-one-out error, and when it was last
 * calibrated. `points` are the calibration points of every shot.
 */
export function coffeeCalibrations(points, rows, { minShots } = {}) {
  const byKey = new Map();
  for (const p of points || []) {
    const key = p.coffeeKey || '';
    if (!byKey.has(key)) byKey.set(key, { coffeeKey: key, name: p.beanName || '', points: [] });
    byKey.get(key).points.push(p);
  }
  const last = new Map();
  for (const r of rows || []) {
    const key = String(r.bean || '').normalize('NFC').trim().toLocaleLowerCase();
    if (!last.has(key) || r.at > last.get(key)) last.set(key, r.at);
  }
  return [...byKey.values()]
    .map((c) => {
      const fit = fitForCoffee(c.points, { coffeeKey: c.coffeeKey }, 'bean', { minShots });
      return { coffeeKey: c.coffeeKey, name: c.name || '(no bean name)', readings: c.points.length, ...fitNumbers(fit), minX: fit.calibrated ? round(fit.minX, 3) : null, maxX: fit.calibrated ? round(fit.maxX, 3) : null, lastAt: last.get(c.coffeeKey) || null };
    })
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}
