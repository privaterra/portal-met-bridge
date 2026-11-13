// AI shot review: everything that can be computed locally is computed here,
// deterministically, so the model is asked to interpret numbers rather than
// to derive them. Pure functions — no DOM, no network — so they are unit-tested.
//
//   buildShotDigest(shot, analysis)  → the per-stage story of one shot
//   buildReviewMessages(...)         → { system, user } for any provider
//   renderMarkdown(md)               → safe HTML for the report pane

import { beverageOf, beverageSource, profileTargetOf, profileFinalWeight, measuredEy, grindMicrons } from './analysis.js?v=0.19.0';

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

/** Stage names the machine reports that are not brewing stages. */
const NON_STAGES = /^(idle|click to start|starting|heating|preinfusion done|ready|done|retracting|closing valve|purge)/i;

/**
 * Split the machine samples into stages using the status name the machine
 * sends with every sample. Consecutive samples with the same name form one
 * stage; a name that repeats later (rare) becomes a second stage of that name.
 */
export function splitStages(machine) {
  const out = [];
  let cur = null;
  for (const s of machine || []) {
    if (!Number.isFinite(s.t)) continue;
    const name = String(s.status || '').trim();
    if (!name || NON_STAGES.test(name)) {
      if (cur && /retract|done|closing/i.test(name)) cur.pumpStopT = cur.pumpStopT ?? s.t;
      continue;
    }
    if (!cur || cur.name !== name) {
      cur = { name, samples: [] };
      out.push(cur);
    }
    cur.samples.push(s);
  }
  return out;
}

/** Value of `key` at time t from a sorted sample array (last sample at or before t). */
export function valueAt(samples, t, key) {
  let best = null;
  for (const s of samples) {
    if (s.t <= t + 1e-9) best = s;
    else break;
  }
  return best ? best[key] : null;
}

/** Cumulative water (ml) from the machine's flow trace, trapezoid-free (flow × dt, like the hand-off). */
export function cumulativeWater(machine) {
  const out = [];
  let acc = 0;
  let last = null;
  for (const s of machine) {
    if (!Number.isFinite(s.t)) continue;
    if (last !== null) acc += Math.max(0, s.f ?? 0) * Math.max(0, s.t - last);
    last = s.t;
    out.push({ t: s.t, ml: acc });
  }
  return out;
}

function slope(points) {
  const n = points.length;
  if (n < 3) return null;
  const mt = points.reduce((a, p) => a + p[0], 0) / n;
  const mv = points.reduce((a, p) => a + p[1], 0) / n;
  const den = points.reduce((a, p) => a + (p[0] - mt) ** 2, 0);
  return den > 0 ? points.reduce((a, p) => a + (p[0] - mt) * (p[1] - mv), 0) / den : null;
}

/** Integral of EC over mass up to `mass`, from the analysis curve. */
function integralAtMass(curve, mass) {
  let best = null;
  for (const q of curve) {
    if (q.m <= mass + 1e-9) best = q;
    else break;
  }
  return best ? best.I : 0;
}

/**
 * The per-stage story of one shot, with the Portal's EC folded in when present.
 * `analysis` is the result of analyzeShot() (may be null or a machine-only result).
 */
/** The profile a review should read: the one the user chose for this shot, else the machine's record of what was brewed. */
export function reviewProfileOf(shot) {
  return shot?.reviewProfile || shot?.machineSource?.profile || null;
}

