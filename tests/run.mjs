// Run with:  node tests/run.mjs
import assert from 'node:assert/strict';
import { analyzeShot, fitCalibration, predictTds, estimateForShot, buildSegments, evalEcAt, beverageOf, beverageOverridden, beverageSource, beverageDefaultOf, profileTargetOf, setBeveragePreference, getBeveragePreference, grindMicrons, measuredEy } from '../js/analysis.js';
import { buildEnvelope, encodeHandoff, decodeHandoff, encodeForQr, CHUNK, QR_MAX_URL_CHARS } from '../js/beanconqueror.js';
import { summaryRow as summaryRowEarly, SUMMARY_COLUMNS as SUMMARY_COLUMNS_EARLY } from '../js/export.js';
import { makeDemoShot } from '../js/demo.js';
import { ShotRecorder, finalizeCheckpoint } from '../js/recorder.js';
import { readFileSync, readdirSync } from 'node:fs';

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ok  ', name);
  } catch (e) {
    console.log('  FAIL', name);
    console.log(e);
    process.exitCode = 1;
  }
};

await test('segments split at gaps and interpolate inside', () => {
  const s = [
    { t: 0, ec: 1 },
    { t: 0.5, ec: 2 },
    { t: 1.0, ec: 3 },
    { t: 5.0, ec: 10 }, // gap of 4 s
    { t: 5.5, ec: 11 },
  ];
  const segs = buildSegments(s, 1.0);
  assert.equal(segs.length, 2);
  assert.equal(evalEcAt(segs, 0.75).ec, 2.5);
  assert.equal(evalEcAt(segs, 3.0), null); // in the gap
  assert.equal(evalEcAt(segs, 5.25).ec, 10.5);
});

await test('analytic integral: constant EC over a linear weight ramp', () => {
  // EC = 2 everywhere, mass 0→40 g over 20 s  ⇒  ∫EC dm = 80, mean = 2
  const portal = Array.from({ length: 201 }, (_, i) => ({ t: i * 0.1, ec: 2, tOut: 60 }));
  const weight = Array.from({ length: 41 }, (_, i) => ({ t: i * 0.5, w: i }));
  const r = analyzeShot(portal, weight);
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.integralEcG - 80) < 1e-9, `integral ${r.integralEcG}`);
  assert.ok(Math.abs(r.meanEcPerG - 2) < 1e-9);
  assert.ok(Math.abs(r.coverageRatio - 1) < 1e-9);
  assert.ok(Math.abs(r.tail.last5g.mean - 2) < 1e-9);
  assert.ok(Math.abs(r.tail.last5g.slopePerG) < 1e-9);
  assert.ok(Math.abs(r.massAt90PctG - 36) < 1e-6);
});

await test('analytic integral: EC linear in mass', () => {
  // EC(m) = m/10 with m = t (1 g/s) over 0..40  ⇒  ∫ m/10 dm = 40²/20 = 80
  const portal = Array.from({ length: 401 }, (_, i) => ({ t: i * 0.1, ec: (i * 0.1) / 10 }));
  const weight = Array.from({ length: 81 }, (_, i) => ({ t: i * 0.5, w: i * 0.5 }));
  const r = analyzeShot(portal, weight);
  assert.ok(Math.abs(r.integralEcG - 80) < 1e-6, `integral ${r.integralEcG}`);
  // last 5 g: mean of m/10 over [35,40] = 3.75, slope = 0.1 per g
  assert.ok(Math.abs(r.tail.last5g.mean - 3.75) < 1e-6);
  assert.ok(Math.abs(r.tail.last5g.slopePerG - 0.1) < 1e-6);
  assert.ok(Math.abs(r.mainPeakEc - 4) < 1e-6);
});

await test('a gap in the Portal stream lowers coverage and is reported', () => {
  const portal = [];
  for (let i = 0; i <= 200; i++) {
    const t = i * 0.1;
    if (t > 8 && t < 14) continue; // 6 s dropout
    portal.push({ t, ec: 2 });
  }
  const weight = Array.from({ length: 41 }, (_, i) => ({ t: i * 0.5, w: i }));
  const r = analyzeShot(portal, weight);
  assert.equal(r.gapCount, 1);
  assert.ok(r.coverageRatio < 0.85 && r.coverageRatio > 0.6, `coverage ${r.coverageRatio}`);
  assert.equal(r.status, 'low-coverage');
});

await test('demo shot analyses sensibly', () => {
  const shot = makeDemoShot();
  const r = analyzeShot(shot.portal, shot.machine.map((s) => ({ t: s.t, w: s.w })), { doseG: 18 });
  assert.equal(r.status, 'ok');
  assert.ok(r.totalMassG > 30, `mass ${r.totalMassG}`);
  assert.ok(r.meanEcPerG > 0.5 && r.meanEcPerG < 4, `mean ec/g ${r.meanEcPerG}`);
  assert.ok(r.mainPeakEc > r.tail.last5g.mean, 'tail below peak');
  assert.ok(r.firstDropTimeSec > 6 && r.firstDropTimeSec < 8.5, `first drop ${r.firstDropTimeSec}`);
  assert.ok(r.curve.length > 50);
});

