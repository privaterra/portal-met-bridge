// AI shot review: everything that can be computed locally is computed here,
// deterministically, so the model is asked to interpret numbers rather than
// to derive them. Pure functions — no DOM, no network — so they are unit-tested.
//
//   buildShotDigest(shot, analysis)  → the per-stage story of one shot
//   buildReviewMessages(...)         → { system, user } for any provider
//   renderMarkdown(md)               → safe HTML for the report pane

import { beverageOf, beverageSource, profileTargetOf, measuredEy, grindMicrons } from './analysis.js?v=0.11.1';

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
export function buildShotDigest(shot, analysis, { profileTargetG } = {}) {
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
  const target = Number(profileTargetG) > 0 ? Number(profileTargetG) : profileTargetOf(shot);
  const meta = {
    id: shot.id,
    startedAt: shot.startedAt ? new Date(shot.startedAt).toISOString() : null,
    profile: shot.profileName || null,
    profileTargetG: target ?? null,
    profileTemperatureC: Number.isFinite(shot.profileTemperatureC) ? shot.profileTemperatureC : null,
    coffee: { bean: c.beanName || null, roaster: c.roaster || null, origin: c.origin || null, process: c.process || null, roastLevel: c.roastLevel || null },
    grinder: c.grinderName || null,
    grindUm: grindMicrons(c),
    doseG: dose,
    beverageG: r1(beverage),
    beverageSource: beverageSource(shot),
    scaleFinalG: r1(shot.finalWeightG),
    ratio: dose && beverage > 0 ? r2(beverage / dose) : null,
    durationSec: r1(shot.durationSec),
    note: c.note || null,
    refractometerTdsPct: Number(shot.refractometer?.tdsPct) > 0 ? shot.refractometer.tdsPct : null,
    measuredEyPct: r2(measuredEy(shot)),
    machineRecordAttached: !!shot.machineShotId,
    source: shot.source || null,
  };
  if (!dose) gaps.push('No dose recorded, so ratio and EY cannot be computed.');
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
A numbered list of the findings that matter, most important first (stopped short / ran long, pressure, bloom behaviour, temperature drift, data inconsistencies). Use sub-bullets for checks the user should make and for hypotheses, labelled "Unconfirmed:" when they are.

## Suggested changes
Start with "Change one thing per shot, in this order." then a numbered list. Each item names the exact variable or stage parameter (use the profile's own keys when they are given, e.g. bloom_time, extraction_flow, saturation_pressure, the final weight, the temperature setpoint) and the value to set, or the grind move in whole steps of the grinder's step size, and says what to look for in the next trace. Respect how the user drinks the coffee (ratio targets differ for milk drinks and straight espresso).

## Open questions
Bullets: what you need to know to go further (taste, a second-scale weight, a refractometer reading, which profile version is loaded).

## Sources
Bullets listing only the data you were given: the shot ids/dates, the profile name and version, the coffee as recorded. Do not invent URLs or literature.

Rules: use the numbers from the digest and do not recompute or round them differently; never invent values that are not there — say "not recorded" instead; keep the tone plain and specific; write for the person who pulled the shot; do not describe the chart (the app shows it); do not add a title, preamble or closing remarks.`;

/**
 * Build the two messages for the model. `shots` is [{ digest, profile }] in
 * chronological order; `options` carries the user's standing notes and the
 * questions for this review.
 */
export function buildReviewMessages(shots, options = {}) {
  const o = { grindStepUm: 5, drink: 'espresso', standingNotes: '', question: '', taste: '', ...options };
  const drinkLabel = { espresso: 'a straight espresso', cortado: 'a cortado (espresso with a little milk)', milk: 'a milk drink (latte, flat white, cappuccino)', both: 'sometimes straight, sometimes with milk' }[o.drink] || o.drink;
  const system = [
    'You are an espresso brewing analyst reviewing shots pulled on a Meticulous espresso machine, an open profile-driven machine whose profiles are made of stages (each commanding flow or pressure over time or weight, with exit triggers and limits) and user-editable variables. Some shots also carry data from a Belka Portal, a conductivity (EC) sensor under the portafilter that measures the concentration of the liquid as it flows; EC is a concentration proxy, not TDS, and must not be presented as TDS unless a refractometer reading or a calibrated estimate is given.',
    '',
    REVIEW_METHOD,
    '',
    REVIEW_TEMPLATE,
  ].join('\n');

  const parts = [];
  parts.push(`# Review request`);
  parts.push(`Shots to review: ${shots.length}. The grinder adjusts in steps of ${o.grindStepUm} µm, so any grind change must be a whole number of steps. The user normally drinks this coffee as ${drinkLabel}.`);
  if (o.standingNotes) parts.push(`Standing notes from the user about their setup:\n${o.standingNotes}`);
  if (o.taste) parts.push(`How the shot(s) tasted, in the user's words:\n${o.taste}`);
  if (o.question) parts.push(`What the user wants to know:\n${o.question}`);
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  let s = esc(text);
  // code spans first so their contents are left alone
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
  return s;
}

/**
 * A small Markdown renderer for the model's report: headings, paragraphs,
 * ordered/unordered lists (one level of nesting), tables, code fences,
 * blockquotes, bold/italic/code/links. Everything is HTML-escaped first.
 */
export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const flushPara = (buf) => {
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
    buf.length = 0;
  };
  const para = [];
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      flushPara(para);
      i++;
      continue;
    }
    // code fence
    const fence = line.match(/^\s*```/);
    if (fence) {
      flushPara(para);
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(para);
      const level = Math.min(6, h[1].length + 1); // the app owns h1/h2; the report starts at h3
      out.push(`<h${level}>${inline(h[2].replace(/\s#+\s*$/, ''))}</h${level}>`);
      i++;
      continue;
    }
    // table: header row + separator
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara(para);
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara(para);
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    // lists (with one level of nesting by indentation)
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara(para);
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
        // continuation line of the current item (indented text, not blank)
        if (!m && /^\s{2,}\S/.test(lines[i]) && items.length) {
          const cur = items[items.length - 1];
          if (cur.children.length) cur.children.push(lines[i]);
          else cur.text += ' ' + lines[i].trim();
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it.text)}${it.children.length ? renderMarkdown(it.children.join('\n')) : ''}</li>`).join('')}</${tag}>`);
      continue;
    }
    // horizontal rule
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara(para);
      out.push('<hr />');
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara(para);
  return out.join('\n');
}

/** Plain-text size estimate (≈ tokens) so the UI can warn before a huge request. */
export function approxTokens(text) {
  return Math.ceil(String(text || '').length / 3.6);
}