export function buildShotDigest(shot, analysis, { profileTargetG, profile = reviewProfileOf(shot) } = {}) {
  const machine = (shot.machine || []).filter((s) => Number.isFinite(s.t)).slice().sort((a, b) => a.t - b.t);
  const portal = (shot.portal || []).filter((s) => Number.isFinite(s.t) && Number.isFinite(s.ec)).slice().sort((a, b) => a.t - b.t);
  const lag = Number.isFinite(shot.lagSec) ? shot.lagSec : 0;
  const portalShifted = portal.map((p) => ({ ...p, t: p.t + lag }));
  const hasPortal = portalShifted.length >= 10;
  const water = cumulativeWater(machine);
  const waterAt = (t) => valueAt(water, t, 'ml') ?? 0;
  const c = shot.context || {};
  const gaps = [];

  // ---- metadata
  const dose = Number(c.doseG) > 0 ? Number(c.doseG) : null;
  const beverage = beverageOf(shot);
  const target = Number(profileTargetG) > 0 ? Number(profileTargetG) : profile ? profileFinalWeight(profile) ?? profileTargetOf(shot) : profileTargetOf(shot);
  const recorded = shot.machineSource?.profile || null;
  const meta = {
    id: shot.id,
    startedAt: shot.startedAt ? new Date(shot.startedAt).toISOString() : null,
    profile: profile?.name || shot.profileName || null,
    profileChoice: shot.reviewProfile ? 'chosen by the user for this review' : recorded ? "as recorded by the machine for this shot" : 'name only (no record attached)',
    recordedProfile: shot.reviewProfile && recorded ? { name: recorded.name || null, finalWeightG: profileFinalWeight(recorded), temperatureC: Number(recorded.temperature) || null } : undefined,
    profileTargetG: target ?? null,
    profileTemperatureC: Number(profile?.temperature) > 0 ? Number(profile.temperature) : Number.isFinite(shot.profileTemperatureC) ? shot.profileTemperatureC : null,
    profileVariables: Array.isArray(profile?.variables) ? profile.variables.filter((v) => v && v.key).map((v) => ({ name: v.name ?? v.key, key: v.key, type: v.type ?? null, value: v.value })) : [],
    profileStages: Array.isArray(profile?.stages) ? profile.stages.map((s) => s?.name).filter(Boolean) : [],
    coffee: { bean: c.beanName || null, roaster: c.roaster || null, origin: c.origin || null, process: c.process || null, roastLevel: c.roastLevel || null },
    grinder: c.grinderName || null,
    grindUm: grindMicrons(c),
    doseG: dose,
    beverageG: r1(beverage),
    beverageSource: beverageSource(shot),
    weighedG: Number(shot.beverageG) > 0 ? r1(shot.beverageG) : null,
    scaleFinalG: r1(shot.finalWeightG),
    beverageNote: beverageNoteFor(shot, beverage, target),
    ratio: dose && beverage > 0 ? r2(beverage / dose) : null,
    durationSec: r1(shot.durationSec),
    note: c.note || null,
    rating: ratingOf(shot),
    ratingMax: ratingOf(shot) ? ratingMaxOf(shot) : null,
    comment: typeof shot.comment === 'string' && shot.comment.trim() ? shot.comment.trim() : null,
    refractometerTdsPct: Number(shot.refractometer?.tdsPct) > 0 ? shot.refractometer.tdsPct : null,
    measuredEyPct: r2(measuredEy(shot)),
    machineRecordAttached: !!shot.machineShotId,
    source: shot.source || null,
  };
  if (!dose) gaps.push('No dose recorded, so ratio and EY cannot be computed.');
  if (!(beverage > 0)) gaps.push('The final weight of this brew is not known (not typed yet, and no stand-in is configured), so yield, ratio and EY cannot be computed.');
  if (shot._targetAmbiguous && !(target > 0)) gaps.push('Two profiles on the machine share this name with different target weights and the machine\'s record is not attached, so the profile target is unknown.');
  if (!meta.grindUm) gaps.push('No grind size recorded.');
  if (!machine.length) gaps.push('No machine samples (pressure, flow, cup weight) — the Meticulous was not connected for this shot.');
  if (!hasPortal) gaps.push('No Belka Portal data for this shot: nothing is known about conductivity, so the review is based on the machine\'s pressure, flow, weight and temperature only.');
  if (machine.length && !machine.some((s) => Number.isFinite(s.temp) && s.temp > 0)) gaps.push('No water temperature in the machine samples.');
  if (!meta.machineRecordAttached && machine.length) gaps.push("Live samples only; the machine's own record was not attached (stage names may be approximate).");

  // ---- stages
  const stageList = splitStages(machine);
  const pumpStop = (() => {
    // last sample with flow above 0.1 ml/s, or the first retracting sample
    for (const st of stageList) if (st.pumpStopT) return st.pumpStopT;
    for (let i = machine.length - 1; i >= 0; i--) if ((machine[i].f ?? 0) > 0.1) return machine[i].t;
    return machine.length ? machine[machine.length - 1].t : null;
  })();
  const ecAt = (t) => (hasPortal ? valueAt(portalShifted, t, 'ec') : null);
  const stages = stageList.map((st) => {
    const xs = st.samples;
    const t0 = xs[0].t;
    const t1 = xs[xs.length - 1].t;
    const w0 = xs[0].w ?? 0;
    const w1 = xs[xs.length - 1].w ?? 0;
    const temps = xs.map((x) => x.temp).filter((v) => Number.isFinite(v) && v > 0);
    const flows = xs.map((x) => x.f).filter((v) => Number.isFinite(v));
    const press = xs.map((x) => x.p).filter((v) => Number.isFinite(v));
    const pMaxIdx = press.length ? xs.reduce((bi, x, i) => ((x.p ?? -1) > (xs[bi].p ?? -1) ? i : bi), 0) : -1;
    const stage = {
      name: st.name,
      fromSec: r1(t0),
      toSec: r1(t1),
      durationSec: r1(t1 - t0),
      waterInMl: r1(waterAt(t1) - waterAt(t0)),
      cupStartG: r1(w0),
      cupEndG: r1(w1),
      cupGainG: r1(w1 - w0),
      cupRateGPerS: t1 > t0 ? r2((w1 - w0) / (t1 - t0)) : null,
      pressureStartBar: r2(press[0]),
      pressureMaxBar: press.length ? r2(Math.max(...press)) : null,
      pressureMaxAtSec: pMaxIdx >= 0 ? r1(xs[pMaxIdx].t) : null,
      pressureEndBar: r2(press[press.length - 1]),
      pressureSlopeBarPerS: r3(slope(xs.filter((x) => Number.isFinite(x.p)).map((x) => [x.t, x.p]))),
      flowMeanMlPerS: flows.length ? r2(flows.reduce((a, b) => a + b, 0) / flows.length) : null,
      flowMaxMlPerS: flows.length ? r2(Math.max(...flows)) : null,
      tempStartC: temps.length ? r1(temps[0]) : null,
      tempEndC: temps.length ? r1(temps[temps.length - 1]) : null,
      ecStart: r2(ecAt(t0)),
      ecEnd: r2(ecAt(t1)),
    };
    const setpoints = xs.map((x) => x.setpoint).filter((v) => Number.isFinite(v));
    if (setpoints.length) stage.setpointMean = r2(setpoints.reduce((a, b) => a + b, 0) / setpoints.length);
    return stage;
  });

  // ---- first drop, pump stop, drips
  const firstDrop = (() => {
    for (const s of machine) if ((s.w ?? 0) >= 0.5) return s.t;
    return null;
  })();
  const last = machine[machine.length - 1];
  const timeline = {
    firstDropSec: r1(firstDrop),
    pumpStopSec: r1(pumpStop),
    cupAtPumpStopG: r1(pumpStop != null ? valueAt(machine, pumpStop, 'w') : null),
    lastSampleSec: r1(last?.t),
    cupAtEndG: r1(last?.w),
    dripsAfterPumpG: r1(last && pumpStop != null ? (last.w ?? 0) - (valueAt(machine, pumpStop, 'w') ?? 0) : null),
    totalWaterMl: r1(water.length ? water[water.length - 1].ml : null),
    waterBeforeFirstDropMl: r1(firstDrop != null ? waterAt(firstDrop) : null),
  };

  // ---- temperature
  const temps = machine.map((x) => x.temp).filter((v) => Number.isFinite(v) && v > 0);
  const temperature = temps.length
    ? { startC: r1(temps[0]), minC: r1(Math.min(...temps)), maxC: r1(Math.max(...temps)), endC: r1(temps[temps.length - 1]), setpointC: meta.profileTemperatureC }
    : null;

  // ---- Portal / EC
  let ec = null;
  if (hasPortal && analysis && analysis.curve?.length) {
    const tot = analysis.integralEcG || 0;
    const share = (mass) => (tot > 0 ? Math.round((100 * integralAtMass(analysis.curve, mass)) / tot) : null);
    const byStage = stages.map((st) => ({ stage: st.name, solublesPctByEnd: share(st.cupEndG ?? 0) }));
    const milestones = {};
    for (const m of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]) if (analysis.totalMassG >= m) milestones[`${m}g`] = share(m);
    ec = {
      samples: portal.length,
      lagAppliedSec: lag,
      meanEcPerG: r3(analysis.meanEcPerG),
      integralEcG: r1(analysis.integralEcG),
      peakEc: r2(analysis.mainPeakEc || analysis.peakEc),
      peakAtSec: r1(analysis.peakTimeSec),
      peakAtCupG: r1(analysis.mainPeakMassG),
      finalEc: r2(analysis.finalEc),
      coveragePct: Math.round((analysis.coverageRatio || 0) * 100),
      massAt90PctOfIntegralG: r1(analysis.massAt90PctG),
      tailLast5g: analysis.tail?.last5g ? { meanEc: r2(analysis.tail.last5g.mean), sharePct: Math.round((analysis.tail.last5g.share || 0) * 100), ratioToPeakPct: Math.round((analysis.tail.last5g.ratioToPeak || 0) * 100) } : null,
      outletTempC: (() => {
        const t = portal.map((p) => p.tOut).filter((v) => Number.isFinite(v));
        return t.length ? { startC: r1(t[0]), maxC: r1(Math.max(...t)), endC: r1(t[t.length - 1]) } : null;
      })(),
      solublesShareByStageEnd: byStage,
      solublesShareAtCupMass: milestones,
      analysisStatus: analysis.status,
      analysisNotes: analysis.reasons || [],
    };
    if (analysis.coverageRatio < 0.85) gaps.push(`The Portal covered only ${ec.coveragePct}% of the cup mass; EC-based shares are approximate.`);
  } else if (hasPortal) {
    ec = { samples: portal.length, note: 'Portal samples present but no cup-weight curve to pair them with.' };
  }

  // ---- resampled series for the model (1 s) — pressure, flow, cup, temp, EC
  const end = last ? Math.ceil(last.t) : 0;
  const series = [];
  for (let t = 0; t <= end; t += 1) {
    series.push([
      t,
      r2(valueAt(machine, t, 'p')),
      r2(valueAt(machine, t, 'f')),
      r1(valueAt(machine, t, 'w')),
      r1(valueAt(machine, t, 'temp')),
      hasPortal && (firstDrop == null || t >= Math.floor(firstDrop)) ? r1(valueAt(portalShifted, t, 'ec')) : null,
    ]);
  }

  return { meta, gaps, stages, timeline, temperature, ec, hasPortal, series, seriesColumns: ['t_s', 'pressure_bar', 'flow_ml_s', 'cup_g', 'water_temp_c', 'portal_ec_ms_cm'] };
}