await test('calibration: proportional fit recovers k, LOOCV sane, affine when it earns it', () => {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const x = 1.5 + i * 0.25;
    pts.push({ id: 's' + i, meanEcPerG: x, tdsPct: 3.2 * x + (i % 2 ? 0.02 : -0.02), meanTempC: 60 + i });
  }
  const fit = fitCalibration(pts);
  assert.ok(fit.calibrated);
  assert.ok(Math.abs(fit.proportional.k - 3.2) < 0.02, `k ${fit.proportional.k}`);
  assert.equal(fit.preliminary, false);
  assert.ok(fit.proportional.loocvRmse < 0.05);
  assert.ok(Math.abs(predictTds(fit, 2) - 6.4) < 0.05);
  // excludeId leaves one out
  const fit5 = fitCalibration(pts, { excludeId: 's0' });
  assert.equal(fit5.shotCount, 5);
  // With an intercept in the data, the affine model should win once n ≥ 5
  const pts2 = pts.map((p) => ({ ...p, tdsPct: 2.0 * p.meanEcPerG + 1.0 }));
  const fit2 = fitCalibration(pts2);
  assert.equal(fit2.activeModel, 'affine');
  assert.ok(Math.abs(fit2.affine.a - 2) < 1e-6 && Math.abs(fit2.affine.b - 1) < 1e-6);
});

await test('estimate flags: no calibration, preliminary, extrapolated', () => {
  const shot = makeDemoShot();
  const r = analyzeShot(shot.portal, shot.machine.map((s) => ({ t: s.t, w: s.w })), { doseG: 18 });
  const none = estimateForShot(r, fitCalibration([]), { doseG: 18 });
  assert.equal(none.tdsPct, null);
  const prelim = fitCalibration([{ id: 'a', meanEcPerG: r.meanEcPerG, tdsPct: 9.0 }, { id: 'b', meanEcPerG: r.meanEcPerG * 1.02, tdsPct: 9.2 }]);
  const est = estimateForShot(r, prelim, { doseG: 18, beverageG: r.totalMassG });
  assert.ok(Math.abs(est.tdsPct - 9.0) < 0.3, `tds ${est.tdsPct}`);
  assert.ok(est.flags.some((f) => f.startsWith('Preliminary')));
  assert.ok(est.eyPct > 15 && est.eyPct < 25, `ey ${est.eyPct}`);
  const far = estimateForShot({ ...r, meanEcPerG: r.meanEcPerG * 2 }, prelim, { doseG: 18 });
  assert.ok(far.flags.some((f) => f.includes('extrapolated')));
});

