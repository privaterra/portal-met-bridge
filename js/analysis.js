// analysis.js — pure, dependency-free analysis of a Belka Portal EC curve paired
// with a Meticulous cup-weight curve. Works in the browser and in Node.
//
// Physical guardrails
// -------------------
// The Portal reports electrical conductivity (EC) of the liquid passing through
// it, not refractive index. EC is a concentration proxy, so the primary result
// here is the mass-weighted integral  ∫ EC(m) dm  over cumulative cup mass and
// its normalisation  meanEcPerG = ∫EC dm / covered mass.  Nothing in this file
// turns EC into a TDS% unless the caller supplies a calibration fitted from
// paired refractometer readings for the same coffee, water and mounting.
//
// Conventions: time in seconds from shot start, mass in grams, EC in the
// Portal's own units (mS/cm presumed).

export const DEFAULTS = Object.freeze({
  gapSplitSec: 1.0,        // a pause longer than this between Portal samples is a gap
  boundaryClampSec: 0.5,   // evaluate EC this far past a segment edge before giving up
  activePeakMinMassG: 2.0, // ignore the first drops when locating the main peak
  minTotalMassG: 5.0,
  minCoverageRatio: 0.85,
  tailWindowsG: [2, 5],
  firstDropEc: 0.05,       // EC above this counts as coffee, not water
  firstDropMassG: 0.3,
  minCalibrationShots: 5,
});

// ---------------------------------------------------------------- segments --

/** Split Portal samples into continuous segments at gaps. */
export function buildSegments(samples, gapSplitSec = DEFAULTS.gapSplitSec) {
  const clean = samples
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.ec))
    .sort((a, b) => a.t - b.t);
  const segments = [];
  let current = null;
  for (const s of clean) {
    if (!current || s.t - current[current.length - 1].t > gapSplitSec) {
      current = [];
      segments.push(current);
    }
    if (current.length && current[current.length - 1].t === s.t) {
      current[current.length - 1] = s; // last write wins on duplicate timestamps
    } else {
      current.push(s);
    }
  }
  return segments;
}

/** Linear interpolation of EC at time t within a segment; null in a gap. */
export function evalEcAt(segments, t, clampSec = DEFAULTS.boundaryClampSec) {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const first = seg[0];
    const last = seg[seg.length - 1];
    if (t < first.t - clampSec || t > last.t + clampSec) continue;
    if (t <= first.t) return { ec: first.ec, seg: i };
    if (t >= last.t) return { ec: last.ec, seg: i };
    // binary search for the bracketing pair
    let lo = 0;
    let hi = seg.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (seg[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = seg[lo];
    const b = seg[hi];
    const alpha = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
    return { ec: a.ec + alpha * (b.ec - a.ec), seg: i };
  }
  return null;
}

// ------------------------------------------------------------ weight curve --

/** Monotone (running-max) cumulative cup mass, deduplicated by time. */
export function cleanWeightCurve(weightSamples) {
  const pts = weightSamples
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.w))
    .sort((a, b) => a.t - b.t);
  const out = [];
  let runningMax = 0;
  for (const p of pts) {
    if (out.length && p.t === out[out.length - 1].t) continue;
    runningMax = Math.max(runningMax, p.w);
    out.push({ t: p.t, m: runningMax });
  }
  return out;
}

function massAtTime(curve, t) {
  if (!curve.length) return 0;
  if (t <= curve[0].t) return curve[0].m;
  if (t >= curve[curve.length - 1].t) return curve[curve.length - 1].m;
  let lo = 0;
  let hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = curve[lo];
  const b = curve[hi];
  const alpha = (t - a.t) / (b.t - a.t);
  return a.m + alpha * (b.m - a.m);
}

// ------------------------------------------------------------- the analysis --

/**
 * Mass-space analysis of one shot.
 * @param {Array<{t:number, ec:number, tOut?:number}>} portalSamples
 * @param {Array<{t:number, w:number}>} weightSamples   cup weight from the machine's scale
 * @param {object} opts  { doseG, lagSec, stopTimeSec, gapSplitSec }
 */