/** One sentence that says which weight is the cup and which is only the profile's aim — the model must not confuse them. */
/** The scale a shot was rated on: 5 (default) or 9 stars. */
export function ratingMaxOf(shot) {
  return Number(shot?.ratingMax) === 9 ? 9 : 5;
}
/** The user's star rating of a shot (1 … ratingMaxOf(shot)), or null when it has none. */
export function ratingOf(shot) {
  const r = Number(shot?.rating);
  return Number.isInteger(r) && r >= 1 && r <= ratingMaxOf(shot) ? r : null;
}

export function beverageNoteFor(shot, beverage, target) {
  const src = beverageSource(shot);
  const scale = Number.isFinite(shot?.finalWeightG) && shot.finalWeightG > 0 ? `${r1(shot.finalWeightG)} g` : 'nothing';
  const tgt = target > 0 ? `${r1(target)} g` : 'unknown';
  if (src === 'weighed') return `The cup was weighed by hand after the brew: ${r1(beverage)} g. This is the measured yield and the authoritative beverage weight. The profile's target was ${tgt}; the machine's scale read ${scale} during the recording.`;
  if (src === 'profile') return `No hand weighing: the beverage is taken as the profile's target output weight, ${r1(beverage)} g (the machine stops the pump there; the cup ends up at about that plus drips). The machine's scale read ${scale} during the recording.`;
  if (src === 'scale') return `No hand weighing: the beverage is the machine's scale reading at the end of the recording, ${r1(beverage)} g. The profile's target was ${tgt}.`;
  return `The final weight of this brew is not known. The profile's target was ${tgt}; the machine's scale read ${scale} during the recording. Do not present either as the measured yield.`;
}