await test('Beanconqueror envelope round-trips through gzip/base64url/chunks', async () => {
  const shot = makeDemoShot();
  const r = analyzeShot(shot.portal, shot.machine.map((s) => ({ t: s.t, w: s.w })), { doseG: 18 });
  const fit = fitCalibration([
    { id: 'a', meanEcPerG: r.meanEcPerG * 0.9, tdsPct: 8.5 },
    { id: 'b', meanEcPerG: r.meanEcPerG * 1.1, tdsPct: 10.1 },
  ]);
  const est = estimateForShot(r, fit, { doseG: 18, beverageG: r.totalMassG });
  const env = buildEnvelope(shot, r, est, { beanName: 'Test coffee', roaster: 'Test roaster', grinderName: 'Zerno Z1', grindSize: '420 µm', doseG: 18, rating: 4 });
  assert.equal(env.v, 1);
  assert.equal(env.brew.preparationType, 'METICULOUS');
  assert.equal(env.flow.t.length, env.flow.weight.length);
  assert.equal(env.flow.t.length, env.flow.waterDispensed.length);
  assert.equal(env.flow.t.length, env.flow.temperature.length);
  assert.equal(env.flow.fidelity, 'full');
  // a beverage weighed by hand replaces the machine's scale in the hand-off and the summary row
  const weighed = buildEnvelope({ ...shot, beverageG: 41.5 }, r, est, { beanName: 'Test coffee', doseG: 18 });
  assert.equal(weighed.brew.beverageOut.value, 41.5);
  assert.equal(env.brew.beverageOut.value, Math.round(shot.finalWeightG * 10) / 10);
  assert.equal(beverageOf({ finalWeightG: 40 }), 40);
  assert.equal(beverageOf({ finalWeightG: 40, beverageG: 41.5 }), 41.5);
  assert.equal(beverageOf({ finalWeightG: 40, refractometer: { beverageG: 39, tdsPct: 9 } }), 40, 'the reading no longer carries a beverage of its own (store.promoteLegacyBeverage moves old ones to the shot)');
  assert.equal(beverageOverridden({ finalWeightG: 40, beverageG: 41.5 }), true);
  assert.equal(beverageOverridden({ finalWeightG: 40, beverageG: 40 }), false);
  const row = summaryRowEarly({ ...shot, beverageG: 41.5, context: { doseG: 18 } }, r, est);
  assert.equal(row[SUMMARY_COLUMNS_EARLY.indexOf('beverage_g')], 41.5);
  assert.equal(row[SUMMARY_COLUMNS_EARLY.indexOf('beverage_source')], 'weighed');
  assert.equal(row[SUMMARY_COLUMNS_EARLY.indexOf('machine_weight_g')], Math.round(shot.finalWeightG * 10) / 10);
  // the profile's target output weight stands in for the scale by default (v0.10)
  assert.equal(getBeveragePreference(), 'profile');
  const targeted = { finalWeightG: 41.2, profileTargetG: 40 };
  assert.equal(beverageSource(targeted), 'profile');
  assert.equal(beverageOf(targeted), 40);
  assert.equal(beverageOverridden(targeted), true, 'target differs from the scale → marked');
  assert.equal(beverageOverridden({ finalWeightG: 40.02, profileTargetG: 40 }), false, 'within 0.05 g of the scale → not marked');
  assert.equal(beverageOf({ ...targeted, beverageG: 42 }), 42, 'a hand-weighed cup still wins');
  assert.equal(beverageSource({ ...targeted, refractometer: { beverageG: 39 } }), 'profile');
  assert.ok(Math.abs(measuredEy({ ...targeted, refractometer: { tdsPct: 9.1 }, context: { doseG: 18.5 } }) - (9.1 * 40) / 18.5) < 1e-9, 'EY follows the beverage in use');
  assert.equal(measuredEy({ ...targeted, context: { doseG: 18.5 } }), null);
  assert.equal(profileTargetOf({ machineSource: { profile: { name: 'x', final_weight: 38 } } }), 38, 'older shots read the target off the attached record');
  assert.equal(beverageOf({ finalWeightG: 39.4, machineSource: { profile: { final_weight: 38 } } }), 38);
  assert.equal(beverageOf({ finalWeightG: 39.4, machineSource: { profile: { name: 'no target' } } }), 39.4, 'no target → the scale');
  assert.equal(beverageOf({ profileTargetG: 40 }), 40, 'no scale reading → the target even when the scale is preferred');
  assert.equal(beverageDefaultOf({ ...targeted, beverageG: 42 }), 40, 'default ignores the typed value');
  assert.equal(beverageOf(targeted, { prefer: 'scale' }), 41.2);
  const trow = summaryRowEarly({ ...shot, profileTargetG: 40, context: { doseG: 18 } }, r, est);
  assert.equal(trow[SUMMARY_COLUMNS_EARLY.indexOf('beverage_g')], 40);
  assert.equal(trow[SUMMARY_COLUMNS_EARLY.indexOf('beverage_source')], 'profile');
  assert.equal(trow[SUMMARY_COLUMNS_EARLY.indexOf('profile_target_g')], 40);
  assert.equal(trow[SUMMARY_COLUMNS_EARLY.indexOf('machine_weight_g')], Math.round(shot.finalWeightG * 10) / 10);
  const targetedEnv = buildEnvelope({ ...shot, profileTargetG: 40 }, r, est, { beanName: 'Test coffee', doseG: 18 });
  assert.equal(targetedEnv.brew.beverageOut.value, 40, 'the hand-off uses the same beverage as the app');
  setBeveragePreference('scale');
  assert.equal(getBeveragePreference(), 'scale');
  assert.equal(beverageSource(targeted), 'scale');
  assert.equal(beverageOf(targeted), 41.2);
  assert.equal(beverageOverridden(targeted), false);
  assert.equal(beverageOf({ profileTargetG: 40 }), 40, 'still the target when the scale has nothing');
  setBeveragePreference('nonsense');
  assert.equal(getBeveragePreference(), 'profile', 'unknown values fall back to the default');
  // grind size parsing for the History column
  assert.equal(grindMicrons({ grindSize: '420 µm' }), 420);
  assert.equal(grindMicrons({ grindSize: '415' }), 415);
  assert.equal(grindMicrons({ grindSize: 400 }), 400);
  assert.equal(grindMicrons({ grindSize: '' }), null);
  assert.equal(grindMicrons({}), null);
  assert.equal(grindMicrons(null), null);
  // weight deltas accumulate to the final weight in decigrams
  const sumW = env.flow.weight.reduce((a, b) => a + b, 0) / 10;
  assert.ok(Math.abs(sumW - shot.finalWeightG) < 0.15, `sum weight ${sumW} vs ${shot.finalWeightG}`);
  assert.ok(env.flow.t.every((d) => d >= 0 && Number.isInteger(d)));
  assert.ok(env.metrics.find((m) => m.key === 'portalEc').v.length > 100);
  assert.ok(env.brew.note.includes('Estimated from EC'));
  const enc = await encodeHandoff(env);
  assert.ok(enc.url.startsWith('beanconqueror://ADD_BREW?len='));
  const back = await decodeHandoff(enc.url);
  assert.deepEqual(back, env);
  console.log(`        full link: ${enc.urlChars} chars, ${enc.chunks} chunks (json ${enc.jsonBytes} B → gzip ${enc.gzipBytes} B)`);
  // every chunk within the receiver's limit
  const params = new URLSearchParams(enc.url.split('?')[1]);
  for (const [k, v] of params) if (k.startsWith('shareBrew')) assert.ok(v.length <= CHUNK);
});

await test('QR-sized hand-off fits the byte budget and still decodes', async () => {
  const shot = makeDemoShot();
  const r = analyzeShot(shot.portal, shot.machine.map((s) => ({ t: s.t, w: s.w })), { doseG: 18 });
  const est = estimateForShot(r, fitCalibration([]), { doseG: 18 });
  const qr = await encodeForQr(shot, r, est, { beanName: 'Test coffee', doseG: 18, grinderName: 'Zerno Z1', grindSize: '420 µm' });
  assert.ok(qr, 'should fit');
  assert.ok(qr.urlChars <= QR_MAX_URL_CHARS, `qr url ${qr.urlChars}`);
  const back = await decodeHandoff(qr.url);
  assert.equal(back.brew.preparationType, 'METICULOUS');
  assert.equal(back.flow.fidelity, 'downsampled');
  console.log(`        QR link: ${qr.urlChars} chars at level ${JSON.stringify(qr.level)}`);
});