export function analyzeShot(portalSamples, weightSamples, opts = {}) {
  const o = { ...DEFAULTS, lagSec: 0, doseG: 0, stopTimeSec: 0, ...opts };
  const result = {
    status: 'ok',
    reasons: [],
    portalSampleCount: 0,
    gapCount: 0,
    totalMassG: 0,
    coveredMassG: 0,
    coverageRatio: 0,
    integralEcG: 0,
    activeIntegralEcG: 0,
    meanEcPerG: 0,
    doseNormalizedIntegral: 0,
    peakEc: 0,
    peakTimeSec: 0,
    mainPeakEc: 0,
    mainPeakMassG: 0,
    finalEc: 0,
    meanTempC: null,
    maxTempC: null,
    firstDropTimeSec: null,
    tail: {},
    massAt85PctG: 0,
    massAt90PctG: 0,
    curve: [], // [{m, ec, I}] for plotting EC vs mass and cumulative integral
  };

  const segments = buildSegments(portalSamples, o.gapSplitSec);
  const valid = segments.reduce((n, s) => n + s.length, 0);
  result.portalSampleCount = valid;
  result.gapCount = Math.max(0, segments.length - 1);

  if (valid >= 1) {
    let tempSum = 0;
    let tempN = 0;
    for (const seg of segments) {
      for (const s of seg) {
        if (s.ec > result.peakEc) {
          result.peakEc = s.ec;
          result.peakTimeSec = s.t;
        }
        if (Number.isFinite(s.tOut)) {
          tempSum += s.tOut;
          tempN++;
          result.maxTempC = result.maxTempC === null ? s.tOut : Math.max(result.maxTempC, s.tOut);
        }
      }
    }
    if (tempN) result.meanTempC = tempSum / tempN;
  }

  if (valid < 2) {
    result.status = 'no-portal-data';
    result.reasons.push('Fewer than two valid Portal samples.');
    return result;
  }

  const curve = cleanWeightCurve(weightSamples);
  if (curve.length < 2) {
    result.status = 'no-weight-data';
    result.reasons.push('Fewer than two weight samples from the machine scale.');
    return result;
  }
  result.totalMassG = curve[curve.length - 1].m;
  if (result.totalMassG < o.minTotalMassG) {
    result.status = 'insufficient-mass';
    result.reasons.push(`Only ${result.totalMassG.toFixed(1)} g reached the cup.`);
    return result;
  }

  // First drop: earliest time the scale shows mass or the Portal sees coffee.
  const firstByMass = curve.find((p) => p.m >= o.firstDropMassG);
  const firstByEc = segments.flat().find((s) => s.ec >= o.firstDropEc);
  const cands = [firstByMass?.t, firstByEc?.t].filter((x) => Number.isFinite(x));
  if (cands.length) result.firstDropTimeSec = Math.min(...cands);

  // Knots: every scale sample and every Portal sample (shifted by lag), in time
  // order, each carrying interpolated mass and EC so sparse scale packets do not
  // erase chemistry observed between them.
  const t0 = curve[0].t;
  const tEnd = curve[curve.length - 1].t;
  const times = new Set(curve.map((p) => p.t));
  for (const seg of segments) {
    for (const s of seg) {
      const tt = s.t - o.lagSec;
      if (tt > t0 && tt < tEnd) times.add(tt);
    }
  }
  if (o.stopTimeSec > t0 && o.stopTimeSec < tEnd) times.add(o.stopTimeSec);
  const knots = [...times].sort((a, b) => a - b).map((t) => {
    const e = evalEcAt(segments, t + o.lagSec, o.boundaryClampSec);
    return { t, m: massAtTime(curve, t), ec: e ? e.ec : null, seg: e ? e.seg : -1, I: 0 };
  });

  // Trapezoidal integration in cumulative-mass space, only across covered steps.
  let total = 0;
  let active = 0;
  let covered = 0;
  const hasStop = o.stopTimeSec > 0;
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1];
    const b = knots[i];
    const dm = b.m - a.m;
    if (dm > 0 && a.ec !== null && b.ec !== null && a.seg === b.seg) {
      const step = 0.5 * (a.ec + b.ec) * dm;
      total += step;
      covered += dm;
      if (!hasStop || b.t <= o.stopTimeSec) active += step;
    }
    b.I = total;
    b.covered = covered;
  }
  result.integralEcG = total;
  result.activeIntegralEcG = hasStop ? active : total;
  result.coveredMassG = covered;
  result.coverageRatio = result.totalMassG > 0 ? covered / result.totalMassG : 0;
  result.meanEcPerG = covered > 0 ? total / covered : 0;
  if (o.doseG > 0) result.doseNormalizedIntegral = total / o.doseG;
  result.finalEc = knots[knots.length - 1].ec ?? result.finalEc;

  // Main peak: ignore the first drops.
  for (const k of knots) {
    if (k.m >= o.activePeakMinMassG && k.ec !== null && k.ec > result.mainPeakEc) {
      result.mainPeakEc = k.ec;
      result.mainPeakMassG = k.m;
    }
  }
  if (result.mainPeakEc <= 0) result.mainPeakEc = result.peakEc;

  // Curve for plotting (drop duplicate masses so the x axis is monotone).
  const plot = [];
  for (const k of knots) {
    if (plot.length && k.m <= plot[plot.length - 1].m) continue;
    plot.push({ m: k.m, ec: k.ec, I: k.I, t: k.t });
  }
  result.curve = plot;

  // Mass at 85% / 90% of the integral.
  result.massAt85PctG = massAtIntegralFraction(knots, 0.85);
  result.massAt90PctG = massAtIntegralFraction(knots, 0.9);

  // Tail features over the final N grams.
  const mEnd = result.totalMassG;
  const iEnd = total;
  for (const win of o.tailWindowsG) {
    const iStart = integralAtMass(knots, mEnd - win);
    const mean = (iEnd - iStart) / win;
    const t = { mean, share: iEnd > 0 ? (iEnd - iStart) / iEnd : 0, ratioToPeak: result.mainPeakEc > 0 ? mean / result.mainPeakEc : 0 };
    if (win === 5) t.slopePerG = tailSlope(knots, mEnd - win, mEnd);
    result.tail[`last${win}g`] = t;
  }

  if (result.coverageRatio < o.minCoverageRatio) {
    result.status = 'low-coverage';
    result.reasons.push(`Portal covered ${(result.coverageRatio * 100).toFixed(0)}% of the cup mass; estimates need ≥ ${(o.minCoverageRatio * 100).toFixed(0)}%.`);
  }
  if (result.gapCount > 0) result.reasons.push(`${result.gapCount} gap${result.gapCount > 1 ? 's' : ''} in the Portal stream.`);
  return result;
}