/** A compact, model-friendly copy of a Meticulous profile (no image, no ids). */
export function compactProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const out = {
    name: profile.name ?? null,
    temperatureC: profile.temperature ?? null,
    finalWeightG: profile.final_weight ?? null,
    description: profile.display?.description || profile.description || null,
    variables: Array.isArray(profile.variables) ? profile.variables.map((v) => ({ name: v.name, key: v.key, type: v.type, value: v.value })) : [],
    stages: Array.isArray(profile.stages)
      ? profile.stages.map((s) => ({
          name: s.name,
          key: s.key,
          type: s.type,
          dynamics: s.dynamics ? { over: s.dynamics.over, interpolation: s.dynamics.interpolation, points: s.dynamics.points } : null,
          exitTriggers: Array.isArray(s.exit_triggers) ? s.exit_triggers.map((e) => ({ type: e.type, value: e.value, relative: e.relative, comparison: e.comparison })) : [],
          limits: Array.isArray(s.limits) ? s.limits.map((l) => ({ type: l.type, value: l.value })) : [],
        }))
      : [],
  };
  return out;
}

export const REVIEW_METHOD = `Work the way an experienced Meticulous user reviews a shot, in this order:
1. Read the setup: the coffee (roaster, origin, process, roast level and what that implies for solubility, CO2 and the flavours to protect), the grinder and grind size, the dose, and the brewed profile — its stages, what each stage's dynamics command (flow or pressure, over time or over weight), the exit triggers and limits, the variables, and what the profile's own description says it is trying to do.
2. Go through the shot stage by stage with the numbers given (time span, water in, cup weight, pressure start/peak/end and slope, mean flow, temperature start/end, EC at the boundaries) and say for each stage what actually happened against what the stage was designed to do: did it exit on its trigger or on its time limit, did pressure or flow reach the target, how much drained into the cup.
3. Locate where the extraction happened: when the Portal data is present use the share of the EC integral (∫EC dm) by stage end and by cup mass, the EC peak and where it fell, and the tail; without Portal data use cup weight gain per stage and the flow/pressure history, and say plainly that concentration is unknown.
4. Check the records against each other: the profile's target weight against what the scale read at pump stop and after drips; the setpoint temperature against the recorded water temperature; the grind logged against anything the user says; the dose against the profile's description. Name every discrepancy and give the most likely cause, marking hypotheses you cannot confirm as unconfirmed.
5. Judge the shot: is the trace clean (no spikes or dips that suggest channeling), did it stop short or run long, was pressure in the range the profile aims for, did the bloom rest or drain, how much heat was lost.
6. Only then recommend changes, ordered by expected effect, one change per shot, with the exact profile variable or stage parameter to edit and the value to set, and grind moves in the grinder's step size. Say what each change should do to the next trace so it can be checked.
When several shots are given, treat them as a series: build the comparison table first, say what changed between them (grind, dose, profile, temperature) and what that did to pressure, time, yield and EC, then review the latest shot in the detail above and base the recommendations on the whole series.`;

export const REVIEW_TEMPLATE = `Write the report in Markdown with exactly these sections, in this order (use "##" headings; no top-level title, the app adds it):

## Verdict
Two or three sentences: is the trace clean, and is this the shot the profile describes? Then a short bullet list of the headline numbers (yield and ratio against the target, extraction pressure against the profile's aim, where the solubles came from or, without Portal data, how the cup filled). End with one line "Setup: …" naming machine, profile and setpoint, grinder and grind, coffee.

## Shots compared
(Only when more than one shot is given.) A table with one row per shot: date, grind (µm), dose → beverage, ratio, time, peak extraction pressure, mean EC/g (or "–"), TDS/EY if known. Then a short paragraph on what changed between them and what it did.

## Stages
A table: Stage | Time | Water in | Cup | What happened — one row per stage, plus a final "Drips" row from pump stop to the last sample. Below the table, one sentence on where the solubles came from (share of ∫EC dm by end of each stage and at cup-mass milestones) when Portal data is present, otherwise one sentence on how the cup filled by stage.

## What stands out
A numbered list (1., 2., 3. — consecutive, never "1." on every item) of the findings that matter, most important first (stopped short / ran long, pressure, bloom behaviour, temperature drift, data inconsistencies). Use sub-bullets for checks the user should make and for hypotheses, labelled "Unconfirmed:" when they are.

## Suggested changes
First a sub-heading "### Stage by stage" with one bullet per stage of the profile, in the order the machine ran them (the digest's stages list; every stage, none skipped): "**<stage name>** (<start>–<end> s): what happened — <verdict> — <what to change, or keep>". "What happened" quotes the stage's own numbers (duration, pressure or flow, weight gained, EC where the Portal covered it, temperature when recorded); the verdict is exactly one of "worked well", "acceptable" or "needs work"; the last part names the parameter and value to change in that stage, or says "keep as is". Then a sub-heading "### One change per shot", starting with "Change one thing per shot, in this order." and a numbered list (1., 2., 3. — consecutive). Each item names the exact variable or stage parameter (use the profile's own keys when they are given, e.g. bloom_time, extraction_flow, saturation_pressure, the final weight, the temperature setpoint) and the value to set, or the grind move in whole steps of the grinder's step size, and says what to look for in the next trace. Respect how the user drinks the coffee (ratio targets differ for milk drinks and straight espresso).

## Open questions
Bullets: what you need to know to go further (taste, a second-scale weight, a refractometer reading, which profile version is loaded).

## Sources
Bullets listing only the data you were given: the shot ids/dates, the profile name and version, the coffee as recorded. Do not invent URLs or literature.

Rules: use the numbers from the digest and do not recompute or round them differently; never invent values that are not there — say "not recorded" instead; keep the tone plain and specific; write for the person who pulled the shot; do not describe the chart (the app shows it); do not add a title, preamble or closing remarks.
Weights: meta.beverageG is the cup — the yield to use for ratio and EY — and meta.beverageNote says where it came from (weighed by hand, the profile's target, or the scale). meta.profileTargetG is only what the profile aimed to stop at and meta.scaleFinalG only what the machine's scale read; quote them as such and never present either as the measured yield when a hand-weighed value exists. When the three disagree, say so and by how much.
Rating: meta.rating is the user's own star rating of the shot in the cup, out of meta.ratingMax (5 or 9; the top mark is best; null when not rated) and meta.comment their comment on it; treat both as the taste verdict for that shot, weigh the trace against them, and say so when the numbers and the rating disagree.`;