console.log(`\n${passed} test group(s) passed${process.exitCode ? ', with failures' : ''}.`);

// ---------------------------------------------------------------- v0.3 ----
import { parseMeasurement, SHOW_GRAPH, HIDE_GRAPH, PACKET_BYTES } from '../js/portal-ble.js';
import { fitForCoffee, POOLS } from '../js/analysis.js';
import { shotSamplesCsv, summaryRow, SUMMARY_COLUMNS, rowsToCsv, csvEscape } from '../js/export.js';

await test('Portal packet parser: 13-byte little-endian floats + status byte', () => {
  const buf = new ArrayBuffer(PACKET_BYTES);
  const dv = new DataView(buf);
  dv.setFloat32(0, 2.345, true);
  dv.setFloat32(4, 31.5, true);
  dv.setFloat32(8, 64.25, true);
  dv.setUint8(12, 87);
  const m = parseMeasurement(dv);
  assert.ok(Math.abs(m.ec - 2.345) < 1e-6 && m.tInt === 31.5 && m.tOut === 64.25 && m.status === 87);
  assert.equal(parseMeasurement(new DataView(new ArrayBuffer(12))), null, 'wrong length rejected');
  dv.setFloat32(0, NaN, true);
  assert.equal(parseMeasurement(dv), null, 'NaN rejected');
  assert.deepEqual([...SHOW_GRAPH], [0x40, 0x00, 0x01, 0x2d]);
  assert.deepEqual([...HIDE_GRAPH], [0x40, 0x00, 0x01, 0x2e]);
});

await test('calibration pools: auto falls back bean → roaster → roast → all, and labels it', () => {
  const mk = (id, coffeeKey, roasterKey, roastLevel, x, k) => ({ id, coffeeKey, roasterKey, roastLevel, meanEcPerG: x, tdsPct: k * x });
  const pts = [
    ...[1.6, 1.7, 1.8, 1.9, 2.0].map((x, i) => mk('a' + i, 'bean-a', 'roaster-1', 'light', x, 3.0)),
    ...[1.5, 1.8, 2.1].map((x, i) => mk('b' + i, 'bean-b', 'roaster-1', 'light', x, 3.3)),
    ...[2.2, 2.4].map((x, i) => mk('c' + i, 'bean-c', 'roaster-2', 'dark', x, 2.5)),
  ];
  assert.equal(POOLS.map((p) => p.id).join(','), 'bean,roaster,roast,all');
  // Bean A has 5 shots → bean pool
  const fa = fitForCoffee(pts, { coffeeKey: 'bean-a', roasterKey: 'roaster-1', roastLevel: 'light' }, 'auto');
  assert.equal(fa.pool, 'bean');
  assert.equal(fa.shotCount, 5);
  assert.ok(Math.abs(fa.proportional.k - 3.0) < 1e-9);
  // Bean B has only 3 → falls back to roaster-1 (8 shots), flagged as a fallback
  const fb = fitForCoffee(pts, { coffeeKey: 'bean-b', roasterKey: 'roaster-1', roastLevel: 'light' }, 'auto');
  assert.equal(fb.pool, 'roaster');
  assert.equal(fb.shotCount, 8);
  assert.equal(fb.distinctCoffees, 2);
  assert.equal(fb.fallbackFrom, 'bean');
  // A brand-new light roast from an unknown roaster → roast pool (8 light shots)
  const fn = fitForCoffee(pts, { coffeeKey: 'bean-new', roasterKey: 'roaster-9', roastLevel: 'light' }, 'auto');
  assert.equal(fn.pool, 'roast');
  assert.equal(fn.shotCount, 8);
  // Unknown everything → all (10 shots)
  const fu = fitForCoffee(pts, { coffeeKey: 'x', roasterKey: 'y', roastLevel: '' }, 'auto');
  assert.equal(fu.pool, 'all');
  assert.equal(fu.shotCount, 10);
  // Forced bean-only with too few shots stays on bean and is preliminary; none at all → not calibrated
  const forced = fitForCoffee(pts, { coffeeKey: 'bean-c', roasterKey: 'roaster-2', roastLevel: 'dark' }, 'bean');
  assert.equal(forced.pool, 'bean');
  assert.equal(forced.preliminary, true);
  const none = fitForCoffee(pts, { coffeeKey: 'nothing', roasterKey: '', roastLevel: '' }, 'bean');
  assert.equal(none.calibrated, false);
  assert.equal(none.poolLabel, 'this bean only');
  // excludeId leaves the shot itself out
  const loo = fitForCoffee(pts, { coffeeKey: 'bean-a', roasterKey: 'roaster-1', roastLevel: 'light' }, 'bean', { excludeId: 'a0' });
  assert.equal(loo.shotCount, 4);
});

