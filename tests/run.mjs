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
  // formula injection (CWE-1236): text that a spreadsheet would evaluate is marked as text
  assert.equal(csvEscape('=HYPERLINK("http://x","go")'), `"'=HYPERLINK(""http://x"",""go"")"`);
  assert.equal(csvEscape('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvEscape('+cmd|calc'), "'+cmd|calc");
  assert.equal(csvEscape('-2+3'), "'-2+3");
  assert.equal(csvEscape('\tx'), "'\tx");
  assert.equal(csvEscape(-1.5), '-1.5', 'numbers are untouched');
  assert.equal(csvEscape('-1.5'), '-1.5', 'a numeric string is untouched');
  assert.equal(csvEscape('+42'), '+42');
  assert.equal(csvEscape('1e-3'), '1e-3');
  assert.equal(csvEscape('Blooming Espresso'), 'Blooming Espresso');
  const bad = summaryRow({ id: 'x', startedAt: 0, durationSec: 1, portal: [], machine: [], profileName: '=cmd', context: { beanName: '@evil', note: '-note', doseG: 18 } }, null, null);
  assert.equal(bad[SUMMARY_COLUMNS.indexOf('profile')], '=cmd', 'summaryRow carries the raw value');
  assert.ok(rowsToCsv([bad]).includes("'=cmd") && rowsToCsv([bad]).includes("'@evil") && rowsToCsv([bad]).includes("'-note"), 'the CSV writer neutralizes them');
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
import { profileFinalWeight, BEVERAGE_PREFERENCES } from '../js/analysis.js';
import { parseMarkdown, parseInline, markdownToText, beverageNoteFor, reviewProfileOf, REVIEW_TEMPLATE, REVIEW_TEMPLATE_SERIES, buildSeriesComparison, ratingOf, ratingMaxOf } from '../js/review.js';
import { reviewToDocx, reviewMarkdownFile, reviewFileName, reviewFile, REVIEW_FORMATS, pdfSafe } from '../js/review-export.js';
import { unzipSync, strFromU8 } from '../vendor/fflate.esm.js';
import { PROVIDERS, buildRequest, deltaFromEvent, makeSseParser, normalizeModelList, textFromResponse, maskKey, baseUrlFor, isParamRejection, stripOptionalParams, streamCompletion, maxTokensFor, finishFromEvent, finishFromResponse } from '../js/ai.js';

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

// review.js imports analysis.js with the version stamp, which is a second module instance in node (the
// browser loads one copy, since every import carries the same stamp): the preference has to be set on both.
const stampedAnalysis = await import(`../js/analysis.js?v=${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`);
const setPref = (p) => { setBeveragePreference(p); stampedAnalysis.setBeveragePreference(p); };

await test('final weight (v0.12): profile target from the record, variables and ids; the manual mode; the digest says which weight is the cup', () => {
  // profileFinalWeight: plain field, $variable reference, variable-only, the 2000 "no stop" sentinel
  assert.equal(profileFinalWeight({ final_weight: 43 }), 43);
  assert.equal(profileFinalWeight({ final_weight: '43' }), 43);
  assert.equal(profileFinalWeight({ final_weight: '$final_weight', variables: [{ key: 'final_weight', name: 'Final weight', type: 'weight', value: 43 }] }), 43, '$variable reference resolved');
  assert.equal(profileFinalWeight({ final_weight: 2000, variables: [{ key: 'yield', name: 'Target yield', type: 'weight', value: 40 }] }), 40, 'sentinel ignored, weight variable used');
  assert.equal(profileFinalWeight({ final_weight: 2000 }), null, 'no weight stop → no target');
  assert.equal(profileFinalWeight({ variables: [{ key: 'bloom_time', type: 'time', value: 20 }] }), null);
  assert.equal(profileFinalWeight(null), null);
  assert.equal(profileTargetOf({ machineSource: { profile: { name: 'Blooming Espresso', final_weight: '$final_weight', variables: [{ key: 'final_weight', value: 43 }] } } }), 43, 'older shots read the record');
  // the digest's note: a hand-weighed cup is the yield; the target is only the aim
  setPref('profile');
  const weighed = { beverageG: 43, finalWeightG: 42.6, profileTargetG: 38, context: { doseG: 18 } };
  assert.equal(beverageOf(weighed), 43);
  assert.match(beverageNoteFor(weighed, 43, 38), /weighed by hand after the brew: 43 g.*authoritative.*target was 38 g.*scale read 42\.6 g/);
  assert.match(beverageNoteFor({ finalWeightG: 42.6, profileTargetG: 43 }, 43, 43), /profile's target output weight, 43 g/);
  assert.match(beverageNoteFor({ profileTargetG: 0 }, null, null), /not known.*Do not present either as the measured yield/);
  setPref('manual');
  assert.match(beverageNoteFor({ finalWeightG: 42.6, profileTargetG: 43 }, null, 43), /not known.*target was 43 g.*scale read 42\.6 g.*Do not present either/);
  setPref('profile');
  // manual: nothing stands in for a missing value
  assert.deepEqual(BEVERAGE_PREFERENCES, ['profile', 'scale', 'manual']);
  setPref('manual');
  assert.equal(getBeveragePreference(), 'manual');
  assert.equal(beverageSource({ finalWeightG: 42.6, profileTargetG: 43 }), null);
  assert.equal(beverageOf({ finalWeightG: 42.6, profileTargetG: 43 }), null);
  assert.equal(beverageOf({ finalWeightG: 42.6, profileTargetG: 43, beverageG: 43.4 }), 43.4, 'typed value is used');
  assert.equal(beverageSource({ finalWeightG: 42.6, beverageG: 43.4 }), 'weighed');
  const demo = makeDemoShot({ seed: 5 });
  const d = buildShotDigest({ ...demo, finalWeightG: 40, profileTargetG: 38, context: { doseG: 18 } }, null);
  assert.equal(d.meta.beverageG, null);
  assert.equal(d.meta.ratio, null);
  assert.ok(d.gaps.some((g) => /final weight of this brew is not known/.test(g)));
  assert.equal(d.meta.weighedG, null);
  setPref('profile');
  const d2 = buildShotDigest({ ...demo, finalWeightG: 40, profileTargetG: 38, beverageG: 43, context: { doseG: 18 } }, null);
  assert.equal(d2.meta.beverageG, 43);
  assert.equal(d2.meta.weighedG, 43);
  assert.equal(d2.meta.profileTargetG, 38);
  assert.equal(d2.meta.scaleFinalG, 40);
  assert.equal(d2.meta.beverageSource, 'weighed');
  const { system, user } = buildReviewMessages([{ digest: d2, profile: null }], {});
  assert.ok(/never present either as the measured yield/.test(system) && user.includes('"weighedG":43') && user.includes('authoritative'));
});

await test('before the review (v0.13): a per-shot weight pin beats the Settings default; a chosen profile is what the digest reads', () => {
  // per-shot pin: Settings says "profile" but this shot was confirmed with the scale, and vice versa
  setPref('profile');
  const pinned = { finalWeightG: 42.6, profileTargetG: 43, beveragePrefer: 'scale' };
  assert.equal(beverageSource(pinned), 'scale');
  assert.equal(beverageOf(pinned), 42.6);
  assert.equal(beverageSource({ ...pinned, beveragePrefer: 'profile' }), 'profile');
  assert.equal(beverageSource({ ...pinned, beveragePrefer: 'manual' }), null, 'manual pin with nothing typed → unknown');
  assert.equal(beverageSource({ ...pinned, beveragePrefer: 'manual', beverageG: 41 }), 'weighed', 'a typed value is the cup');
  assert.equal(beverageSource({ ...pinned, beveragePrefer: 'nonsense' }), 'profile', 'an unknown pin falls back to Settings');
  assert.equal(beverageSource(pinned, { prefer: 'profile' }), 'profile', 'an explicit prefer wins over the pin');
  setPref('scale');
  assert.equal(beverageSource({ finalWeightG: 42.6, profileTargetG: 43, beveragePrefer: 'profile' }), 'profile');
  setPref('profile');
  // which profile the review reads: the user's choice, else the machine's record, else nothing
  const recorded = { id: 'demo0001', name: 'Blooming Espresso', temperature: 93, final_weight: 38, variables: [{ key: 'bloom_time', name: 'Bloom Time', type: 'time', value: 15 }] };
  const chosen = { id: '80c5ea87', name: 'Blooming Espresso', temperature: 92, final_weight: 43, variables: [{ key: 'bloom_time', name: 'Bloom Time', type: 'time', value: 20 }, { key: 'extraction_flow', name: 'Extraction flow', type: 'flow', value: 2 }], stages: [{ name: 'Preinfusion' }, { name: 'Bloom' }, { name: 'Extraction' }] };
  assert.equal(reviewProfileOf({ machineSource: { profile: recorded } }), recorded);
  assert.equal(reviewProfileOf({ machineSource: { profile: recorded }, reviewProfile: chosen }), chosen);
  assert.equal(reviewProfileOf({ profileName: 'Blooming Espresso' }), null);
  const demo = makeDemoShot({ seed: 7 });
  const base = { ...demo, finalWeightG: 42.6, beverageG: 43, profileTargetG: 38, context: { doseG: 18 }, machineSource: { ...(demo.machineSource || {}), profile: recorded } };
  const asRecorded = buildShotDigest(base, null);
  assert.equal(asRecorded.meta.profile, 'Blooming Espresso');
  assert.equal(asRecorded.meta.profileChoice, 'as recorded by the machine for this shot');
  assert.equal(asRecorded.meta.profileTargetG, 38);
  assert.equal(asRecorded.meta.profileTemperatureC, 93);
  assert.deepEqual(asRecorded.meta.profileVariables.map((v) => [v.key, v.value]), [['bloom_time', 15]]);
  assert.equal(asRecorded.meta.recordedProfile, undefined);
  const withChoice = buildShotDigest({ ...base, reviewProfile: chosen, profileTargetG: 43, profileTemperatureC: 92 }, null);
  assert.equal(withChoice.meta.profileChoice, 'chosen by the user for this review');
  assert.equal(withChoice.meta.profileTargetG, 43, 'the chosen profile sets the target');
  assert.equal(withChoice.meta.profileTemperatureC, 92);
  assert.deepEqual(withChoice.meta.profileVariables.map((v) => `${v.name} ${v.value}`), ['Bloom Time 20', 'Extraction flow 2']);
  assert.deepEqual(withChoice.meta.profileStages, ['Preinfusion', 'Bloom', 'Extraction']);
  assert.deepEqual(withChoice.meta.recordedProfile, { name: 'Blooming Espresso', finalWeightG: 38, temperatureC: 93 }, 'the record is kept for contrast');
  assert.equal(withChoice.meta.beverageG, 43, 'the weighed cup is still the cup');
  const explicit = buildShotDigest(base, null, { profile: chosen });
  assert.equal(explicit.meta.profileTargetG, 43, 'a profile passed in beats the shot');
  const nameOnly = buildShotDigest({ ...demo, machineSource: undefined, profileName: 'Mystery', profileTargetG: 0, context: { doseG: 18 } }, null);
  assert.equal(nameOnly.meta.profileChoice, 'name only (no record attached)');
  assert.equal(nameOnly.meta.profile, 'Mystery');
  // the prompt carries the chosen profile and its variables
  const { user } = buildReviewMessages([{ digest: withChoice, profile: compactProfile(chosen) }], {});
  assert.ok(user.includes('"profileChoice":"chosen by the user for this review"') && user.includes('"extraction_flow"') && user.includes('"profileTargetG":43'), 'prompt names the choice, its variables and target');
});

await test('review export: parser blocks, Markdown file, Word document (zip parts, headings, table), file names', () => {
  const md = '## Verdict\n\nClean **shot**.\n\n- one\n  - nested\n\n| Stage | Time |\n|---|---|\n| Bloom | 0–2 s |\n\n1. first\n';
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'table', 'list']);
  assert.equal(blocks[0].level, 2);
  assert.deepEqual(parseInline('a **b** `c` [d](https://x.y/z) *e*'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', code: true }, { text: ' ' }, { text: 'd', href: 'https://x.y/z' }, { text: ' ' }, { text: 'e', italic: true }]);
  assert.equal(blocks[2].items[0].blocks[0].type, 'list', 'nested list parsed');
  assert.equal(blocks[3].rows[0][1][0].text, '0–2 s');
  assert.ok(markdownToText(md).includes('VERDICT') && markdownToText(md).includes('• one') && markdownToText(md).includes('Bloom | 0–2 s'));
  const rev = { id: 'rev-1', createdAt: Date.UTC(2026, 10, 10, 16, 55, 2), title: 'Shot review: Supernova on Blooming Espresso', shotIds: ['a'], shotLabels: ['Nov 10 · Supernova · Blooming Espresso · 18.0 → 43.0 g'], provider: 'anthropic', model: 'claude-opus-5-5', taste: 'sweet', question: 'grind?', markdown: md, durationMs: 48000, digests: [{ meta: { coffee: { bean: 'Supernova' } } }] };
  assert.equal(reviewFileName(rev, 'docx'), 'review-2026-11-10T16-55-02-supernova.docx');
  assert.equal(reviewFileName(rev), 'review-2026-11-10T16-55-02-supernova.md');
  const mdFile = reviewMarkdownFile(rev);
  assert.ok(mdFile.startsWith('# Shot review: Supernova on Blooming Espresso\n') && /Claude \(Anthropic\) · claude-opus-5-5 · 48 s/.test(mdFile) && mdFile.includes('Taste: sweet') && mdFile.includes('## Verdict'));
  const docx = reviewToDocx(rev);
  assert.ok(docx instanceof Uint8Array && docx.length > 1500);
  assert.equal(docx[0], 0x50, 'zip magic P');
  assert.equal(docx[1], 0x4b, 'zip magic K');
  const parts = unzipSync(docx);
  assert.deepEqual(Object.keys(parts).sort(), ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
  const docXml = strFromU8(parts['word/document.xml']);
  assert.ok(docXml.includes('<w:pStyle w:val="Title"/>') && docXml.includes('Shot review: Supernova on Blooming Espresso'));
  assert.ok(docXml.includes('<w:pStyle w:val="Heading1"/>') && docXml.includes('>Verdict<'), 'h2 → Heading1');
  assert.ok(docXml.includes('<w:b/>') && docXml.includes('>shot<'), 'bold run');
  assert.ok(docXml.includes('<w:tbl>') && docXml.includes('<w:tblHeader/>') && docXml.includes('0–2 s'), 'table with a header row');
  assert.ok(docXml.includes('>•\t<') && docXml.includes('>one<') && docXml.includes('>1.\t<') && docXml.includes('>first<'), 'list markers');
  assert.ok(docXml.includes('<w:sectPr>'), 'section properties close the body');
  assert.ok(/<w:t xml:space="preserve">[^<]*&amp;[^<]*<\/w:t>/.test(reviewToDocxText({ ...rev, markdown: 'a & b < c' })), 'XML escaped');
  const f = reviewFile(rev, 'docx');
  assert.equal(f.mime, REVIEW_FORMATS.docx.mime);
  assert.equal(reviewFile(rev, 'md').name.endsWith('.md'), true);
  assert.throws(() => reviewFile(rev, 'pdf'), /jsPDF is not loaded/);
  assert.equal(pdfSafe('18.0 → 43.0 g · ∫EC dm · 420 μm · 92 °C · 1 : 2.11 — ≥ 7 bar'), '18.0 -> 43.0 g · integral EC dm · 420 um · 92 °C · 1 : 2.11 — >= 7 bar', 'symbols jsPDF cannot draw are spelled out');
  assert.equal(pdfSafe('naïve café — “quotes” … €'), 'naïve café — “quotes” … €', 'WinAnsi text untouched');
  function reviewToDocxText(r) { return strFromU8(unzipSync(reviewToDocx(r))['word/document.xml']); }
});

await test('files and folders (v0.14): folder names are cleaned, the destination resolves, the server refuses escapes', async () => {
  const { cleanDirName, joinPath, Files, FILE_KINDS, DEFAULT_ROOT } = await import('../js/files.js');
  assert.equal(cleanDirName(' ../weird: name/ ', 'exports'), 'weird name');
  assert.equal(cleanDirName('espresso/shots'), 'espresso/shots');
  assert.equal(cleanDirName('a\\b\\c'), 'a/b/c', 'backslashes are separators');
  assert.equal(cleanDirName('.hidden/../x'), 'x');
  assert.equal(cleanDirName('', 'logs'), 'logs');
  assert.equal(cleanDirName('', ''), '', 'an empty root is allowed');
  assert.equal(cleanDirName('name.', 'x'), 'name', 'trailing dots and spaces go (Windows)');
  assert.equal(cleanDirName('what?*|<>"', 'x'), 'what');
  assert.equal(cleanDirName('x'.repeat(200)).length, 120);
  assert.equal(joinPath('', 'shots', 'a.csv'), 'shots/a.csv');
  assert.equal(joinPath('root', '', 'a.csv'), 'root/a.csv');
  const f = new Files();
  assert.equal(f.effective, 'downloads');
  assert.equal(f.ready, false);
  assert.equal(f.pathOf('shots', 'a.json'), `${DEFAULT_ROOT}/shots/a.json`);
  f.configure({ layout: { root: ' /espresso/pmb/ ', exports: 'CSV: out', logs: '' } });
  assert.equal(f.layout.root, 'espresso/pmb');
  assert.equal(f.layout.exports, 'CSV out');
  assert.equal(f.layout.logs, 'logs', 'an emptied subfolder falls back to its default');
  assert.equal(f.pathOf('exports', 'x.csv'), 'espresso/pmb/CSV out/x.csv');
  assert.equal(f.pathOf('nonsense', 'x'), 'espresso/pmb/nonsense/x', 'an unknown kind gets its own folder');
  // server probe + destination resolution
  const fetchOk = async () => ({ ok: true, json: async () => ({ dataDir: '/share/portal-met-bridge', host: 'pi' }) });
  await f.probeServer(fetchOk);
  assert.deepEqual(f.server, { dataDir: '/share/portal-met-bridge', host: 'pi' });
  assert.equal(f.effective, 'server', 'auto → server when no folder is chosen');
  assert.equal(f.ready, true);
  assert.equal(f.describe(), '/share/portal-met-bridge/espresso/pmb/');
  f.configure({ layout: { root: 'portal-met-bridge' } });
  assert.equal(f.describe(), '/share/portal-met-bridge/', 'the root is not repeated when the place already bears its name');
  assert.equal(f.pathOf('logs', 'x.log'), 'logs/x.log');
  assert.equal(f.rootInUse, '');
  f.configure({ layout: { root: 'espresso/pmb' } });
  assert.equal(f.whereOf('exports'), '/share/portal-met-bridge/espresso/pmb/CSV out/');
  f.folder = { name: 'Espresso' };
  f.folderState = 'granted';
  assert.equal(f.effective, 'folder', 'auto → a chosen folder beats the server');
  assert.equal(f.describe(), 'Espresso/espresso/pmb/');
  f.folderState = 'prompt';
  assert.equal(f.ready, false);
  assert.match(f.blocker, /re-allow/);
  f.configure({ destination: 'server' });
  assert.equal(f.ready, true);
  f.configure({ destination: 'downloads' });
  assert.equal(f.ready, false);
  assert.equal(f.describe(), 'the download folder');
  await f.probeServer(async () => ({ ok: false, status: 404 }));
  assert.equal(f.server, null, 'a plain static host has no data folder');
  f.configure({ destination: 'server' });
  assert.equal(f.ready, false);
  assert.match(f.blocker, /DATA_DIR/);
  assert.deepEqual(Object.keys(FILE_KINDS), ['shots', 'exports', 'reports', 'reviews', 'backups', 'logs']);
  // the server's path guard
  const { safeDataPath } = await import('../serve.mjs');
  const dir = '/data/pmb';
  assert.equal(safeDataPath(dir, 'portal-met-bridge/shots/a.json'), '/data/pmb/portal-met-bridge/shots/a.json');
  assert.equal(safeDataPath(dir, '/leading/slash.txt'), '/data/pmb/leading/slash.txt');
  for (const bad of ['', '..', '../x', 'a/../../x', 'a/.hidden', 'a/b:c', 'a\\b', 'a/\u0000', '.', 'x'.repeat(201)]) assert.equal(safeDataPath(dir, bad), null, `refuses ${JSON.stringify(bad)}`);
});

await test('ready to brew (v0.15): the temperature rules, the brew that disarms them, the sensor choice', async () => {
  const { HeatMonitor, HEAT_RULES, sensorTemp } = await import('../js/heat.js');
  assert.deepEqual(Object.keys(HEAT_RULES), ['machine', 'reach', 'hold', 'settled', 'both']);
  const h = new HeatMonitor({ rule: 'hold', toleranceC: 1, holdSec: 2 });
  h.setTarget(93);
  let t = 0;
  const feed = (temp, name = 'heating', extracting = false, n = 1) => { for (let i = 0; i < n; i++) { h.onStatus({ name, extracting, temp, at: t }); t += 100; } };
  feed(60, 'heating', false, 10);
  assert.equal(h.phase, 'heating');
  assert.equal(h.ready, false);
  assert.match(h.describe(), /heating · 60\.0 °C · target 93\.0 °C · not within/);
  feed(92.4, 'heating', false, 15); // 1.5 s inside the band
  assert.equal(h.ready, false, 'hold: 1.5 of 2 s is not enough');
  assert.match(h.evaluate(t - 100).detail, /for 1 of 2 s/);
  feed(92.6, 'heating', false, 10);
  assert.equal(h.ready, true, 'hold: 2.5 s inside the band');
  assert.equal(h.phase, 'ready');
  assert.match(h.describe(), /^water ready \(held\)/);
  feed(91.5, 'heating', false, 1); // dips out of the band
  assert.equal(h.ready, false, 'leaving the band un-readies');
  assert.equal(h.phase, 'heating');
  feed(93, 'click to start', false, 25);
  assert.equal(h.ready, true);
  // a brew disarms it: still hot afterwards, but not green
  feed(92, 'Extract', true, 20);
  assert.equal(h.phase, 'brewing');
  assert.equal(h.ready, false);
  feed(92.9, 'idle', false, 40);
  assert.equal(h.phase, 'done');
  assert.equal(h.ready, false, 'after a brew the button stays plain though the water is at temperature');
  assert.match(h.describe(), /brew done/);
  feed(92.9, 'heating', false, 25); // the machine heats for the next one
  assert.equal(h.ready, true, 're-armed by the machine heating again');
  // or by the water cooling well below the band and coming back
  feed(92, 'Extract', true, 5);
  feed(80, 'idle', false, 5);
  assert.equal(h.phase, 'heating', 'a reading 3 tolerances under the target re-arms');
  feed(93, 'idle', false, 25);
  assert.equal(h.ready, true);
  // reach: the first reading inside the band
  h.configure({ rule: 'reach' });
  feed(85, 'heating', false, 3);
  assert.equal(h.ready, false);
  feed(92.2, 'heating', false, 1);
  assert.equal(h.ready, true, 'reach needs no hold');
  // settled: within the band and not moving
  h.configure({ rule: 'settled', settleC: 0.3, holdSec: 2 });
  for (let i = 0; i < 30; i++) feed(92.5 + 0.5 * Math.sin(i / 2), 'heating');
  assert.equal(h.ready, false, 'oscillating by 1 °C is not settled');
  feed(93.1, 'heating', false, 30);
  assert.equal(h.ready, true);
  assert.match(h.describe(), /settled/);
  // machine, and both
  h.configure({ rule: 'machine' });
  feed(70, 'heating', false, 3);
  assert.equal(h.ready, false);
  feed(70, 'click to start', false, 1);
  assert.equal(h.ready, true, 'machine: whatever the temperature');
  h.configure({ rule: 'both', holdSec: 1 });
  feed(93, 'heating', false, 15);
  assert.equal(h.ready, false, 'both: held, but the machine has not said so');
  feed(93, 'click to start', false, 1);
  assert.equal(h.ready, true);
  // no target: only the machine rule can decide
  const g = new HeatMonitor({ rule: 'hold', holdSec: 0 });
  g.onStatus({ name: 'click to start', temp: 93, at: 0 });
  assert.equal(g.ready, false);
  assert.match(g.describe(), /target unknown/);
  g.configure({ rule: 'machine' });
  g.onStatus({ name: 'click to start', temp: 93, at: 100 });
  assert.equal(g.ready, true);
  // the sensor choice
  const sens = { t_ext_1: 102.9, t_ext_2: 103.4, t_bar_up: 84, t_bar_mu: 88, t_bar_md: 88, t_bar_down: 84, t_tube: 86.3 };
  assert.equal(sensorTemp('status', { temp: 92.8 }, sens), 92.8);
  assert.equal(sensorTemp('ext1', { temp: 92.8 }, sens), 102.9);
  assert.equal(sensorTemp('tube', {}, sens), 86.3);
  assert.equal(sensorTemp('bar', {}, sens), 86);
  assert.ok(Number.isNaN(sensorTemp('ext2', {}, null)), 'no sensors packet yet → NaN');
});

await test('review markdown (v0.15): numbered items a blank line apart, or all written "1.", are one list numbered 1, 2, 3', () => {
  const md = '## What stands out\n\n1. First finding.\n\n1. Second finding.\n   - Unconfirmed: a hypothesis\n\n1. Third finding.\n\nA paragraph after.\n\n## Suggested changes\nChange one thing per shot, in this order.\n\n1. Set bloom_time to 25 s.\n\n   Look for a later peak.\n\n2. Grind 2 steps finer.\n\n- a bullet after\n- another\n\n1. a new numbered list after bullets';
  const types = parseMarkdown(md).map((b) => (b.type === 'list' ? `${b.ordered ? 'ol' : 'ul'}x${b.items.length}` : b.type));
  assert.deepEqual(types, ['heading', 'olx3', 'paragraph', 'heading', 'paragraph', 'olx2', 'ulx2', 'olx1']);
  const html = renderMarkdown(md);
  assert.equal((html.match(/<ol>/g) || []).length, 3, 'three ordered lists in HTML (3 + 2 + 1 items), not one per item');
  const text = markdownToText(md);
  assert.ok(text.includes('1. First finding.\n2. Second finding.\n  • Unconfirmed: a hypothesis\n3. Third finding.'), text);
  assert.ok(text.includes('1. Set bloom_time to 25 s. Look for a later peak.\n2. Grind 2 steps finer.'), 'an indented paragraph after a blank stays with its item');
  assert.ok(/numbered list \(1\., 2\., 3\. — consecutive/.test(REVIEW_TEMPLATE), 'the template asks for consecutive numbers');
});

await test('series review (v0.16): several shots get the comparing template and an app-computed comparison', () => {
  const mk = (seed, over) => {
    const d = makeDemoShot({ seed });
    const machine = d.machine.map((m) => ({ ...m, status: m.t < 2 ? 'Saturate' : m.t < 6 ? 'Bloom' : m.t < 29 ? 'Extract' : 'retracting' }));
    const shot = { ...d, machine, id: `s${seed}`, finalWeightG: over.out, beverageG: over.out, profileTargetG: 40, profileTemperatureC: 93, context: { doseG: over.dose, grindSize: `${over.grind} µm`, grinderName: 'Z1', beanName: 'Geishify' }, machineSource: { profile: { name: 'Blooming Espresso', temperature: 93, final_weight: 40, variables: [{ key: 'bloom_time', name: 'Bloom Time', type: 'time', value: over.bloom }] } } };
    return buildShotDigest(shot, analyzeShot(shot.portal, machine.map((m) => ({ t: m.t, w: m.w })), { doseG: over.dose, stopTimeSec: shot.durationSec }));
  };
  const a = mk(11, { dose: 18, grind: 420, out: 40, bloom: 15 });
  const b = mk(12, { dose: 18, grind: 410, out: 41, bloom: 15 });
  const c = mk(13, { dose: 18.2, grind: 410, out: 39.5, bloom: 20 });
  const cmp = buildSeriesComparison([a, b, c]);
  assert.equal(cmp.shots.length, 3);
  assert.deepEqual(cmp.shots.map((x) => x.shot), [1, 2, 3]);
  assert.equal(cmp.steps.length, 2);
  assert.deepEqual(cmp.steps[0].setupChanged, ['grindUm'], 'shot 1 → 2 changed only the grind');
  assert.equal(cmp.steps[0].changes.grindUm.delta, -10);
  assert.ok(cmp.steps[1].setupChanged.includes('doseG') && cmp.steps[1].setupChanged.includes('variable:bloom_time'), JSON.stringify(cmp.steps[1].setupChanged));
  assert.deepEqual(cmp.steps[1].changes['variable:bloom_time'], { from: 15, to: 20 });
  assert.ok(cmp.stages.length > 0 && cmp.stages.every((st) => st.perShot.length === 3), 'every stage has a cell per shot');
  assert.ok(cmp.stages[0].perShot.every((cell) => cell.present && Number.isFinite(cell.durationSec)));
  assert.equal(cmp.trends.grindUm.direction, 'falling');
  assert.equal(cmp.trends.grindUm.change, -10);
  assert.ok(cmp.notes.some((n) => /More than one setup variable changed/.test(n)));
  assert.equal(buildSeriesComparison([a]), null, 'one shot: nothing to compare');
  const single = buildReviewMessages([{ digest: a, profile: null }], {});
  const series = buildReviewMessages([{ digest: a, profile: null }, { digest: b, profile: null }, { digest: c, profile: null }], {});
  assert.ok(single.system.includes('## Shots compared\n(Only when more than one shot is given.)') && !single.user.includes('# Series comparison'));
  assert.ok(series.system.includes('every section must compare them') && series.system.includes('## What helped and what did not') && series.system.includes('one item per step between consecutive shots'), 'the series template is used');
  assert.ok(series.user.includes('# Series comparison (computed by the app)') && series.user.includes('"setupChanged":["grindUm"]') && series.user.includes('(a series, in brewing order'), 'the comparison goes in ahead of the digests');
});

await test('machine via the server (v0.16): the proxy target guard and the client\'s proxied URLs', async () => {
  const { machineTarget } = await import('../serve.mjs');
  assert.deepEqual(machineTarget('192.168.1.20'), { host: '192.168.1.20', port: 80 });
  assert.deepEqual(machineTarget('10.0.0.5:8080'), { host: '10.0.0.5', port: 8080 });
  assert.deepEqual(machineTarget('meticulous.local'), { host: 'meticulous.local', port: 80 });
  assert.deepEqual(machineTarget('meticulous'), { host: 'meticulous', port: 80 }, 'a bare LAN hostname');
  assert.deepEqual(machineTarget('127.0.0.1:8792'), { host: '127.0.0.1', port: 8792 });
  for (const bad of ['8.8.8.8', 'example.com', 'meticulous.local:70000', '192.168.1.300', 'a b', '', '../x', 'http://x']) assert.equal(machineTarget(bad), null, `refused: ${bad}`);
  const { machineBaseUrl, normalizeBaseUrl } = await import('../js/meticulous.js');
  assert.equal(normalizeBaseUrl('192.168.1.20'), 'http://192.168.1.20');
  assert.equal(machineBaseUrl('192.168.1.20', { via: 'direct', pageOrigin: 'https://homeassistant.local:8788' }), 'http://192.168.1.20');
  assert.equal(machineBaseUrl('192.168.1.20', { via: 'server', pageOrigin: 'https://homeassistant.local:8788' }), 'https://homeassistant.local:8788/machine/192.168.1.20');
  assert.equal(machineBaseUrl('meticulous.local:8080', { via: 'server', pageOrigin: 'http://localhost:8787' }), 'http://localhost:8787/machine/meticulous.local:8080');
});

await test('https (v0.16): serve.mjs with TLS_* answers on the secure port and hands out the certificate without the key', async () => {
  const { spawnSync, spawn } = await import('node:child_process');
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const https = await import('node:https');
  if (spawnSync('openssl', ['version']).status !== 0) return; // no openssl here: nothing to test with
  const dir = mkdtempSync(join(tmpdir(), 'pmb-tls-'));
  spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=pmb-test', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  assert.ok(existsSync(join(dir, 'cert.pem')));
  const srv = spawn('node', [new URL('../serve.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: '8813', TLS_PORT: '8814', TLS_CERT: join(dir, 'cert.pem'), TLS_KEY: join(dir, 'key.pem'), TLS_SELF_SIGNED: '1' }, stdio: 'ignore' });
  const get = (url) => new Promise((resolve, reject) => https.get(url, { rejectUnauthorized: false }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b, type: res.headers['content-type'] })); }).on('error', reject));
  try {
    await new Promise((r) => setTimeout(r, 800));
    const info = JSON.parse((await get('https://127.0.0.1:8814/api/server')).body);
    assert.equal(info.tls.port, 8814);
    assert.equal(info.tls.selfSigned, true);
    assert.equal(info.machineProxy, true);
    const plain = await (await fetch('http://127.0.0.1:8813/api/server')).json();
    assert.equal(plain.tls.port, 8814, 'the http server advertises the https port');
    const cert = await (await fetch('http://127.0.0.1:8813/api/cert')).text();
    assert.ok(cert.startsWith('-----BEGIN CERTIFICATE-----') && !cert.includes('PRIVATE'), 'the certificate, never the key');
    const page = await get('https://127.0.0.1:8814/');
    assert.ok(page.status === 200 && /<!doctype html>/i.test(page.body));
  } finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('long reviews (v0.17): the output budget grows with the shots, a cut-off is detected per provider, and a continuation carries the text so far', async () => {
  assert.equal(maxTokensFor(1), 8000);
  assert.equal(maxTokensFor(2), 12000);
  assert.equal(maxTokensFor(3), 16000);
  assert.equal(maxTokensFor(8), 16000, 'capped under every current model\'s output limit');
  assert.equal(finishFromEvent('openai', JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })), 'length');
  assert.equal(finishFromEvent('openai', JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: null }] })), null);
  assert.equal(finishFromEvent('anthropic', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } })), 'length');
  assert.equal(finishFromEvent('anthropic', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })), 'stop');
  assert.equal(finishFromEvent('google', JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] })), 'length');
  assert.equal(finishFromResponse('openai', { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }), 'stop');
  const history = [{ role: 'assistant', content: 'first half' }, { role: 'user', content: 'continue' }];
  const oa = buildRequest('openai', { model: 'm', key: 'k', system: 's', user: 'u', history, maxTokens: 12000 });
  assert.deepEqual(oa.body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(oa.body.messages[2].content, 'first half');
  assert.equal(oa.body.max_completion_tokens, 12000);
  const an = buildRequest('anthropic', { model: 'm', key: 'k', system: 's', user: 'u', history, maxTokens: 12000 });
  assert.deepEqual(an.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(an.body.max_tokens, 12000);
  const g = buildRequest('google', { model: 'm', key: 'k', system: 's', user: 'u', history, maxTokens: 12000 });
  assert.deepEqual(g.body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(g.body.generationConfig.maxOutputTokens, 12000);
  assert.ok(isParamRejection(400, "Unsupported parameter: 'max_completion_tokens' is not supported") && !('max_completion_tokens' in stripOptionalParams(oa.body)), 'an endpoint that refuses the token limit gets the request without it');
  // the streamed finish reason reaches onFinish
  const sse = (events) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  let finish = null;
  const text = await streamCompletion('openai', { model: 'm', key: 'k', system: 's', user: 'u' }, { fetchImpl: async () => sse([{ choices: [{ delta: { content: 'ab' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }]), onFinish: (f) => (finish = f) });
  assert.equal(text, 'ab');
  assert.equal(finish, 'length');
  finish = null;
  await streamCompletion('openai', { model: 'm', key: 'k', system: 's', user: 'u' }, { fetchImpl: async () => sse([{ choices: [{ delta: { content: 'ab' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]), onFinish: (f) => (finish = f) });
  assert.equal(finish, 'stop');
});

await test('rating and comment (v0.17): 1–5 stars travel in the digest, the series comparison, the CSV and the templates', () => {
  assert.equal(ratingOf({ rating: 4 }), 4);
  assert.equal(ratingOf({ rating: 0 }), null);
  assert.equal(ratingOf({ rating: 6 }), null, 'a 5-scale shot cannot hold a 6');
  assert.equal(ratingOf({ rating: '3' }), 3);
  assert.equal(ratingOf({}), null);
  // the 1–9 scale (v0.18): each shot carries the scale it was rated on
  assert.equal(ratingMaxOf({}), 5);
  assert.equal(ratingMaxOf({ ratingMax: 9 }), 9);
  assert.equal(ratingMaxOf({ ratingMax: 7 }), 5, 'only 5 or 9');
  assert.equal(ratingOf({ rating: 7, ratingMax: 9 }), 7);
  assert.equal(ratingOf({ rating: 10, ratingMax: 9 }), null);
  const nine = buildShotDigest({ ...makeDemoShot({ seed: 22 }), id: 'r9', rating: 7, ratingMax: 9, context: { doseG: 18 } }, analyzeShot(makeDemoShot({ seed: 22 }).portal, makeDemoShot({ seed: 22 }).machine.map((m) => ({ t: m.t, w: m.w })), { doseG: 18, stopTimeSec: 30 }));
  assert.equal(nine.meta.rating, 7);
  assert.equal(nine.meta.ratingMax, 9);
  const nineRow = summaryRow({ ...makeDemoShot({ seed: 22 }), id: 'r9', rating: 7, ratingMax: 9, context: { doseG: 18 } }, null, null);
  assert.equal(nineRow[SUMMARY_COLUMNS.indexOf('rating')], 7);
  assert.equal(nineRow[SUMMARY_COLUMNS.indexOf('rating_max')], 9);
  const d = makeDemoShot({ seed: 21 });
  const shot = { ...d, id: 'r1', rating: 4, comment: 'sweet, round', context: { doseG: 18, beanName: 'Geishify' } };
  const digest = buildShotDigest(shot, analyzeShot(shot.portal, shot.machine.map((m) => ({ t: m.t, w: m.w })), { doseG: 18, stopTimeSec: shot.durationSec }));
  assert.equal(digest.meta.rating, 4);
  assert.equal(digest.meta.ratingMax, 5);
  assert.equal(digest.meta.comment, 'sweet, round');
  const plain = buildShotDigest({ ...shot, rating: undefined, comment: '  ' }, analyzeShot(shot.portal, shot.machine.map((m) => ({ t: m.t, w: m.w })), { doseG: 18, stopTimeSec: shot.durationSec }));
  assert.equal(plain.meta.rating, null);
  assert.equal(plain.meta.comment, null);
  const cmp = buildSeriesComparison([plain, digest]);
  assert.deepEqual(cmp.shots.map((x) => x.rating), [null, 4]);
  assert.equal(cmp.shots[1].comment, 'sweet, round');
  assert.equal(cmp.trends.rating, null, 'one rated shot is not a trend');
  const third = buildShotDigest({ ...shot, id: 'r3', rating: 5 }, analyzeShot(shot.portal, shot.machine.map((m) => ({ t: m.t, w: m.w })), { doseG: 18, stopTimeSec: shot.durationSec }));
  const cmp3 = buildSeriesComparison([digest, third]);
  assert.deepEqual(cmp3.steps[0].changes.rating, { from: 4, to: 5, delta: 1 });
  assert.equal(cmp3.trends.rating.direction, 'rising');
  const row = summaryRow(shot, null, null);
  assert.equal(row[SUMMARY_COLUMNS.indexOf('rating')], 4);
  assert.equal(row[SUMMARY_COLUMNS.indexOf('rating_max')], 5);
  assert.equal(row[SUMMARY_COLUMNS.indexOf('comment')], 'sweet, round');
  assert.equal(summaryRow({ ...shot, rating: undefined, comment: undefined }, null, null)[SUMMARY_COLUMNS.indexOf('rating')], '');
  for (const t of [REVIEW_TEMPLATE, REVIEW_TEMPLATE_SERIES]) {
    assert.ok(t.includes('### Stage by stage') && t.includes('### One change per shot') && t.includes('"worked well", "acceptable" or "needs work"'), 'Suggested changes starts with a verdict per stage');
    assert.ok(t.includes('meta.rating') && t.includes('meta.ratingMax') && t.includes('meta.comment'), 'the model is told what the rating means and its scale');
  }
  const md = parseMarkdown('## Suggested changes\n\n### Stage by stage\n\n- **Bloom**: 8 s — worked well — keep as is\n\n### One change per shot\n\n1. Grind finer.\n');
  assert.deepEqual(md.filter((b) => b.type === 'heading').map((b) => b.level), [2, 3, 3]);
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
  // the Home Assistant app installs the release tag named by its own version, so it must match too
  const ha = readFileSync(new URL('../homeassistant/portal_met_bridge/config.yaml', import.meta.url), 'utf8');
  assert.ok(ha.includes(`\nversion: "${version}"\n`), `homeassistant config.yaml version is ${/version: "([^"]*)"/.exec(ha)?.[1]}, package.json ${version}`);
  const changelog = readFileSync(new URL('../homeassistant/portal_met_bridge/CHANGELOG.md', import.meta.url), 'utf8');
  assert.ok(changelog.includes(`## ${version}`), 'the Home Assistant CHANGELOG has an entry for this version');
});

await test('security (v0.19): the server answers only its own page — Host and Origin checks, a static allowlist, inert data files, no symlink escape, a relay that carries no credentials', async () => {
  const { hostAllowed, crossSite, hostnameOf, staticAllowed, machineTarget, insideDataDir } = await import('../serve.mjs');
  // names DNS rebinding cannot forge pass; a public name must be listed
  for (const ok of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787', '192.168.1.20', 'homeassistant.local:8788', 'homeassistant:8787', 'pi.lan', 'box.home.arpa', 'app.localhost:8787']) assert.equal(hostAllowed(ok, new Set()), true, ok);
  for (const bad of ['evil.example:8787', 'attacker.com', '', undefined, 'localhost.evil.example', '127.0.0.1.nip.io']) assert.equal(hostAllowed(bad, new Set()), false, String(bad));
  assert.equal(hostAllowed('espresso.example.org:8788', new Set(['espresso.example.org'])), true);
  assert.equal(hostAllowed('anything.example', new Set(['*'])), true);
  assert.equal(hostnameOf('[fe80::1]:8787'), 'fe80::1');
  const rq = (headers) => ({ headers });
  assert.equal(crossSite(rq({ host: 'localhost:8787' })), false, 'no browser headers: a script or curl');
  assert.equal(crossSite(rq({ host: 'localhost:8787', origin: 'http://localhost:8787' })), false);
  assert.equal(crossSite(rq({ host: 'localhost:8787', origin: 'http://localhost:3000' })), true, 'another port is another origin');
  assert.equal(crossSite(rq({ host: 'localhost:8787', origin: 'https://evil.example' })), true);
  assert.equal(crossSite(rq({ host: 'localhost:8787', origin: 'null' })), true);
  assert.equal(crossSite(rq({ host: 'localhost:8787', 'sec-fetch-site': 'cross-site' })), true, 'an <img> or form on another site');
  assert.equal(crossSite(rq({ host: 'localhost:8787', 'sec-fetch-site': 'same-origin' })), false);
  assert.equal(crossSite(rq({ host: 'localhost:8787', 'sec-fetch-site': 'none' })), false, 'typed into the address bar');
  assert.equal(crossSite(rq({ host: '10.0.0.5:8787', origin: 'https://espresso.example.org' }), new Set(['espresso.example.org'])), false, 'behind a reverse proxy: the listed public name');
  for (const ok of ['/index.html', '/js/main.js', '/css/app.css', '/vendor/uPlot.esm.js', '/docs/NOTES.md', '/assets/icon-1024.png']) assert.equal(staticAllowed(ok), true, ok);
  for (const bad of ['/.git/config', '/package.json', '/package-lock.json', '/tests/run.mjs', '/tools/vendor.mjs', '/serve.mjs', '/js/.hidden', '/homeassistant/portal_met_bridge/run.sh', '/.github/workflows/release.yml', '/']) assert.equal(staticAllowed(bad), false, bad);
  for (const bad of ['169.254.169.254', 'supervisor', 'hassio', 'supervisor:80']) assert.equal(machineTarget(bad), null, bad);

  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pmb-sec-'));
  const data = join(dir, 'data');
  mkdirSync(data);
  writeFileSync(join(dir, 'outside.txt'), 'secret outside the data folder');
  let linked = true;
  try { symlinkSync(dir, join(data, 'link')); } catch { linked = false; }
  if (linked) assert.equal(await insideDataDir(data, join(data, 'link', 'outside.txt')), false);
  assert.equal(await insideDataDir(data, join(data, 'shots', 'new.json')), true, 'a path that does not exist yet, inside');
  // a stand-in machine that tries to set a cookie and echoes what it was sent
  let seen = null;
  const machine = http.createServer((q, r) => { seen = q.headers; r.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=1', 'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': "default-src *" }); r.end('<script>1</script>'); });
  await new Promise((r) => machine.listen(8817, '127.0.0.1', r));
  const srv = spawn('node', [new URL('../serve.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: '8816', DATA_DIR: data, ALLOWED_HOSTS: '', TLS_PORT: '' }, stdio: 'ignore' });
  const call = (path, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: 8816, path, method, headers: { host: '127.0.0.1:8816', ...headers } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    q.on('error', reject);
    q.end(body);
  });
  try {
    await new Promise((r) => setTimeout(r, 800));
    // the page, with its policy
    const page = await call('/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline/.test(page.headers['content-security-policy']), 'no inline or eval script');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.match(page.body, /<meta http-equiv="Content-Security-Policy"/, 'the same policy in the page itself, for other servers');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(page.body) && !/\son[a-z]+="/.test(page.body), 'no inline script or handler in index.html');
    // nothing but the app is served
    for (const p of ['/.git/config', '/package.json', '/tests/run.mjs', '/serve.mjs', '/tools/vendor.mjs', '/js/../package.json', '/%2e%2e/etc/passwd']) assert.equal((await call(p)).status, 404, p);
    assert.equal((await call('/js/main.js')).status, 200);
    assert.equal((await call('/index.html', { method: 'POST' })).status, 405);
    // DNS rebinding: a foreign name in Host
    const rebind = await call('/api/server', { headers: { host: 'evil.example:8816' } });
    assert.equal(rebind.status, 421);
    assert.match(JSON.parse(rebind.body).error, /ALLOWED_HOSTS=evil\.example/);
    assert.equal((await call('/', { headers: { host: 'evil.example:8816' } })).status, 421, 'not even the page');
    // cross-site request forgery
    assert.equal((await call('/api/quit', { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call('/api/quit', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await call('/machine/127.0.0.1:8817/api/v1/action/start', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' } })).status, 403, 'a page elsewhere cannot start a brew through the relay');
    assert.equal(seen, null, 'and the machine never saw it');
    assert.equal((await call('/machine/127.0.0.1:8817/x', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'nor probe the LAN with an <img>');
    assert.equal((await call('/api/files/a.json', { method: 'PUT', headers: { origin: 'http://localhost:3000' }, body: '{}' })).status, 403);
    assert.equal((await call('/api/server', { headers: { origin: 'http://127.0.0.1:8816', 'sec-fetch-site': 'same-origin' } })).status, 200, 'the page itself passes');
    // the relay: same-origin works, carries no cookie, brings none back, and the machine's HTML cannot script here
    const relayed = await call('/machine/127.0.0.1:8817/api/v1/machine', { headers: { origin: 'http://127.0.0.1:8816', cookie: 'app=1', authorization: 'Bearer x' } });
    assert.equal(relayed.status, 200);
    assert.ok(seen && !seen.cookie && !seen.authorization && !seen.origin, JSON.stringify(seen));
    assert.equal(relayed.headers['set-cookie'], undefined);
    assert.equal(relayed.headers['access-control-allow-origin'], undefined);
    assert.match(relayed.headers['content-security-policy'], /^sandbox/);
    assert.equal(relayed.headers['x-content-type-options'], 'nosniff');
    for (const t of ['169.254.169.254', 'supervisor', '8.8.8.8', 'example.com']) assert.equal((await call(`/machine/${t}/`)).status, 400, t);
    // data files are data: an .html in the folder is downloaded as bytes, sandboxed
    assert.equal((await call('/api/files/exports/x.html', { method: 'PUT', body: '<script>alert(1)</script>' })).status, 200);
    const html = await call('/api/files/exports/x.html');
    assert.equal(html.status, 200);
    assert.equal(html.headers['content-type'], 'application/octet-stream');
    assert.equal(html.headers['content-disposition'], 'attachment');
    assert.match(html.headers['content-security-policy'], /^sandbox/);
    assert.equal((await call('/api/files/backups/b.json', { method: 'PUT', body: '{"a":1}' })).status, 200);
    assert.match((await call('/api/files/backups/b.json')).headers['content-type'], /^application\/json/);
    assert.equal((await call('/api/files/a%20b%25c.txt', { method: 'PUT', body: 'x' })).status, 200, 'a percent sign in a name is decoded once');
    assert.ok(existsSync(join(data, 'a b%c.txt')));
    assert.equal((await call('/api/files/%E0%A4%A')).status, 400, 'a malformed escape is a bad request, not a crash');
    // a symbolic link in the folder leads nowhere
    if (linked) {
      assert.equal((await call('/api/files/link/outside.txt')).status, 400);
      assert.equal((await call('/api/files/link/planted.txt', { method: 'PUT', body: 'x' })).status, 400);
      assert.ok(!existsSync(join(dir, 'planted.txt')));
      assert.equal((await call('/api/files/link/outside.txt', { method: 'DELETE' })).status, 400);
      assert.ok(existsSync(join(dir, 'outside.txt')));
    }
    // a WebSocket from another site is refused before it reaches the machine
    const upgrade = (origin) => new Promise((resolve) => {
      const q = http.request({ host: '127.0.0.1', port: 8816, path: '/machine/127.0.0.1:8817/socket.io/?EIO=4&transport=websocket', headers: { host: '127.0.0.1:8816', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...(origin ? { origin } : {}) } });
      q.on('response', (res) => resolve(res.statusCode));
      q.on('upgrade', (res, sock) => { sock.destroy(); resolve(res.statusCode); });
      q.on('error', () => resolve('closed'));
      q.end();
    });
    assert.equal(await upgrade('https://evil.example'), 403);
    // the server is still up after all of that
    assert.equal((await call('/api/server')).status, 200);
  } finally {
    srv.kill();
    machine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('security (v0.19): imported backups are normalised, a settings file cannot repoint the API key, endpoints are judged, Markdown stays inert', async () => {
  const { cleanImportedShot, cleanImportedBean, cleanImportedReview } = await import('../js/store.js');
  const { endpointRisk } = await import('../js/ai.js');
  const evil = '"><img src=x onerror=alert(1)>';
  const shot = cleanImportedShot({ id: evil, startedAt: '1700000000000', durationSec: evil, finalWeightG: { toString: () => evil }, rating: '4', ratingMax: 9, profileName: { length: evil }, comment: 'x'.repeat(5000), machine: [{ t: 0, w: 1 }, 'junk', null, [1]], portal: { length: evil }, context: { beanName: evil, doseG: 18, nested: { a: 1 }, list: [evil] }, files: evil, machineSource: evil, inProgress: 'yes' });
  assert.equal(shot.id, evil, 'an id stays a string (and is escaped where it is shown)');
  assert.equal(shot.startedAt, 1700000000000);
  assert.ok(!('durationSec' in shot) && !('finalWeightG' in shot) && !('profileName' in shot) && !('files' in shot) && !('machineSource' in shot));
  assert.equal(shot.rating, 4);
  assert.deepEqual(shot.machine, [{ t: 0, w: 1 }]);
  assert.deepEqual(shot.portal, [], 'a portal that is not a list becomes an empty list');
  assert.deepEqual(shot.context, { beanName: evil, doseG: 18 });
  assert.equal(shot.comment.length, 2000);
  assert.equal(shot.inProgress, false);
  for (const bad of [null, 'x', [], { id: 'a' }, { id: {}, machine: [] }, { machine: [] }]) assert.equal(cleanImportedShot(bad), null);
  assert.equal(cleanImportedBean({ key: 'k', name: 'Bean', url: { href: evil }, notes: evil, uses: evil }).url, undefined);
  assert.equal(cleanImportedBean({ key: 'k', name: 'Bean', uses: evil }).uses, 0);
  assert.equal(cleanImportedBean({ name: 'no key' }), null);
  const rev = cleanImportedReview({ id: 7, markdown: '# x', title: { a: 1 }, shotIds: [evil, {}, 3], provider: evil.repeat(10) });
  assert.equal(rev.id, '7');
  assert.equal(rev.title, 'Review');
  assert.deepEqual(rev.shotIds, [evil, '3']);
  assert.ok(rev.provider.length <= 40);
  assert.equal(cleanImportedReview({ id: 'r', markdown: 5 }), null);
  // where the key goes
  for (const fine of ['', 'https://openrouter.ai/api/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://192.168.1.20:8080/v1', 'http://ollama.local/v1', 'http://nas:8080/v1']) assert.equal(endpointRisk(fine), '', fine);
  for (const insecure of ['http://api.example.com/v1', 'http://8.8.8.8/v1']) assert.equal(endpointRisk(insecure), 'insecure', insecure);
  for (const invalid of ['ftp://x', 'javascript:alert(1)', 'not a url']) assert.equal(endpointRisk(invalid), 'invalid', invalid);
  // the model's report is text: HTML in it is escaped, only http(s) links become links
  const { renderMarkdown } = await import('../js/review.js');
  const html = renderMarkdown('## Verdict <img src=x onerror=alert(1)>\n\n<script>alert(1)</script> [ok](https://example.org/a"b) [bad](javascript:alert(1)) `<b>code</b>`\n\n| a | b |\n| --- | --- |\n| <svg onload=1> | 2 |\n');
  assert.ok(!/<img|<script|<svg|javascript:[^<]*"/.test(html.replace(/&lt;[^&]*&gt;/g, '')), html);
  assert.ok(!/href="javascript:/i.test(html));
  assert.match(html, /<a href="https:\/\/example\.org\/a&quot;b" target="_blank" rel="noopener noreferrer">/);
  // the page never writes a shot's id or file path into markup unescaped
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.ok(!/data-id="\$\{(?!esc\(|CSS\.escape\()/.test(main), 'data-id="${…}" always goes through esc()');
  assert.ok(main.includes("esc('JSON + CSV in the save folder: ' + s.files.json)"), 'the file path in the History tooltip is escaped');
  for (const f of ['../js/main.js', '../js/machine-panel.js', '../js/charts.js', '../js/review.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/\beval\(|new Function\(|document\.write\(|\.insertAdjacentHTML\(|\bon(click|error|load)="/.test(src), `${f}: no eval, document.write, insertAdjacentHTML or inline handlers`);
    assert.ok(!/target="_blank"(?![^>]*rel="noopener)/.test(src), `${f}: links that open a new tab carry rel="noopener"`);
  }
  // the Analysis digest heading: a profile name comes from the machine (and from shared profiles) and reached innerHTML unescaped until 0.19
  const mainSrc = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.ok(/m\.profile \? `\$\{esc\(m\.profile\)\}/.test(mainSrc) && !/`\$\{m\.profile\}/.test(mainSrc), 'the digest heading escapes the profile name');
  assert.ok(/await renderSavedReviews\(\); \/\/ a backup carries reviews too/.test(mainSrc), 'a restore refreshes the saved reviews');
});

await test('dependencies (v0.19): vendor/ is exactly what vendor/manifest.json says, and the workflows do not interpolate inputs into shell', async () => {
  const { verify, loadManifest, vendorPackageJson, advisoriesFrom, sha256 } = await import('../tools/vendor.mjs');
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(verify(), [], 'every vendored file has the recorded SHA-256, vendor/package.json and the README agree');
  const manifest = loadManifest();
  assert.deepEqual(Object.keys(manifest.packages).sort(), ['fflate', 'jspdf', 'qrcode-generator', 'socket.io-client', 'uplot']);
  assert.ok(Number(manifest.packages.jspdf.version.split('.')[0]) >= 4, 'jsPDF 4 or later (2.x and 3.x carry open advisories)');
  assert.equal(vendorPackageJson(manifest).dependencies.jspdf, manifest.packages.jspdf.version);
  // a tampered file is noticed
  const broken = structuredClone(manifest);
  broken.packages.fflate.files[0].sha256 = sha256('something else');
  assert.ok(verify(broken).some((p) => /fflate\.esm\.js is not fflate/.test(p)));
  // the audit report reader
  const adv = advisoriesFrom({ vulnerabilities: { jspdf: { severity: 'critical', fixAvailable: { name: 'jspdf', version: '4.2.1' }, via: [{ name: 'jspdf', severity: 'high', title: 'DoS', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', range: '<3.0.1' }, { name: 'jspdf', severity: 'critical', title: 'LFI', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', range: '<=3.0.4' }, 'dompurify'] } } });
  assert.deepEqual(adv.map((a) => [a.id, a.severity, a.fix]), [['GHSA-dddd-eeee-ffff', 'critical', 'jspdf@4.2.1'], ['GHSA-aaaa-bbbb-cccc', 'high', 'jspdf@4.2.1']]);
  assert.deepEqual(advisoriesFrom({}), []);
  // workflows: nothing a person types (an input, a tag or branch name) is pasted into a shell script, and the token is read-only unless a job says otherwise
  const dir = new URL('../.github/workflows/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    const lines = text.split('\n');
    let inRun = -1;
    lines.forEach((line, i) => {
      const indent = line.search(/\S/);
      if (inRun >= 0 && indent >= 0 && indent <= inRun) inRun = -1;
      const m = line.match(/^(\s*)(?:- )?run:\s*(.*)$/);
      const body = m ? m[2] : inRun >= 0 ? line : '';
      assert.ok(!/\$\{\{\s*(inputs\.|github\.event\.|github\.ref_name|github\.head_ref|github\.ref\b)/.test(body), `${f}:${i + 1} pastes ${line.trim().slice(0, 60)} into a shell script — pass it through env:`);
      if (m && /^[|>]/.test(m[2])) inRun = m[1].length + (line.trimStart().startsWith('- ') ? 2 : 0);
    });
    assert.match(text, /^permissions:\n  contents: read$/m, `${f}: the workflow's default token is read-only`);
    assert.ok(!/softprops\//.test(text), `${f}: no third-party action holds the write token`);
  }
  assert.ok(readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8').includes('github-actions'));
  // upstream projects: commits since the last review are listed, with the file to read them against
  const { sourcesReport, sourcesMarkdown, loadSources } = await import('../tools/vendor.mjs');
  const asked = [];
  const stub = async (url, opts) => {
    asked.push({ url, auth: opts.headers.authorization || '' });
    if (url.includes('meticulous-backend')) return { ok: true, status: 200, json: async () => [{ sha: 'abcdef1234567', commit: { message: 'Rename /api/v1/history/last <b>\n\nbody', committer: { date: '2026-12-01T10:00:00Z' } } }] };
    if (url.includes('Beanconqueror')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => [] };
  };
  const report = await sourcesReport({ fetchImpl: stub, token: '' });
  assert.equal(report.length, loadSources().sources.length);
  assert.ok(asked.every((a) => /^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/commits\?since=\d{4}-\d\d-\d\dT/.test(a.url)), asked[0].url);
  const backend = report.find((r) => r.repo === 'MeticulousHome/meticulous-backend');
  assert.deepEqual(backend.commits, [{ sha: 'abcdef1', date: '2026-12-01', title: 'Rename /api/v1/history/last <b>' }]);
  assert.match(report.find((r) => r.repo === 'graphefruit/Beanconqueror').error, /500/);
  const md = sourcesMarkdown(report);
  assert.ok(md.includes('MeticulousHome/meticulous-backend') && md.includes('js/meticulous.js') && md.includes('abcdef1') && !md.includes('<b>') && md.includes('sources --record'), md);
  assert.ok(sourcesMarkdown(report.map((r) => ({ ...r, commits: [], error: null }))).includes('No changes since the last review'));
  for (const src of loadSources().sources) assert.ok(/^[\w.-]+\/[\w.-]+$/.test(src.repo) && /^\d{4}-\d\d-\d\d$/.test(src.reviewed) && src.what && src.usedIn, src.repo);
});

await test('packaging: tools/package-macos.sh builds the bundle with two Node runtimes (the path that broke the v0.17.0 release build)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'pmb-pkg-'));
  try {
    const tarballs = {};
    for (const arch of ['arm64', 'x64']) {
      const dir = `node-v24.0.0-darwin-${arch}`;
      mkdirSync(join(root, dir, 'bin'), { recursive: true });
      mkdirSync(join(root, dir, 'lib', 'node_modules', 'npm'), { recursive: true });
      writeFileSync(join(root, dir, 'bin', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
      chmodSync(join(root, dir, 'bin', 'node'), 0o755);
      writeFileSync(join(root, dir, 'LICENSE'), 'test');
      writeFileSync(join(root, dir, 'README.md'), 'test');
      tarballs[arch] = join(root, `${dir}.tar.gz`);
      execFileSync('tar', ['-czf', tarballs[arch], '-C', root, dir]);
    }
    const out = join(root, 'dist');
    const log = execFileSync('bash', [new URL('../tools/package-macos.sh', import.meta.url).pathname, '--node-arm64', tarballs.arm64, '--node-x64', tarballs.x64, '--out', out, '--no-zip'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(log, /bundled Node for arm64/);
    assert.match(log, /bundled Node for x64/);
    const app = join(out, 'Portal Met Bridge.app', 'Contents');
    for (const f of ['MacOS/portal-met-bridge', 'Helpers/launcher.sh', 'Helpers/node/arm64/bin/node', 'Helpers/node/x64/bin/node', 'Helpers/node/x64/LICENSE', 'Resources/app/index.html', 'Resources/app/serve.mjs', 'Resources/app/js/main.js', 'Resources/app/vendor/jspdf.umd.min.js', 'Info.plist', 'PkgInfo']) assert.ok(existsSync(join(app, f)), `${f} is in the bundle`);
    assert.ok(!existsSync(join(app, 'Helpers/node/x64/lib')), 'npm and headers are stripped from the bundled runtime');
    assert.ok(statSync(join(app, 'MacOS/portal-met-bridge')).mode & 0o111, 'the main executable is executable');
    const plist = readFileSync(join(app, 'Info.plist'), 'utf8');
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.ok(plist.includes(`<string>${version}</string>`) && plist.includes('org.privaterra.portal-met-bridge'), 'Info.plist carries the version and bundle id');
    assert.ok(!existsSync(join(app, 'Resources/app/tests')) && !existsSync(join(app, 'Resources/app/.git')), 'no tests or git in the bundle');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} test group(s) passed in total${process.exitCode ? ', with failures' : ''}.`);