/** The report outline when several shots are reviewed together: every section compares. */
export const REVIEW_TEMPLATE_SERIES = `Write the report in Markdown with exactly these sections, in this order (use "##" headings; no top-level title, the app adds it). Several shots are given, in brewing order, and every section must compare them — never review only the last one.

## Verdict
Two or three sentences: did the shots get better from the first to the last, and which one came closest to what the profile describes? Then a short bullet list of the headline numbers of the latest shot against the best one (yield and ratio against the target, time, extraction pressure, mean EC/g or, without Portal data, how the cup filled). End with one line "Setup: …" naming what stayed fixed across the series (machine, profile and setpoint, grinder, coffee) and what was varied.

## Shots compared
A table with one row per shot in brewing order: # | date | grind (µm) | dose → beverage | ratio | time | peak extraction pressure | mean EC/g (or "–") | TDS/EY if known. Then a short paragraph on what the user changed between the shots (grind, dose, profile or its variables, temperature setpoint, target weight) and what stayed the same — taken from the comparison the app computed, not guessed.

## Stages
One table with a row per stage (in profile order, "Drips" last) and one column per shot — Stage | Shot 1 | Shot 2 | … | What differed — where each cell gives time span · water in · cup at the end (and the share of ∫EC dm by then when Portal data exists). Below it, a numbered list (1., 2., 3.) of how the stages differed between the shots: duration, exit on the trigger or on the time limit, peak pressure, mean flow, cup gain, where the solubles came from — and which stages were the same within noise. Say so when a stage exists in one shot and not in another.

## What stands out
A numbered list (1., 2., 3. — consecutive, never "1." on every item), in brewing order: one item per step between consecutive shots (1 → 2, 2 → 3, …) saying what was varied, what that did to pressure, time, yield, EC and taste when given, and a plain verdict — better, worse, or no clear change — with the numbers that say so. Then items on what varied without being changed on purpose (temperature, dose scatter, final weight) and on anything inconsistent in the records, with hypotheses labelled "Unconfirmed:". Finish with one item that begins "Trend:" — whether the shots improved in sequence, and what the best shot did that the others did not.

## What helped and what did not
Two short bullet lists — "Keep:" the changes the series shows helped, and "Revert or stop:" the ones that did not — each with the shot numbers as evidence; write "undecided" when one shot is not enough to tell.

## Suggested changes
First a sub-heading "### Stage by stage" with one bullet per stage of the profile, in the order the machine ran them (every stage that appears in the digests, none skipped): "**<stage name>**: what happened across the shots — <verdict> — <what to change, or keep>". "What happened" quotes the stage's numbers from the shots (duration, pressure or flow, weight gained, EC where the Portal covered it) and how they moved from shot to shot; the verdict is exactly one of "worked well", "acceptable" or "needs work" for the latest shot; the last part names the parameter and value to change in that stage, or says "keep as is". Then a sub-heading "### One change per shot", starting with "Change one thing per shot, in this order." and a numbered list (1., 2., 3. — consecutive) of single changes for the next shots, meant to improve on the latest shot and built on what the series showed. Each item names the exact variable or stage parameter (the profile's own keys when given, e.g. bloom_time, extraction_flow, saturation_pressure, the final weight, the temperature setpoint) and the value to set, or the grind move in whole steps of the grinder's step size; says why the series points to it (which shots showed what); and says what to look for in the next trace. Respect how the user drinks the coffee (ratio targets differ for milk drinks and straight espresso).

## Open questions
Bullets: what you need to know to go further (taste of each shot, a second-scale weight, a refractometer reading, which profile version was loaded for which shot).

## Sources
Bullets listing only the data you were given: the shot ids/dates in order, the profile name(s) and version, the coffee as recorded. Do not invent URLs or literature.

Rules: use the numbers from the digests and the app's comparison and do not recompute or round them differently; never invent values that are not there — say "not recorded" instead; keep the tone plain and specific; write for the person who pulled the shots; do not describe the charts (the app shows them); do not add a title, preamble or closing remarks.
Weights: meta.beverageG is the cup — the yield to use for ratio and EY — and meta.beverageNote says where it came from (weighed by hand, the profile's target, or the scale). meta.profileTargetG is only what the profile aimed to stop at and meta.scaleFinalG only what the machine's scale read; quote them as such and never present either as the measured yield when a hand-weighed value exists. When the three disagree, say so and by how much.
Rating: meta.rating is the user's own star rating of the shot in the cup, out of meta.ratingMax (5 or 9; the top mark is best; null when not rated) and meta.comment their comment on it; treat both as the taste verdict for that shot, weigh the trace against them, and say so when the numbers and the rating disagree.`;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null); // null stays null (never 0)
const delta = (a, b, digits = 2) => (a === null || b === null ? null : Math.round((b - a) * 10 ** digits) / 10 ** digits);

/**
 * What the app can say about a series before the model does: one row per shot
 * with the setup and outcome numbers, the differences between consecutive
 * shots, and every stage laid side by side by name. Null when fewer than two
 * shots are given. The model is told to compare from this, not to guess.
 */