await test('CSV exports: escaping, per-sample rows, summary columns', () => {
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape(NaN), '');
  const shot = makeDemoShot({ seed: 3 });
  shot.context = { beanName: 'Test, with comma', roaster: 'R', roastLevel: 'light', doseG: 18 };
  const csv = shotSamplesCsv(shot);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 1 + shot.machine.length + shot.portal.length);
  assert.ok(lines[0].startsWith('t_s,source,stage,pressure_bar'));
  const r = analyzeShot(shot.portal, shot.machine.map((s) => ({ t: s.t, w: s.w })), { doseG: 18 });
  const row = summaryRow(shot, r, { tdsPct: 9.1, eyPct: 20.2, model: 'proportional', pool: 'bean', flags: ['x'] });
  assert.equal(row.length, SUMMARY_COLUMNS.length);
  assert.ok(rowsToCsv([SUMMARY_COLUMNS, row]).includes('"Test, with comma"'));
});

await test('recorder: checkpoint recovery finalises an interrupted shot, drops an empty one', () => {
  const machine = Array.from({ length: 21 }, (_, i) => ({ t: i * 0.5, w: i * 2, p: 6, f: 2 }));
  const portal = Array.from({ length: 80 }, (_, i) => ({ t: i * 0.125, ec: 2.5 }));
  const ck = { id: 'c1', startedAt: 1000, checkpointAt: 12000, inProgress: true, source: 'live', machine, portal, finalWeightG: 0 };
  const out = finalizeCheckpoint(ck);
  assert.equal(out, ck);
  assert.equal(out.inProgress, undefined);
  assert.equal(out.recovered, true);
  assert.equal(out.durationSec, 10);
  assert.equal(out.recordedUntilSec, 10);
  assert.equal(out.endedAt, 12000);
  assert.equal(out.finalWeightG, 40);
  assert.equal(out.checkpointAt, undefined);
  assert.equal(finalizeCheckpoint({ id: 'c2', inProgress: true, machine: [{ t: 0, w: 0 }], portal: [] }), null);
  // and a normal recording still finalises on the falling edge after the settle window
  const rec = new ShotRecorder({ settleSec: 0 });
  const shots = [];
  rec.addEventListener('shot', (e) => shots.push(e.detail));
  rec.onStatus({ extracting: true, timeMs: 0, p: 1, f: 1, w: 0, at: 0 });
  rec.onPortal({ ec: 2, tOut: 60, tInt: 30, status: 1, at: 100 });
  rec.onStatus({ extracting: true, timeMs: 500, p: 6, f: 2, w: 5, at: 500 });
  rec.onStatus({ extracting: false, timeMs: 1000, p: 0, f: 0, w: 10, at: 1000 });
  assert.equal(rec.state, 'settling');
  return new Promise((resolve) => setTimeout(() => { assert.equal(shots.length, 1); assert.equal(shots[0].portal.length, 1); assert.equal(shots[0].machine.length, 3); assert.equal(shots[0].finalWeightG, 10); resolve(); }, 30));
});

import { buildShotDigest, buildReviewMessages, compactProfile, renderMarkdown, reviewTitle, splitStages, cumulativeWater } from '../js/review.js';
import { PROVIDERS, buildRequest, deltaFromEvent, makeSseParser, normalizeModelList, textFromResponse, maskKey, baseUrlFor, isParamRejection, stripOptionalParams, streamCompletion } from '../js/ai.js';