function integralAtMass(knots, m) {
  if (m <= knots[0].m) return 0;
  for (let i = 1; i < knots.length; i++) {
    if (knots[i].m >= m) {
      const a = knots[i - 1];
      const b = knots[i];
      const dm = b.m - a.m;
      if (dm <= 0) return b.I;
      const alpha = (m - a.m) / dm;
      return a.I + alpha * (b.I - a.I);
    }
  }
  return knots[knots.length - 1].I;
}

function massAtIntegralFraction(knots, frac) {
  const target = knots[knots.length - 1].I * frac;
  if (target <= 0) return 0;
  for (let i = 1; i < knots.length; i++) {
    if (knots[i].I >= target) {
      const a = knots[i - 1];
      const b = knots[i];
      const dI = b.I - a.I;
      if (dI <= 0) return b.m;
      return a.m + ((target - a.I) / dI) * (b.m - a.m);
    }
  }
  return knots[knots.length - 1].m;
}

/** Least-squares slope dEC/dm over a mass window, sampled on a uniform grid. */
function tailSlope(knots, m0, m1, n = 51) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < n; i++) {
    const m = m0 + ((m1 - m0) * i) / (n - 1);
    const ec = ecAtMass(knots, m);
    if (ec === null) continue;
    xs.push(m);
    ys.push(ec);
  }
  if (xs.length < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

function ecAtMass(knots, m) {
  for (let i = 1; i < knots.length; i++) {
    if (knots[i].m >= m) {
      const a = knots[i - 1];
      const b = knots[i];
      if (a.ec === null || b.ec === null) return b.ec ?? a.ec ?? null;
      const dm = b.m - a.m;
      if (dm <= 0) return b.ec;
      const alpha = (m - a.m) / dm;
      return a.ec + alpha * (b.ec - a.ec);
    }
  }
  return knots[knots.length - 1].ec;
}

// -------------------------------------------------------------- calibration --

/**
 * Fit EC → TDS% from paired shots.
 * @param {Array<{id:string, meanEcPerG:number, tdsPct:number, reliable?:boolean, meanTempC?:number}>} points
 * @param {object} opts { excludeId, minShots }
 */
export function fitCalibration(points, opts = {}) {
  const minShots = opts.minShots ?? DEFAULTS.minCalibrationShots;
  const usable = points.filter(
    (p) => p.id !== opts.excludeId && Number.isFinite(p.meanEcPerG) && p.meanEcPerG > 0 && Number.isFinite(p.tdsPct) && p.tdsPct > 0 && p.reliable !== false,
  );
  const fit = {
    calibrated: false,
    activeModel: 'none',
    shotCount: usable.length,
    excludedCount: points.length - usable.length - (points.some((p) => p.id === opts.excludeId) ? 1 : 0),
    preliminary: usable.length < minShots,
    minX: usable.length ? Math.min(...usable.map((p) => p.meanEcPerG)) : 0,
    maxX: usable.length ? Math.max(...usable.map((p) => p.meanEcPerG)) : 0,
    proportional: null,
    affine: null,
    tempCorrelation: null,
  };
  if (usable.length < 1) return fit;

  const xs = usable.map((p) => p.meanEcPerG);
  const ys = usable.map((p) => p.tdsPct);

  // Model 1: TDS = k · x  (through the origin: pure water has no EC and no TDS)
  const k = dot(xs, xs) > 0 ? dot(xs, ys) / dot(xs, xs) : 0;
  fit.proportional = { k, ...errors(xs, ys, (x) => k * x), ...loocv(xs, ys, fitProportional) };

  // Model 2: TDS = a · x + b. An intercept is only identifiable once there are
  // enough points spread over a real range of EC; a cluster of near-identical
  // shots would fit a wild slope through noise.
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const spreadOk = fit.maxX - fit.minX > 0.08 * meanX;
  if (usable.length >= minShots && spreadOk) {
    const { a, b } = fitAffine(xs, ys);
    fit.affine = { a, b, ...errors(xs, ys, (x) => a * x + b), ...loocv(xs, ys, fitAffine) };
  }

  // Temperature diagnostics: does the residual drift with outlet temperature?
  const temps = usable.map((p) => p.meanTempC).filter((t) => Number.isFinite(t));
  if (temps.length === usable.length && usable.length >= minShots) {
    const resid = xs.map((x, i) => ys[i] - k * x);
    fit.tempCorrelation = pearson(temps, resid);
  }

  fit.calibrated = true;
  // Prefer the affine model only when it clearly wins out-of-sample and has
  // enough points to earn its extra parameter.
  if (fit.affine && usable.length >= minShots && fit.affine.loocvRmse < 0.9 * fit.proportional.loocvRmse) {
    fit.activeModel = 'affine';
  } else {
    fit.activeModel = 'proportional';
  }
  return fit;
}

export function predictTds(fit, meanEcPerG) {
  if (!fit || !fit.calibrated || !Number.isFinite(meanEcPerG)) return null;
  if (fit.activeModel === 'affine' && fit.affine) return fit.affine.a * meanEcPerG + fit.affine.b;
  if (fit.proportional) return fit.proportional.k * meanEcPerG;
  return null;
}

/** Extraction yield from TDS%, beverage mass and dose. */
/**
 * The beverage mass to use for yield, EY and the hand-off: what the user
 * weighed by hand when they entered it (`shot.beverageG`, editable for any saved
 * shot), else the cup weight the machine's scale reported during the shot.
 */
export function beverageOf(shot) {
  if (!shot) return null;
  if (Number.isFinite(shot.beverageG) && shot.beverageG > 0) return shot.beverageG;
  if (Number.isFinite(shot.refractometer?.beverageG) && shot.refractometer.beverageG > 0) return shot.refractometer.beverageG;
  return Number.isFinite(shot.finalWeightG) ? shot.finalWeightG : null;
}

/** True when the user's weighed value differs from what the machine saw. */
export function beverageOverridden(shot) {
  const b = beverageOf(shot);
  return Number.isFinite(shot?.beverageG) && shot.beverageG > 0 && Number.isFinite(shot.finalWeightG) && Math.abs(b - shot.finalWeightG) >= 0.05;
}

export function extractionYield(tdsPct, beverageG, doseG) {
  if (![tdsPct, beverageG, doseG].every(Number.isFinite) || doseG <= 0) return null;
  return (tdsPct * beverageG) / doseG;
}

/** Combine analysis + fit into an estimate with explicit uncertainty flags. */
export function estimateForShot(analysis, fit, { beverageG, doseG, poolLabel } = {}) {
  const flags = [];
  if (!analysis || !(analysis.meanEcPerG > 0) || ['no-portal-data', 'no-weight-data', 'insufficient-mass'].includes(analysis.status)) {
    return { tdsPct: null, eyPct: null, flags: ['No usable Portal + weight data in this shot, so nothing to estimate from.'] };
  }
  if (!fit || !fit.calibrated) {
    return { tdsPct: null, eyPct: null, flags: [poolLabel ? `No refractometer readings yet for ${poolLabel}.` : 'No refractometer calibration yet for this coffee.'] };
  }
  if (analysis.status !== 'ok') flags.push('Shot analysis is not reliable (' + analysis.status + ').');
  if (fit.preliminary) flags.push(`Preliminary: only ${fit.shotCount} reference shot${fit.shotCount === 1 ? '' : 's'} (need ${DEFAULTS.minCalibrationShots}).`);
  const x = analysis.meanEcPerG;
  if (fit.shotCount >= 2 && (x < fit.minX * 0.95 || x > fit.maxX * 1.05)) flags.push('Outside the EC range of the reference shots (extrapolated).');
  const tdsPct = predictTds(fit, x);
  const eyPct = extractionYield(tdsPct, beverageG ?? analysis.totalMassG, doseG);
  return { tdsPct, eyPct, flags, model: fit.activeModel, pool: fit.pool ?? null, poolLabel: fit.poolLabel ?? poolLabel ?? null };
}

// ------------------------------------------------------- calibration pools --

/**
 * Which reference shots may inform an estimate for a given coffee.
 * Pools are ordered from most to least specific. "auto" takes the most
 * specific pool that has reached the minimum shot count, else the most
 * specific one with any shots at all (flagged preliminary).
 */
export const POOLS = Object.freeze([
  { id: 'bean', label: 'this bean only', match: (p, c) => !!c.coffeeKey && p.coffeeKey === c.coffeeKey },
  { id: 'roaster', label: 'the same roaster', match: (p, c) => !!c.roasterKey && p.roasterKey === c.roasterKey },
  { id: 'roast', label: 'the same roast level', match: (p, c) => !!c.roastLevel && p.roastLevel === c.roastLevel },
  { id: 'all', label: 'all my coffees', match: () => true },
]);

/**
 * @param {Array} points   calibration points carrying coffeeKey/roasterKey/roastLevel
 * @param {object} coffee  { coffeeKey, roasterKey, roastLevel } of the shot being estimated
 * @param {string} mode    'auto' | 'bean' | 'roaster' | 'roast' | 'all'
 * @param {object} opts    { excludeId, minShots }
 * @returns fit with .pool, .poolLabel, .poolPoints, .distinctCoffees, .fallbackFrom
 */
export function fitForCoffee(points, coffee, mode = 'auto', opts = {}) {
  const minShots = opts.minShots ?? DEFAULTS.minCalibrationShots;
  const c = coffee || {};
  const candidates = mode === 'auto' ? POOLS : POOLS.filter((p) => p.id === mode);
  const fits = candidates.map((pool) => {
    const pts = points.filter((p) => p.id !== opts.excludeId && pool.match(p, c));
    const fit = fitCalibration(pts, opts);
    fit.pool = pool.id;
    fit.poolLabel = pool.label;
    fit.poolPoints = pts;
    fit.distinctCoffees = new Set(pts.map((p) => p.coffeeKey || '')).size;
    return fit;
  });
  let chosen = fits.find((f) => f.shotCount >= minShots) || fits.find((f) => f.shotCount > 0) || fits[fits.length - 1];
  if (!chosen) {
    chosen = fitCalibration([], opts);
    chosen.pool = mode === 'auto' ? 'bean' : mode;
    chosen.poolLabel = (POOLS.find((p) => p.id === chosen.pool) || POOLS[0]).label;
    chosen.poolPoints = [];
    chosen.distinctCoffees = 0;
  }
  chosen.fallbackFrom = mode === 'auto' && chosen.pool !== 'bean' ? 'bean' : null;
  chosen.mode = mode;
  return chosen;
}

// ------------------------------------------------------------------ helpers --

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function fitProportional(xs, ys) {
  const k = dot(xs, xs) > 0 ? dot(xs, ys) / dot(xs, xs) : 0;
  return (x) => k * x;
}

function fitAffine(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const a = den > 0 ? num / den : 0;
  const b = my - a * mx;
  const f = (x) => a * x + b;
  f.a = a;
  f.b = b;
  return Object.assign(f, { a, b });
}

function errors(xs, ys, f) {
  let se = 0;
  let ae = 0;
  let bias = 0;
  for (let i = 0; i < xs.length; i++) {
    const r = f(xs[i]) - ys[i];
    se += r * r;
    ae += Math.abs(r);
    bias += r;
  }
  const n = xs.length || 1;
  return { rmse: Math.sqrt(se / n), mae: ae / n, bias: bias / n };
}

function loocv(xs, ys, fitter) {
  if (xs.length < 2) return { loocvRmse: Infinity, loocvMae: Infinity };
  let se = 0;
  let ae = 0;
  for (let i = 0; i < xs.length; i++) {
    const trX = xs.filter((_, j) => j !== i);
    const trY = ys.filter((_, j) => j !== i);
    const f = fitter(trX, trY);
    const r = f(xs[i]) - ys[i];
    se += r * r;
    ae += Math.abs(r);
  }
  return { loocvRmse: Math.sqrt(se / xs.length), loocvMae: ae / xs.length };
}

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Downsample a series to at most n points, keeping first and last. */
export function downsample(series, n) {
  if (series.length <= n) return series.slice();
  const out = [];
  const step = (series.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(series[Math.round(i * step)]);
  return out;
}