export function buildSeriesComparison(digests) {
  if (!Array.isArray(digests) || digests.length < 2) return null;
  const peakPressure = (d) => {
    const ps = (d.stages || []).map((st) => num(st.pressureMaxBar)).filter((v) => v !== null);
    return ps.length ? Math.max(...ps) : null;
  };
  const variables = (d) => Object.fromEntries((d.meta?.profileVariables || []).map((v) => [v.key, v.value]));
  const shots = digests.map((d, i) => ({
    shot: i + 1,
    id: d.meta?.id ?? null,
    startedAt: d.meta?.startedAt ?? null,
    profile: d.meta?.profile ?? null,
    profileTargetG: num(d.meta?.profileTargetG),
    temperatureSetpointC: num(d.meta?.profileTemperatureC),
    variables: variables(d),
    grindUm: num(d.meta?.grindUm),
    doseG: num(d.meta?.doseG),
    beverageG: num(d.meta?.beverageG),
    beverageSource: d.meta?.beverageSource ?? null,
    ratio: num(d.meta?.ratio),
    durationSec: num(d.meta?.durationSec),
    firstDropSec: num(d.timeline?.firstDropSec),
    pumpStopSec: num(d.timeline?.pumpStopSec),
    dripsAfterPumpG: num(d.timeline?.dripsAfterPumpG),
    totalWaterMl: num(d.timeline?.totalWaterMl),
    peakPressureBar: peakPressure(d),
    waterTempStartC: num(d.temperature?.startC),
    waterTempEndC: num(d.temperature?.endC),
    meanEcPerG: num(d.ec?.meanEcPerG),
    integralEcG: num(d.ec?.integralEcG),
    peakEc: num(d.ec?.peakEc),
    peakAtCupG: num(d.ec?.peakAtCupG),
    tailLast5gRatioToPeakPct: num(d.ec?.tailLast5g?.ratioToPeakPct),
    refractometerTdsPct: num(d.meta?.refractometerTdsPct),
    measuredEyPct: num(d.meta?.measuredEyPct),
    rating: num(d.meta?.rating),
    ratingMax: num(d.meta?.ratingMax),
    comment: d.meta?.comment ?? null,
    portalData: !!d.ec && d.ec.meanEcPerG != null,
    stageNames: (d.stages || []).map((st) => st.name),
  }));
  const numericKeys = ['grindUm', 'doseG', 'beverageG', 'ratio', 'durationSec', 'firstDropSec', 'pumpStopSec', 'dripsAfterPumpG', 'totalWaterMl', 'peakPressureBar', 'waterTempStartC', 'waterTempEndC', 'meanEcPerG', 'integralEcG', 'peakEc', 'peakAtCupG', 'tailLast5gRatioToPeakPct', 'refractometerTdsPct', 'measuredEyPct', 'profileTargetG', 'temperatureSetpointC', 'rating'];
  const steps = shots.slice(1).map((b, i) => {
    const a = shots[i];
    const changes = {};
    for (const k of numericKeys) {
      const dv = delta(a[k], b[k]);
      if (dv !== null && dv !== 0) changes[k] = { from: a[k], to: b[k], delta: dv };
    }
    if (a.profile !== b.profile) changes.profile = { from: a.profile, to: b.profile };
    const varKeys = new Set([...Object.keys(a.variables), ...Object.keys(b.variables)]);
    for (const k of varKeys) if (JSON.stringify(a.variables[k]) !== JSON.stringify(b.variables[k])) changes[`variable:${k}`] = { from: a.variables[k] ?? null, to: b.variables[k] ?? null };
    if (a.beverageSource !== b.beverageSource) changes.beverageSource = { from: a.beverageSource, to: b.beverageSource };
    const setupChanged = ['grindUm', 'doseG', 'profile', 'temperatureSetpointC', 'profileTargetG'].filter((k) => k in changes).concat(Object.keys(changes).filter((k) => k.startsWith('variable:')));
    return { from: a.shot, to: b.shot, setupChanged, changes };
  });
  // stages side by side, by name, in order of first appearance
  const names = [];
  for (const d of digests) for (const st of d.stages || []) if (!names.includes(st.name)) names.push(st.name);
  const stages = names.map((name) => ({
    stage: name,
    perShot: digests.map((d, i) => {
      const st = (d.stages || []).find((x) => x.name === name);
      if (!st) return { shot: i + 1, present: false };
      const share = (d.ec?.solublesShareByStageEnd || []).find((x) => x.stage === name)?.solublesPctByEnd ?? null;
      return { shot: i + 1, present: true, fromSec: st.fromSec, toSec: st.toSec, durationSec: st.durationSec, waterInMl: st.waterInMl, cupEndG: st.cupEndG, cupGainG: st.cupGainG, pressureMaxBar: st.pressureMaxBar, pressureEndBar: st.pressureEndBar, flowMeanMlPerS: st.flowMeanMlPerS, tempEndC: st.tempEndC, ecEnd: st.ecEnd, solublesPctByEnd: share };
    }),
  }));
  const trend = (key, digits = 2) => {
    const vals = shots.map((x) => x[key]).filter((v) => v !== null);
    if (vals.length < 2) return null;
    const ds = vals.slice(1).map((v, i) => v - vals[i]).filter((d) => d !== 0); // unchanged steps do not break a trend
    const dir = !ds.length ? 'flat' : ds.every((d) => d > 0) ? 'rising' : ds.every((d) => d < 0) ? 'falling' : 'mixed';
    return { first: vals[0], last: vals[vals.length - 1], change: Math.round((vals[vals.length - 1] - vals[0]) * 10 ** digits) / 10 ** digits, direction: dir };
  };
  const sameProfile = shots.every((x) => x.profile === shots[0].profile);
  const notes = [];
  if (!sameProfile) notes.push('The shots were not all brewed with the same profile; compare stages by name with care.');
  if (!shots.every((x) => x.portalData)) notes.push(`Portal (EC) data exists for shot(s) ${shots.filter((x) => x.portalData).map((x) => x.shot).join(', ') || 'none'} only; EC comparisons are limited to those.`);
  if (steps.some((st) => st.setupChanged.length > 1)) notes.push('More than one setup variable changed between some shots, so their effects cannot be separated from these shots alone.');
  if (steps.every((st) => st.setupChanged.length === 0)) notes.push('No recorded setup change between the shots: differences are repeatability, not an experiment.');
  return {
    order: 'brewing order, oldest first',
    sameProfile,
    shots,
    steps,
    stages,
    trends: { durationSec: trend('durationSec', 1), ratio: trend('ratio'), peakPressureBar: trend('peakPressureBar'), meanEcPerG: trend('meanEcPerG', 3), beverageG: trend('beverageG', 1), grindUm: trend('grindUm', 0), rating: trend('rating', 0) },
    notes,
  };
}