await test('review digest: stages, water, cup, EC shares; works without Portal data', () => {
  const demo = makeDemoShot({ seed: 3 });
  const shot = { ...demo, id: 'd1', startedAt: Date.UTC(2026, 10, 10, 13, 36), profileName: 'Blooming Espresso', profileTargetG: 38, lagSec: 0, machineShotId: 'rec', context: { beanName: 'Geishify', roaster: 'Cafe Unido', doseG: 18.3, grindSize: '80 µm', grinderName: 'Zerno Z1' } };
  // stage names like the machine's record
  shot.machine = shot.machine.map((m) => ({ ...m, status: m.t < 2 ? 'Saturate' : m.t < 6 ? 'Bloom' : m.t < 9 ? 'Gentle Rebuild' : m.t < 29 ? 'Extract' : 'retracting' }));
  const a = analyzeShot(shot.portal, shot.machine.map((m) => ({ t: m.t, w: m.w })), { doseG: 18.3, stopTimeSec: shot.durationSec });
  const d = buildShotDigest(shot, a);
  assert.deepEqual(d.stages.map((x) => x.name), ['Saturate', 'Bloom', 'Gentle Rebuild', 'Extract']);
  assert.equal(d.meta.doseG, 18.3);
  assert.equal(d.meta.grindUm, 80);
  assert.equal(d.meta.profileTargetG, 38);
  assert.equal(d.meta.beverageG, 38, 'beverage follows the profile-target default');
  assert.ok(d.meta.ratio > 2 && d.meta.ratio < 2.2, `ratio ${d.meta.ratio}`);
  assert.ok(d.hasPortal && d.ec && d.ec.meanEcPerG > 0);
  const last = d.ec.solublesShareByStageEnd[d.ec.solublesShareByStageEnd.length - 1];
  assert.ok(last.solublesPctByEnd >= 95 && last.solublesPctByEnd <= 100, `share by end of Extract ${last.solublesPctByEnd}`);
  assert.ok(d.timeline.pumpStopSec >= 28 && d.timeline.pumpStopSec <= 30, `pump stop ${d.timeline.pumpStopSec}`);
  const water = cumulativeWater(shot.machine);
  assert.ok(Math.abs(water[water.length - 1].ml - d.timeline.totalWaterMl) < 0.1);
  assert.equal(d.series[0].length, 6);
  assert.ok(d.series.length >= Math.floor(shot.durationSec) && d.series.length <= Math.ceil(shot.durationSec) + 2, `one row per second: ${d.series.length}`);
  assert.ok(d.stages.every((st) => st.waterInMl >= 0 && st.cupEndG >= st.cupStartG - 0.05));
  assert.ok(!d.gaps.some((g) => /Portal/.test(g)), 'no Portal gap when the Portal was there');
  // without Portal data: the same digest, EC marked unknown, review still possible
  const dry = buildShotDigest({ ...shot, portal: [] }, analyzeShot([], shot.machine.map((m) => ({ t: m.t, w: m.w })), { doseG: 18.3 }));
  assert.equal(dry.hasPortal, false);
  assert.equal(dry.ec, null);
  assert.ok(dry.gaps.some((g) => /No Belka Portal data/.test(g)));
  assert.equal(dry.stages.length, 4);
  assert.ok(dry.stages.every((st) => st.ecStart === null), 'no EC per stage without Portal');
  assert.ok(dry.series.every((row) => row[5] === null));
  // nothing at all
  const empty = buildShotDigest({ id: 'e', machine: [], portal: [], context: {} }, null);
  assert.equal(empty.stages.length, 0);
  assert.ok(empty.gaps.some((g) => /No machine samples/.test(g)) && empty.gaps.some((g) => /No dose/.test(g)));
  // stage splitting ignores idle/retracting names and marks the pump stop
  const st = splitStages([{ t: 0, status: 'click to start' }, { t: 1, status: 'Saturate' }, { t: 2, status: 'Saturate' }, { t: 3, status: 'Extract' }, { t: 4, status: 'retracting' }]);
  assert.deepEqual(st.map((x) => [x.name, x.samples.length]), [['Saturate', 2], ['Extract', 1]]);
  assert.equal(st[1].pumpStopT, 4);
});

await test('review prompt: method and template, user context, one block per shot, profile compaction', () => {
  const demo = makeDemoShot({ seed: 4 });
  const shot = { ...demo, id: 's1', startedAt: Date.UTC(2026, 10, 9, 9, 0), profileName: 'Blooming Espresso', context: { beanName: 'Supernova', doseG: 18, grindSize: '420 µm' } };
  const d = buildShotDigest(shot, analyzeShot(shot.portal, shot.machine.map((m) => ({ t: m.t, w: m.w })), { doseG: 18 }));
  const profile = compactProfile({ id: 'abc', name: 'Blooming Espresso', temperature: 92, final_weight: 43, display: { description: 'Floral bloom', image: 'data:image/png;base64,AAAA' }, variables: [{ name: 'Bloom Time', key: 'bloom_time', type: 'time', value: 20 }], stages: [{ name: 'Bloom', key: 'bloom', type: 'flow', dynamics: { over: 'time', interpolation: 'linear', points: [[0, 0]] }, exit_triggers: [{ type: 'time', value: '$bloom_time' }], limits: [{ type: 'pressure', value: 7 }] }] });
  assert.equal(profile.finalWeightG, 43);
  assert.equal(profile.stages[0].exitTriggers[0].value, '$bloom_time');
  assert.ok(!JSON.stringify(profile).includes('base64'), 'image stripped');
  const { system, user } = buildReviewMessages([{ digest: d, profile }], { grindStepUm: 5, drink: 'cortado', standingNotes: 'SSP HU burrs', taste: 'sour', question: 'bloom or grind first?' });
  for (const h of ['## Verdict', '## Stages', '## What stands out', '## Suggested changes', '## Open questions', '## Sources']) assert.ok(system.includes(h), `template has ${h}`);
  assert.ok(/stage by stage/.test(system) && /one change per shot/i.test(system), 'method steps present');
  assert.ok(user.includes('Shots to review: 1') && user.includes('steps of 5 µm') && user.includes('a cortado'));
  assert.ok(user.includes('SSP HU burrs') && user.includes('sour') && user.includes('bloom or grind first?'));
  assert.ok(user.includes('"finalWeightG":43') && user.includes('# Shot 1 of 1'));
  assert.ok(user.includes('t_s, pressure_bar, flow_ml_s, cup_g, water_temp_c, portal_ec_ms_cm'));
  const two = buildReviewMessages([{ digest: d, profile: null }, { digest: { ...d, hasPortal: false, ec: null, gaps: ['No Belka Portal data for this shot: x'] }, profile: null }], {});
  assert.ok(two.user.includes('Shots to review: 2') && two.user.includes('# Shot 2 of 2') && two.user.includes('No Belka Portal data') && two.user.includes("record is not attached"));
  assert.equal(reviewTitle([d]), 'Shot review: Supernova on Blooming Espresso');
  assert.equal(reviewTitle([d, d]), 'Shot review: 2 shots of Supernova on Blooming Espresso');
});

await test('markdown renderer: headings, lists, tables, emphasis, code, links — and escaping', () => {
  const html = renderMarkdown('## Verdict\n\nClean **shot** with *bloom* and `bloom_time`.\n\n- one\n- two <b>x</b>\n  - nested\n\n1. first\n2. second\n\n| Stage | Time |\n|---|---|\n| Bloom | 0–2 s |\n\n> note\n\n[Cafe](https://example.com/x) <script>alert(1)</script>');
  assert.ok(html.includes('<h3>Verdict</h3>'), 'h2 → h3 (the app owns h1/h2)');
  assert.ok(html.includes('<b>shot</b>') && html.includes('<i>bloom</i>') && html.includes('<code>bloom_time</code>'));
  assert.ok(html.includes('<ul><li>one</li><li>two &lt;b&gt;x&lt;/b&gt;<ul><li>nested</li></ul></li></ul>'), html);
  assert.ok(html.includes('<ol><li>first</li><li>second</li></ol>'));
  assert.ok(html.includes('<table><thead><tr><th>Stage</th><th>Time</th></tr></thead><tbody><tr><td>Bloom</td><td>0–2 s</td></tr></tbody></table>'));
  assert.ok(html.includes('<blockquote><p>note</p></blockquote>'));
  assert.ok(html.includes('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">Cafe</a>'));
  assert.ok(!html.includes('<script') && html.includes('&lt;script&gt;'), 'raw HTML is escaped');
  assert.equal(renderMarkdown(''), '');
  assert.ok(renderMarkdown('```\nx < y\n```').includes('<pre><code>x &lt; y</code></pre>'));
  assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('href'), 'only http(s) links become anchors');
});