/**
 * Build the two messages for the model. `shots` is [{ digest, profile }] in
 * chronological order; `options` carries the user's standing notes and the
 * questions for this review. With more than one shot the series template is
 * used and the app's own comparison goes in ahead of the per-shot digests.
 */
export function buildReviewMessages(shots, options = {}) {
  const o = { grindStepUm: 5, drink: 'espresso', standingNotes: '', question: '', taste: '', ...options };
  const drinkLabel = { espresso: 'a straight espresso', cortado: 'a cortado (espresso with a little milk)', milk: 'a milk drink (latte, flat white, cappuccino)', both: 'sometimes straight, sometimes with milk' }[o.drink] || o.drink;
  const system = [
    'You are an espresso brewing analyst reviewing shots pulled on a Meticulous espresso machine, an open profile-driven machine whose profiles are made of stages (each commanding flow or pressure over time or weight, with exit triggers and limits) and user-editable variables. Some shots also carry data from a Belka Portal, a conductivity (EC) sensor under the portafilter that measures the concentration of the liquid as it flows; EC is a concentration proxy, not TDS, and must not be presented as TDS unless a refractometer reading or a calibrated estimate is given.',
    '',
    REVIEW_METHOD,
    '',
    shots.length > 1 ? REVIEW_TEMPLATE_SERIES : REVIEW_TEMPLATE,
  ].join('\n');

  const parts = [];
  parts.push(`# Review request`);
  parts.push(`Shots to review: ${shots.length}${shots.length > 1 ? ' (a series, in brewing order — compare them in every section)' : ''}. The grinder adjusts in steps of ${o.grindStepUm} µm, so any grind change must be a whole number of steps. The user normally drinks this coffee as ${drinkLabel}.`);
  if (o.standingNotes) parts.push(`Standing notes from the user about their setup:\n${o.standingNotes}`);
  if (o.taste) parts.push(`How the shot(s) tasted, in the user's words:\n${o.taste}`);
  if (o.question) parts.push(`What the user wants to know:\n${o.question}`);
  const comparison = buildSeriesComparison(shots.map((x) => x.digest));
  if (comparison) {
    parts.push(`\n# Series comparison (computed by the app)`);
    if (comparison.notes.length) parts.push(comparison.notes.map((n) => `- ${n}`).join('\n'));
    parts.push(`One row per shot, the setup and outcome changes between consecutive shots ("steps": what was changed on purpose is in setupChanged), every stage side by side by name, and the trend of the main numbers:\n\`\`\`json\n${JSON.stringify(comparison)}\n\`\`\``);
  }
  shots.forEach(({ digest, profile }, i) => {
    parts.push(`\n# Shot ${i + 1} of ${shots.length}${digest.meta.startedAt ? ` — ${digest.meta.startedAt}` : ''}`);
    if (digest.gaps.length) parts.push(`Data gaps for this shot:\n${digest.gaps.map((g) => `- ${g}`).join('\n')}`);
    const { series, seriesColumns, ...rest } = digest;
    parts.push(`Digest (computed by the app from the recorded samples):\n\`\`\`json\n${JSON.stringify(rest)}\n\`\`\``);
    if (profile) parts.push(`Brewed profile as the machine recorded it:\n\`\`\`json\n${JSON.stringify(profile)}\n\`\`\``);
    else parts.push('Brewed profile: the machine\'s record is not attached, so only the profile name and target weight above are known.');
    parts.push(`Trace resampled to one row per second, columns ${seriesColumns.join(', ')} (null = not recorded):\n\`\`\`json\n${JSON.stringify(series)}\n\`\`\``);
  });
  return { system, user: parts.join('\n') };
}

/** Title for a review from its shots: "Shot review: <coffee> on <profile>". */
export function reviewTitle(digests) {
  const first = digests[digests.length - 1] || digests[0];
  const coffee = first?.meta?.coffee?.bean || 'shot';
  const profile = first?.meta?.profile || 'unknown profile';
  const n = digests.length;
  return n > 1 ? `Shot review: ${n} shots of ${coffee} on ${profile}` : `Shot review: ${coffee} on ${profile}`;
}