await test('AI providers: request shapes, stream deltas, SSE framing, model lists, key masking', () => {
  const opts = { model: 'm', key: 'k', system: 'S', user: 'U', maxTokens: 10 };
  const a = buildRequest('anthropic', opts);
  assert.equal(a.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(a.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(a.body.system, 'S');
  assert.equal(a.body.messages[0].content, 'U');
  assert.equal(a.body.stream, true);
  assert.equal(a.body.max_tokens, 10);
  // v0.11.2: no sampling parameters unless asked for — Opus 5.5 answers 400 "`temperature` is deprecated for this model"
  assert.ok(!('temperature' in a.body) && !('top_p' in a.body), 'no temperature by default (Anthropic)');
  assert.ok(!('temperature' in buildRequest('openai', opts).body), 'no temperature by default (OpenAI)');
  assert.ok(!('temperature' in buildRequest('google', opts).body.generationConfig), 'no temperature by default (Gemini)');
  assert.equal(buildRequest('anthropic', { ...opts, temperature: 0.2 }).body.temperature, 0.2, 'still sent when asked for');
  assert.equal(buildRequest('google', { ...opts, temperature: 0 }).body.generationConfig.temperature, 0);
  const o = buildRequest('openai', { ...opts, baseUrl: 'http://127.0.0.1:1234/' });
  assert.equal(o.url, 'http://127.0.0.1:1234/v1/chat/completions', 'custom endpoint, trailing slash dropped');
  assert.equal(o.headers.authorization, 'Bearer k');
  assert.deepEqual(o.body.messages.map((m) => m.role), ['system', 'user']);
  const g = buildRequest('google', opts);
  assert.equal(g.url, 'https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse');
  assert.equal(g.headers['x-goog-api-key'], 'k');
  assert.equal(g.body.system_instruction.parts[0].text, 'S');
  assert.equal(buildRequest('google', { ...opts, stream: false }).url.endsWith(':generateContent'), true);
  assert.throws(() => buildRequest('nope', opts), /Unknown provider/);
  assert.throws(() => buildRequest('openai', { ...opts, key: '' }), /No API key/);
  assert.equal(baseUrlFor('anthropic', ''), 'https://api.anthropic.com');
  // deltas
  assert.equal(deltaFromEvent('anthropic', JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } })), 'Hi');
  assert.equal(deltaFromEvent('anthropic', JSON.stringify({ type: 'message_start' })), '');
  assert.equal(deltaFromEvent('anthropic', JSON.stringify({ type: 'message_stop' })), null);
  assert.throws(() => deltaFromEvent('anthropic', JSON.stringify({ type: 'error', error: { message: 'overloaded' } })), /overloaded/);
  assert.equal(deltaFromEvent('openai', JSON.stringify({ choices: [{ delta: { content: 'Yo' } }] })), 'Yo');
  assert.equal(deltaFromEvent('openai', '[DONE]'), null);
  assert.equal(deltaFromEvent('openai', JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })), '');
  assert.equal(deltaFromEvent('google', JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }] })), 'AB');
  assert.equal(deltaFromEvent('google', 'not json'), '');
  assert.equal(textFromResponse('anthropic', { content: [{ type: 'text', text: 'x' }, { type: 'tool_use' }] }), 'x');
  assert.equal(textFromResponse('openai', { choices: [{ message: { content: 'y' } }] }), 'y');
  assert.equal(textFromResponse('google', { candidates: [{ content: { parts: [{ text: 'z' }] } }] }), 'z');
  // SSE framing across chunk boundaries, CRLF, multi-line data
  const p = makeSseParser();
  assert.deepEqual(p.push('event: ping\ndata: {"a":1}\n\ndata: {"b"'), ['{"a":1}']);
  assert.deepEqual(p.push(':2}\r\n\r\ndata: x\ndata: y\n\n'), ['{"b":2}', 'x\ny']);
  assert.deepEqual(p.push('data: tail'), []);
  assert.deepEqual(p.flush(), ['tail']);
  // model lists
  const oa = normalizeModelList('openai', { data: [{ id: 'gpt-6.1-sol', created: 3 }, { id: 'tts-1', created: 9 }, { id: 'gpt-5.5', created: 2 }, { id: 'mock-gpt', created: 1 }] });
  assert.deepEqual(oa.map((m) => m.id), ['gpt-6.1-sol', 'gpt-5.5', 'mock-gpt'], 'non-chat models dropped, newest first, compatible servers kept');
  const gg = normalizeModelList('google', { models: [{ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/text-embedding-1', supportedGenerationMethods: ['embedContent'] }] });
  assert.deepEqual(gg.map((m) => m.id), ['gemini-3.8-flash']);
  const an = normalizeModelList('anthropic', { data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-05-01' }, { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-06-01' }] });
  assert.deepEqual(an.map((m) => m.id), ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  // a model that refuses a parameter: recognised, stripped, retried once
  assert.ok(isParamRejection(400, '`temperature` is deprecated for this model'));
  assert.ok(isParamRejection(400, "Unsupported parameter: 'temperature' is not supported with this model."));
  assert.ok(!isParamRejection(401, 'temperature'), 'only a 400 counts');
  assert.ok(!isParamRejection(400, 'messages: text content blocks must be non-empty'), 'other 400s are not retried');
  assert.deepEqual(stripOptionalParams({ model: 'm', temperature: 0.4, top_p: 1, stream: true }), { model: 'm', stream: true });
  assert.deepEqual(stripOptionalParams({ generationConfig: { temperature: 0.4, topP: 1, maxOutputTokens: 5 } }), { generationConfig: { maxOutputTokens: 5 } });
  assert.equal(stripOptionalParams({ model: 'm', stream: true }), null, 'nothing to strip → no retry');
  assert.equal(maskKey('sk-ant-api03-abcdefghijklmnop'), 'sk-ant…mnop');
  assert.equal(maskKey('short'), '•••••');
  assert.ok(Object.keys(PROVIDERS).every((k) => PROVIDERS[k].defaultModel && PROVIDERS[k].keyUrl.startsWith('https://')));
});

await test('AI providers: a 400 for a sampling parameter is retried once without it; other errors surface as they are', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if ('temperature' in body) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'fine without it' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const retried = [];
  const text = await streamCompletion('anthropic', { key: 'k', model: 'claude-opus-5-5', system: 'S', user: 'U', temperature: 0.4 }, { fetchImpl: fakeFetch, onRetry: (e) => retried.push(e.detail) });
  assert.equal(text, 'fine without it');
  assert.equal(calls.length, 2);
  assert.ok('temperature' in calls[0] && !('temperature' in calls[1]), 'second attempt has no temperature');
  assert.deepEqual(retried, ['`temperature` is deprecated for this model']);
  // the default request never carries temperature, so the first attempt already succeeds
  calls.length = 0;
  await streamCompletion('anthropic', { key: 'k', model: 'claude-opus-5-5', system: 'S', user: 'U' }, { fetchImpl: fakeFetch });
  assert.equal(calls.length, 1);
  // a different 400 is not retried and keeps the provider's message
  const badFetch = async () => new Response(JSON.stringify({ error: { message: 'max_tokens: 8000 > 4096, which is the maximum allowed' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  await assert.rejects(() => streamCompletion('anthropic', { key: 'k', model: 'm', system: 'S', user: 'U' }, { fetchImpl: badFetch }), /HTTP 400 · max_tokens: 8000 > 4096/);
  const stillBad = async () => new Response(JSON.stringify({ error: { message: 'temperature is not supported' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  await assert.rejects(() => streamCompletion('openai', { key: 'k', model: 'm', system: 'S', user: 'U', temperature: 1 }, { fetchImpl: stillBad }), /HTTP 400/, 'a second refusal is reported, not retried again');
});

await test('release: every version stamp agrees with package.json (tools/bump-version.mjs keeps them in step)', () => {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const files = ['index.html', ...readdirSync(new URL('../js', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`)];
  for (const f of files) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const m of text.matchAll(/\?v=(\d+\.\d+\.\d+)/g)) assert.equal(m[1], version, `${f} imports ?v=${m[1]}`);
    // every app-module import must carry the stamp, or a stale cached copy can outlive an update
    for (const m of text.matchAll(/from '(\.\/[a-z-]+\.js)(\?v=[^']*)?'/g)) assert.ok(m[2], `${f}: import of ${m[1]} lacks ?v=`);
  }
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.ok(main.includes(`'v${version}'`), 'About line');
  assert.ok(main.includes(`portal-met-bridge v${version} started`), 'start-up log line');
  const bc = readFileSync(new URL('../js/beanconqueror.js', import.meta.url), 'utf8');
  assert.ok(bc.includes(`version: '${version}'`), 'Beanconqueror envelope version');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(html.includes(`js/main.js?v=${version}`) && html.includes(`css/app.css?v=${version}`), 'index.html stamps');
});

console.log(`\n${passed} test group(s) passed in total${process.exitCode ? ', with failures' : ''}.`);