// ------------------------------------------------------------- markdown --
// A small Markdown reader for the model's report. parseMarkdown() turns the
// text into blocks (headings, paragraphs, lists, tables, code, quotes, rules)
// made of inline runs ({ text, bold, italic, code, href }); renderMarkdown()
// writes those as escaped HTML, and review-export.js writes the same blocks as
// DOCX and PDF, so the three outputs never disagree about the structure.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline Markdown → runs. Code spans are taken out first so their contents are left alone. */
export function parseInline(text) {
  const runs = [];
  const src = String(text);
  let i = 0;
  let buf = '';
  const flush = (attrs = {}) => {
    if (buf) runs.push({ text: buf, ...attrs });
    buf = '';
  };
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      runs.push({ text: m[1], code: true });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\*\*([^*]+)\*\*/))) {
      flush();
      runs.push(...parseInline(m[1]).map((r) => ({ ...r, bold: true })));
      i += m[0].length;
      continue;
    }
    const prevOk = i === 0 || /[^*\w]/.test(src[i - 1]);
    if (prevOk && (m = rest.match(/^\*([^*\n]+)\*(?!\w)/))) {
      flush();
      runs.push(...parseInline(m[1]).map((r) => ({ ...r, italic: true })));
      i += m[0].length;
      continue;
    }
    if ((i === 0 || /[^\w]/.test(src[i - 1])) && (m = rest.match(/^_([^_\n]+)_(?!\w)/))) {
      flush();
      runs.push(...parseInline(m[1]).map((r) => ({ ...r, italic: true })));
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/))) {
      flush();
      runs.push({ text: m[1], href: m[2] });
      i += m[0].length;
      continue;
    }
    buf += src[i];
    i += 1;
  }
  flush();
  return runs;
}

/** Markdown text → blocks. Headings keep their source level; renderers decide how to show them. */
export function parseMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const para = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', inlines: parseInline(para.join(' ')) });
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', text: buf.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      blocks.push({ type: 'heading', level: h[1].length, inlines: parseInline(h[2].replace(/\s#+\s*$/, '')) });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara();
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => parseInline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', blocks: parseMarkdown(buf.join('\n')) });
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const items = [];
      const baseIndent = li[1].length;
      const ordered = /\d/.test(li[2]);
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && m[1].length <= baseIndent) {
          if (m[1].length < baseIndent) break;
          items.push({ text: m[3], children: [] });
          i++;
          continue;
        }
        if (m && m[1].length > baseIndent && items.length) {
          items[items.length - 1].children.push(lines[i]);
          i++;
          continue;
        }
        if (!m && /^\s{2,}\S/.test(lines[i]) && items.length) {
          const cur = items[items.length - 1];
          if (cur.children.length) cur.children.push(lines[i]);
          else cur.text += ' ' + lines[i].trim();
          i++;
          continue;
        }
        // A blank line does not end the list when what follows continues it: the next item at
        // the same level (a "loose" list — models often write numbered items a line apart, and
        // many write "1." on every item), or an indented block belonging to the current item.
        // Otherwise every item became its own list, each numbered 1.
        if (!lines[i].trim() && items.length) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j >= lines.length) break;
          const next = lines[j].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (next && next[1].length === baseIndent && /\d/.test(next[2]) === ordered) {
            i = j;
            continue;
          }
          if ((next && next[1].length > baseIndent) || (!next && /^\s{2,}\S/.test(lines[j]))) {
            const cur = items[items.length - 1];
            if (cur.children.length) cur.children.push('');
            i = j;
            continue;
          }
        }
        break;
      }
      blocks.push({ type: 'list', ordered, items: items.map((it) => ({ inlines: parseInline(it.text), blocks: it.children.length ? parseMarkdown(it.children.join('\n')) : [] })) });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}

function inlineHtml(runs) {
  return runs
    .map((r) => {
      let t = esc(r.text);
      if (r.code) t = `<code>${t}</code>`;
      if (r.bold) t = `<b>${t}</b>`;
      if (r.italic) t = `<i>${t}</i>`;
      if (r.href) t = `<a href="${esc(r.href)}" target="_blank" rel="noopener noreferrer">${t}</a>`;
      return t;
    })
    .join('');
}

function blocksHtml(blocks) {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'heading': return `<h${Math.min(6, b.level + 1)}>${inlineHtml(b.inlines)}</h${Math.min(6, b.level + 1)}>`; // the app owns h1/h2; the report starts at h3
        case 'paragraph': return `<p>${inlineHtml(b.inlines)}</p>`;
        case 'code': return `<pre><code>${esc(b.text)}</code></pre>`;
        case 'table': return `<table><thead><tr>${b.head.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        case 'quote': return `<blockquote>${blocksHtml(b.blocks)}</blockquote>`;
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul';
          return `<${tag}>${b.items.map((it) => `<li>${inlineHtml(it.inlines)}${it.blocks.length ? blocksHtml(it.blocks) : ''}</li>`).join('')}</${tag}>`;
        }
        case 'hr': return '<hr />';
        default: return '';
      }
    })
    .join('\n');
}

/** Markdown → safe HTML (everything escaped; only http(s) links become anchors). */
export function renderMarkdown(md) {
  return blocksHtml(parseMarkdown(md));
}

/** Markdown → plain text, for places that cannot show formatting. */
export function markdownToText(md) {
  const inl = (runs) => runs.map((r) => r.text).join('');
  const walk = (blocks, depth = 0) =>
    blocks
      .map((b) => {
        const pad = '  '.repeat(depth);
        switch (b.type) {
          case 'heading': return `${pad}${inl(b.inlines).toUpperCase()}`;
          case 'paragraph': return `${pad}${inl(b.inlines)}`;
          case 'code': return b.text;
          case 'table': return [b.head, ...b.rows].map((r) => pad + r.map(inl).join(' | ')).join('\n');
          case 'quote': return walk(b.blocks, depth + 1);
          case 'list': return b.items.map((it, n) => `${pad}${b.ordered ? `${n + 1}.` : '•'} ${inl(it.inlines)}${it.blocks.length ? '\n' + walk(it.blocks, depth + 1) : ''}`).join('\n');
          case 'hr': return `${pad}———`;
          default: return '';
        }
      })
      .join('\n\n');
  return walk(parseMarkdown(md));
}

/** Plain-text size estimate (≈ tokens) so the UI can warn before a huge request. */
export function approxTokens(text) {
  return Math.ceil(String(text || '').length / 3.6);
}
