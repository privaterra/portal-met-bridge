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
  // every shell step parses (bash -n) and every github-script step is valid JavaScript. The v0.19.0 tag carried
  // `version=""$(…)"` in release.yml's tag check: one stray quote, a syntax error only the macOS runner would have met.
  const { spawnSync } = await import('node:child_process');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  let shellSteps = 0;
  let scriptSteps = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
    const lines = readFileSync(new URL(f, dir), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)(?:- )?(run|script):\s*(.*)$/);
      if (!m) continue;
      const keyIndent = m[1].length + (lines[i].trimStart().startsWith('- ') ? 2 : 0);
      let body = m[3];
      if (/^[|>][+-]?\s*$/.test(body)) {
        const block = [];
        for (let j = i + 1; j < lines.length; j++) {
          const indent = lines[j].search(/\S/);
          if (indent >= 0 && indent <= keyIndent) break;
          block.push(lines[j]);
        }
        const pad = Math.min(...block.filter((l) => l.trim()).map((l) => l.search(/\S/)));
        body = block.map((l) => l.slice(pad)).join('\n');
      }
      body = body.replace(/\$\{\{[^}]*\}\}/g, 'x'); // an expression is replaced by its value before the step runs
      if (m[2] === 'run') {
        const r = spawnSync('bash', ['-n'], { input: body, encoding: 'utf8' });
        assert.equal(r.status, 0, `${f}:${i + 1} the shell step does not parse — ${(r.stderr || '').trim().split('\n')[0]}`);
        shellSteps++;
      } else {
        assert.doesNotThrow(() => new AsyncFunction('github', 'context', 'core', 'require', body), `${f}:${i + 1} the github-script step is not valid JavaScript`);
        scriptSteps++;
      }
    }
  }
  assert.ok(shellSteps >= 20, `the check read the workflows' steps (${shellSteps} shell, ${scriptSteps} script)`);
  // the release can be rebuilt for an existing tag on another runner when Apple-silicon runners are short
  const releaseYml = readFileSync(new URL('release.yml', dir), 'utf8');
  assert.match(releaseYml, /runs-on: \$\{\{ inputs\.runner \|\| 'macos-latest' \}\}/, 'the macOS job runs on the chosen runner, macos-latest by default');
  assert.match(releaseYml, /options: \[macos-latest, macos-26-intel, macos-15-intel\]/, 'an Intel runner can be chosen by hand');
  // …and falls back to the other pool by itself when the first job never met a runner (v0.19.0 and v0.19.1 both did not)
  assert.match(releaseYml, /outputs:\n\s+started: \$\{\{ steps\.started\.outputs\.started \}\}/, 'the macOS job reports that a runner started it');
  assert.match(releaseYml, /steps: &macos_steps\n\s+- name: A runner picked this job up\n\s+id: started\n\s+run: echo "started=true" >> "\$GITHUB_OUTPUT"/, 'its first step sets the marker');
  const otherPool = releaseYml.slice(releaseYml.indexOf('\n  macos-other-pool:'));
  assert.ok(otherPool.length > 100 && /needs: \[test, dependencies, macos\]/.test(otherPool), 'a second job waits for the first');
  assert.match(otherPool, /if: \$\{\{ always\(\) && needs\.test\.result == 'success' && needs\.dependencies\.result == 'success' && needs\.macos\.result != 'success' && needs\.macos\.result != 'skipped' && needs\.macos\.outputs\.started != 'true' \}\}/, 'it runs only when the first never started');
  assert.match(otherPool, /runs-on: \$\{\{ endsWith\(inputs\.runner, '-intel'\) && 'macos-latest' \|\| 'macos-26-intel' \}\}/, 'on the other runner pool');
  assert.match(otherPool, /env: \*macos_env\n\s+steps: \*macos_steps\n/, 'with the same steps');
  assert.ok(!/^\s*<<:/m.test(releaseYml), 'no YAML merge keys: Actions does not support them');
  assert.match(releaseYml, /name: macos-\$\{\{ runner\.arch \}\}/, 'each job uploads its artifact under its own name');
  assert.match(releaseYml, /contents\/docs\/releases\/\$tag\.md\?ref=\$GITHUB_SHA/, 'release notes come from the commit the workflow runs from');
  assert.match(releaseYml, /isDraft[^\n]*\n[^\n]*\n\s+gh release edit "\$TAG" --title "\$TITLE" --notes-file notes\.md/, 'a draft gets its notes refreshed on a re-run');
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

// ------------------------------------------------------------------ v0.20 --
const community = await import('../js/community.js');
const maintenance = await import('../js/maintenance.js');
const reviewMod = await import('../js/review.js');
const aiMod = await import('../js/ai.js');
const exportMod = await import('../js/export.js');

await test('Meticulous Community (v0.20): matches are parsed and picked with care, topics follow origin and process, profiles can be left out', () => {
  const { parseMatches, pickMatch, parseTopics, topicFor, stripProfiles, sourceOf, isFilterBrew, communityMode, communityConnector, communitySubjects } = community;
  const found = parseMatches('# Coffee matches for "Gesha"\n\n- **\\[Pre-Order\\] Uba \\| Special Edition Gesha** (Origin Coffee Roasters · Colombia · Washed): id `481792c8`, https://community.meticuloushome.com/coffee/481792c8\n- **Supernova** (Hatch · Ethiopia · Natural): id `aa11`, https://community.meticuloushome.com/coffee/aa11\n- **Supernova** (Somebody Else · Kenya · Washed): id `bb22`, https://community.meticuloushome.com/coffee/bb22\nnot a match line\n- **Evil** (x): id `zz`, http://plain.example/x\n');
  assert.equal(found.length, 3, 'only well-formed https lines');
  assert.equal(found[0].name, '[Pre-Order] Uba | Special Edition Gesha', 'Markdown escapes removed');
  assert.equal(pickMatch(found, 'Supernova', { roaster: 'Hatch Coffee Roasters' }).id, 'aa11', 'the roaster settles which Supernova');
  assert.equal(pickMatch(found, 'Supernova', { roaster: 'Nobody Known' }), null, 'a contradicting roaster means no match');
  assert.equal(pickMatch(found, 'Gesha'), null, 'one generic word of a long name is not a match');
  assert.equal(pickMatch(found, 'Uba Special Edition Gesha').id, '481792c8');
  assert.equal(pickMatch(parseMatches('- **SEY** (United States): id `b4`, https://community.meticuloushome.com/roasters/sey\n'), 'Sey Coffee', { kind: 'roaster' }).id, 'b4', '"Coffee", "Roasters" and the like are ignored in a roaster name');
  assert.equal(pickMatch(parseMatches('- **Niche Zero** (Niche): id `n0`, https://community.meticuloushome.com/grinders/niche-zero\n'), 'Zerno Z1', { kind: 'grinder' }), null);
  assert.equal(parseMatches('No grinder matches "x" in Meticulous Community.').length, 0);
  const topics = parseTopics('# Espresso topics\n\n## Topics\n\n- `light-roast-espresso`: Light roast espresso\n\n## Origins\n\n- `ethiopia`: Ethiopia\n- `costa-rica`: Costa Rica\n- `colombia`: Colombia\n\n## Processes\n\n- `washed-coffee`: Washed\n- `natural-coffee`: Natural\n\n## Origins by process\n\n- `washed-ethiopia`: Washed Ethiopian\n');
  assert.equal(topics.all.length, 7);
  assert.equal(topicFor({ origin: 'Ethiopia, Guji', process: 'washed' }, topics), 'washed-ethiopia');
  assert.equal(topicFor({ origin: 'Costa Rica — Tarrazú', process: 'honey' }, topics), 'costa-rica', 'no honey-costa-rica here: the origin alone');
  assert.equal(topicFor({ origin: 'Yemen', process: 'natural' }, topics), 'natural-coffee', 'unknown origin: the process');
  assert.equal(topicFor({ origin: 'Yemen', process: '', roastLevel: 'light' }, topics), 'light-roast-espresso', 'else the roast level');
  assert.equal(topicFor({ origin: 'Yemen' }, topics), null);
  assert.equal(topicFor({ origin: 'Colombia' }, { all: [], sections: {} }), null);
  const answer = '# How?\n\nTypical loved recipe: Dose 18 g\n\n## Which profile style do owners love?\n\nLever Style: 1:3\n\n- **Lever**: x\n\nLoved profiles: McQueen Shot, Low Contact.\n\nRoasters owners loved here: SEY.\n\n**Which profile style do owners love?** Lever.\n\n---\n\nSource: [Meticulous Community](https://community.meticuloushome.com/espresso/washed-ethiopia). Cite it.';
  const noProfiles = stripProfiles(answer);
  assert.ok(!/profile/i.test(noProfiles.replace(/Source:.*/s, '')) && /Typical loved recipe/.test(noProfiles) && /Roasters owners loved/.test(noProfiles) && /Source: \[Meticulous Community\]/.test(noProfiles), noProfiles);
  assert.equal(sourceOf(answer), 'https://community.meticuloushome.com/espresso/washed-ethiopia');
  assert.equal(sourceOf('Source: [x](https://evil.example/)'), '', 'only Community links count as a source');
  assert.ok(isFilterBrew({ profile: 'V60 pour-over', ratio: 2 }) && isFilterBrew({ profile: 'x', ratio: 15 }) && !isFilterBrew({ profile: 'Blooming Espresso', ratio: 2.2 }));
  // how it reaches the model
  assert.equal(communityMode('anthropic'), 'connector', 'Claude: its own connector');
  assert.equal(communityMode('openai'), 'app');
  assert.equal(communityMode('xai'), 'app');
  assert.equal(communityMode('google'), 'app');
  assert.equal(communityMode('anthropic', { via: 'app' }), 'app');
  assert.equal(communityMode('openai', { via: 'mention' }), 'mention');
  assert.equal(communityMode('anthropic', { enabled: false }), 'off');
  assert.deepEqual(communityConnector().configs, {}, 'everything on: no tool is disabled');
  assert.deepEqual(communityConnector({ grinder: false, pourOver: false, profiles: false }).configs, { grinder_guide: { enabled: false }, pour_over_guide: { enabled: false } }, 'a kind switched off disables its tool; search stays');
  assert.equal(communityConnector().url, 'https://community.meticuloushome.com/api/mcp');
  // one subject per coffee, filled in across the shots
  const subj = communitySubjects([{ meta: { coffee: { bean: 'Supernova' }, grinder: 'Zerno Z1' } }, { meta: { coffee: { bean: 'supernova', roaster: 'Hatch', origin: 'Ethiopia', process: 'natural' }, grinder: 'zerno z1' } }], { beanUrls: { supernova: 'https://hatch.example/supernova' } });
  assert.equal(subj.coffees.length, 1);
  assert.deepEqual([subj.coffees[0].roaster, subj.coffees[0].origin, subj.coffees[0].url], ['Hatch', 'Ethiopia', 'https://hatch.example/supernova']);
  assert.deepEqual([subj.roasters, subj.grinders], [['Hatch'], ['Zerno Z1']]);
});

await test('Meticulous Community (v0.20): the app\'s lookups ask by name only, tolerate failures, and the prompt names Community the way each assistant wants', async () => {
  const { gatherCommunity, mcpCall, communityInstructions, communityMention, communityBlock, communityHow } = community;
  const calls = [];
  const SRC = (p) => `\n\n---\n\nSource: [Meticulous Community](https://community.meticuloushome.com/${p}). Cite it.`;
  const server = (down = false) => async (url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push({ url, ...rpc.params });
    if (down) return new Response('down', { status: 503 });
    const { name, arguments: a } = rpc.params;
    const reply = (text, isError) => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (name === 'search_community') return a.kind === 'coffee' && /supernova/i.test(a.query) ? reply('- **Supernova** (Hatch · Ethiopia · Natural): id `c1`, https://community.meticuloushome.com/coffee/c1\n') : a.kind === 'roaster' ? reply('- **Hatch** (Canada): id `r1`, https://community.meticuloushome.com/roasters/hatch\n') : reply(`No ${a.kind} matches "${a.query}" in Meticulous Community.`);
    if (name === 'how_to_brew_coffee') return a.coffee === 'https://hatch.example/unknown' ? reply('No coffee for that page.', true) : reply(`# Supernova\n\nDose 18 g · Ratio 1:2.2\n\nLoved profiles: Mock Bloom.${SRC('coffee/c1')}`);
    if (name === 'how_to_brew_roaster') return reply(`# Hatch\n\nRatio 1:2–2.5${SRC('roasters/hatch')}`);
    if (name === 'espresso_guide') return a.topic ? reply(`# ${a.topic}\n\n88–91 °C${SRC(`espresso/${a.topic}`)}`) : reply('## Origins\n\n- `ethiopia`: Ethiopia\n\n## Origins by process\n\n- `natural-ethiopia`: Natural Ethiopian\n');
    if (name === 'pour_over_guide') return reply(`# All filter coffee\n\n1:16${SRC('pour-over')}`);
    return reply('unknown', true);
  };
  const subjects = { coffees: [{ bean: 'Supernova', roaster: 'Hatch', origin: 'Ethiopia', process: 'natural', roastLevel: 'light', url: 'https://hatch.example/unknown', filter: false }], roasters: ['Hatch'], grinders: ['Zerno Z1'] };
  const cache = new Map();
  const r = await gatherCommunity(subjects, { fetchImpl: server(), url: 'https://c.example/api/mcp', cache });
  assert.deepEqual(r.items.map((x) => x.title), ['Coffee — Supernova', 'Espresso guide — natural-ethiopia', 'Roaster — Hatch']);
  assert.deepEqual(r.notes, ['Grinder “Zerno Z1” was not found on Meticulous Community.']);
  assert.equal(r.items[0].source, 'https://community.meticuloushome.com/coffee/c1');
  assert.deepEqual(calls.map((c) => c.name), ['how_to_brew_coffee', 'search_community', 'how_to_brew_coffee', 'espresso_guide', 'espresso_guide', 'search_community', 'how_to_brew_roaster', 'search_community'], 'the bean\'s own page first, then search → answer; the guide by topic');
  assert.ok(calls.every((c) => c.url === 'https://c.example/api/mcp' && JSON.stringify(c.arguments).length < 80), 'names and topics only');
  assert.equal(calls[4].arguments.topic, 'natural-ethiopia');
  const before = calls.length;
  const again = await gatherCommunity(subjects, { fetchImpl: server(), cache });
  assert.equal(again.items.length, 3);
  assert.equal(calls.length - before, 1, 'answers are cached for the session; only the lookup that failed is tried again');
  // a kind switched off is not asked for; profiles can be cut from the answers; a filter brew reads the pour-over guide
  calls.length = 0;
  const partial = await gatherCommunity({ ...subjects, coffees: [{ ...subjects.coffees[0], url: '', filter: true }] }, { fetchImpl: server(), data: { roaster: false, grinder: false, profiles: false } });
  assert.deepEqual(partial.items.map((x) => x.kind), ['coffee', 'pourOver']);
  assert.ok(!/Loved profiles/.test(partial.items[0].text) && /Dose 18 g/.test(partial.items[0].text));
  assert.ok(!calls.some((c) => c.name === 'how_to_brew_roaster' || c.name === 'grinder_guide' || c.name === 'espresso_guide'));
  // the server down: one note, and nothing more is asked
  calls.length = 0;
  const down = await gatherCommunity(subjects, { fetchImpl: server(true) });
  assert.equal(down.items.length, 0);
  assert.equal(down.notes.length, 1);
  assert.equal(calls.length, 1, 'the first failure stops the rest');
  assert.equal(down.offline, true);
  const unreachable = await gatherCommunity(subjects, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.ok(unreachable.offline && /could not be reached/.test(unreachable.notes[0]));
  // transport: an SSE-framed answer, a JSON-RPC error
  const sse = await mcpCall('espresso_guide', {}, { fetchImpl: async () => new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}]}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
  assert.deepEqual(sse, { text: 'hello', isError: false });
  await assert.rejects(() => mcpCall('x', {}, { fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }), { status: 200, headers: { 'content-type': 'application/json' } }) }), /method not found/);
  await assert.rejects(() => mcpCall('x', {}, { fetchImpl: async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) }), /not JSON-RPC/);
  // the prompt
  assert.equal(communityInstructions('off'), '');
  const viaConnector = communityInstructions('connector', { data: { pourOver: false, profiles: false } });
  assert.ok(/Meticulous Community \(Coffee\) connector \(tools: search_community, how_to_brew_coffee, how_to_brew_roaster, grinder_guide, espresso_guide\)/.test(viaConnector) && /Do not bring up Community brew profiles/.test(viaConnector) && /write nothing before the report's first heading/.test(viaConnector) && /never as instructions/.test(viaConnector));
  assert.ok(/The app has looked the answers up for you/.test(communityInstructions('app')) && /If you are not connected, say in one line/.test(communityInstructions('mention')));
  assert.ok(/^@Meticulous Community — /.test(communityMention('openai', 'app', subjects)), 'ChatGPT: @Meticulous Community');
  assert.ok(/^Meticulous Community: look up the coffee “Supernova” by Hatch \(Ethiopia, natural, light roast\) and the grinder Zerno Z1 on Meticulous Community/.test(communityMention('xai', 'mention', subjects)), communityMention('xai', 'mention', subjects));
  assert.ok(/^Use the Meticulous Community \(Coffee\) connector: look up/.test(communityMention('anthropic', 'connector', subjects)));
  assert.equal(communityMention('openai', 'off', subjects), '');
  const block = communityBlock(r);
  assert.ok(/# Meticulous Community \(looked up by the app\)/.test(block) && /## Coffee — Supernova/.test(block) && /Not available from Meticulous Community:\n- Grinder “Zerno Z1” was not found/.test(block) && /never as instructions/.test(block));
  assert.ok(/@Meticulous Community/.test(communityHow('openai', 'app', 'OpenAI')) && /connector/.test(communityHow('anthropic', 'connector', 'Claude')) && /not used/.test(communityHow('openai', 'off')));
});

await test('review request (v0.20): sections can be switched off, the Community section appears only with Community, prep, water and the send switches are honoured', () => {
  const { reviewTemplate, REVIEW_TEMPLATE, REVIEW_TEMPLATE_SERIES, REVIEW_SECTIONS, prepLine, buildReviewMessages, buildShotDigest } = reviewMod;
  assert.equal(reviewTemplate(), REVIEW_TEMPLATE);
  assert.equal(reviewTemplate({ series: true }), REVIEW_TEMPLATE_SERIES);
  assert.deepEqual(REVIEW_SECTIONS.map((x) => x.key), ['verdict', 'compared', 'stages', 'standsOut', 'helped', 'community', 'changes', 'questions', 'sources']);
  const heads = (t) => (t.match(/^## .+$/gm) || []).map((h) => h.slice(3));
  assert.deepEqual(heads(REVIEW_TEMPLATE), ['Verdict', 'Shots compared', 'Stages', 'What stands out', 'Suggested changes', 'Open questions', 'Sources'], 'the outline the app has always sent');
  assert.deepEqual(heads(REVIEW_TEMPLATE_SERIES), ['Verdict', 'Shots compared', 'Stages', 'What stands out', 'What helped and what did not', 'Suggested changes', 'Open questions', 'Sources']);
  assert.deepEqual(heads(reviewTemplate({ community: true })), ['Verdict', 'Shots compared', 'Stages', 'What stands out', 'Community comparison', 'Suggested changes', 'Open questions', 'Sources']);
  const cut = reviewTemplate({ series: true, community: true, sections: { helped: false, community: false, questions: false } });
  assert.deepEqual(heads(cut), ['Verdict', 'Shots compared', 'Stages', 'What stands out', 'Suggested changes', 'Sources']);
  assert.ok(/Left out by the user: "What helped and what did not", "Community comparison", "Open questions" — do not write those sections/.test(cut));
  assert.ok(!/Left out by the user/.test(reviewTemplate({ sections: { community: false } })), 'the Community section is not "left out" when Community is not in use');
  assert.ok(!/^Rating:/m.test(reviewTemplate({ rating: false })) && /^Rating:/m.test(REVIEW_TEMPLATE));
  assert.equal(prepLine(null), '');
  const line = prepLine({ rdt: true, wdt: true, distribution: true, screen: false, tamper: true, singleDose: true });
  assert.ok(/the user uses a single-dose grinder.*; RDT \(Ross Droplet Technique.*; WDT \(Weiss Distribution Technique.*; a distribution tool.*; a tamper\. Not used: Filter screen\./.test(line), line);
  assert.ok(/none of the usual steps are used/.test(prepLine({ rdt: false, wdt: false, distribution: false, screen: false, tamper: false, singleDose: false })));
  const demo = makeDemoShot({ seed: 4 });
  const shot = { ...demo, id: 's1', startedAt: Date.UTC(2026, 10, 9, 9, 0), profileName: 'Blooming Espresso', rating: 4, comment: 'sweet', water: 'Third Wave Water', context: { beanName: 'Supernova', doseG: 18, grindSize: '420 µm' } };
  const d = buildShotDigest(shot, analyzeShot(shot.portal, shot.machine.map((m) => ({ t: m.t, w: m.w })), { doseG: 18 }));
  assert.equal(d.meta.water, 'Third Wave Water', 'the water noted on the shot is in its digest');
  const profile = { name: 'Blooming Espresso', stages: [] };
  const plain = buildReviewMessages([{ digest: d, profile }], {});
  assert.ok(!/Meticulous Community/.test(plain.system + plain.user) && !/Puck preparation|Water the user brews with/.test(plain.user), 'nothing new unless asked for');
  const full = buildReviewMessages([{ digest: d, profile }], { prep: { rdt: true, screen: false }, water: 'BWT tap', community: { instructions: 'COMMUNITY-RULES', mention: '@Meticulous Community — look it up', block: '\n# Meticulous Community (looked up by the app)\n\nDATA' }, sections: { questions: false } });
  assert.ok(full.user.startsWith('# Review request\n@Meticulous Community — look it up\nShots to review: 1'), full.user.slice(0, 120));
  assert.ok(/Puck preparation.*RDT.*Not used: Filter screen/.test(full.user) && /Water the user brews with: BWT tap\./.test(full.user));
  assert.ok(full.user.trimEnd().endsWith('DATA'), 'the Community answers close the request');
  assert.ok(full.system.includes('COMMUNITY-RULES') && /## Community comparison/.test(full.system) && !/## Open questions/.test(full.system));
  assert.ok(full.system.indexOf('COMMUNITY-RULES') < full.system.indexOf('## Verdict'), 'Community rules come before the outline');
  const lean = buildReviewMessages([{ digest: d, profile }], { send: { profile: false, trace: false, rating: false } });
  assert.ok(/Brewed profile: not sent in full/.test(lean.user) && /the one-row-per-second trace is not sent/.test(lean.user) && !/Trace resampled/.test(lean.user) && !/"stages":\[\]\}/.test(lean.user.split('Brewed profile')[1] || ''));
  assert.ok(/"rating":null/.test(lean.user) && !/sweet/.test(lean.user) && !/^Rating:/m.test(lean.system), 'the rating and comment are not sent, and the rule about them is dropped');
  assert.ok(/"rating":4/.test(plain.user) && /sweet/.test(plain.user));
});

await test('AI providers (v0.20): Grok speaks the chat API, Claude can carry the Community connector, a paused tool loop and tool calls are recognised', async () => {
  const { PROVIDERS: P, buildRequest: build, finishFromEvent: fin, finishFromResponse: finR, toolFromEvent, isConnectorRejection, streamCompletion: stream, normalizeModelList: norm, ANTHROPIC_MCP_BETA } = aiMod;
  const opts = { model: 'm', key: 'k', system: 'S', user: 'U', maxTokens: 10 };
  const x = build('xai', opts);
  assert.equal(x.url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(x.headers.authorization, 'Bearer k');
  assert.deepEqual(x.body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(aiMod.deltaFromEvent('xai', JSON.stringify({ choices: [{ delta: { content: 'Yo' } }] })), 'Yo');
  assert.equal(fin('xai', JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })), 'length');
  assert.deepEqual(norm('xai', { data: [{ id: 'grok-4', created: 2 }, { id: 'grok-imagine-image', created: 3 }] }).map((m) => m.id), ['grok-4']);
  assert.ok(P.xai.label === 'Grok (xAI)' && P.xai.defaultModel);
  // the connector
  const plain = build('anthropic', opts);
  assert.ok(!('mcp_servers' in plain.body) && !('tools' in plain.body) && !('anthropic-beta' in plain.headers), 'no connector unless asked for');
  const c = build('anthropic', { ...opts, mcp: { name: 'meticulous-community', url: 'https://community.meticuloushome.com/api/mcp', configs: { grinder_guide: { enabled: false } } } });
  assert.equal(c.headers['anthropic-beta'], ANTHROPIC_MCP_BETA);
  assert.deepEqual(c.body.mcp_servers, [{ type: 'url', url: 'https://community.meticuloushome.com/api/mcp', name: 'meticulous-community' }]);
  assert.deepEqual(c.body.tools, [{ type: 'mcp_toolset', mcp_server_name: 'meticulous-community', configs: { grinder_guide: { enabled: false } } }]);
  assert.ok(!('configs' in build('anthropic', { ...opts, mcp: { name: 'n', url: 'https://x.example/mcp', configs: {} } }).body.tools[0]));
  assert.ok(!('mcp_servers' in build('openai', { ...opts, mcp: { name: 'n', url: 'https://x.example/mcp' } }).body), 'other providers ignore it');
  assert.equal(fin('anthropic', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'pause_turn' } })), 'paused');
  assert.equal(fin('anthropic', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })), 'stop');
  assert.equal(finR('anthropic', { stop_reason: 'pause_turn' }), 'paused');
  assert.deepEqual(toolFromEvent('anthropic', JSON.stringify({ type: 'content_block_start', content_block: { type: 'mcp_tool_use', name: 'search_community', server_name: 'meticulous-community' } })), { name: 'search_community', server: 'meticulous-community' });
  assert.deepEqual(toolFromEvent('anthropic', JSON.stringify({ type: 'content_block_start', content_block: { type: 'mcp_tool_result', is_error: true } })), { error: true });
  assert.equal(toolFromEvent('anthropic', JSON.stringify({ type: 'content_block_start', content_block: { type: 'text' } })), null);
  assert.equal(toolFromEvent('openai', '{}'), null);
  assert.ok(isConnectorRejection(400, 'mcp_servers: Extra inputs are not permitted') && isConnectorRejection(400, 'Unexpected value(s) `mcp-client-2025-11-20` for the `anthropic-beta` header') && !isConnectorRejection(401, 'mcp') && !isConnectorRejection(400, 'messages: text content blocks must be non-empty'));
  // a stream with a tool call in the middle: the text is the report, the call is reported
  const events = [
    { type: 'content_block_start', content_block: { type: 'mcp_tool_use', name: 'how_to_brew_coffee', server_name: 'meticulous-community' } },
    { type: 'content_block_start', content_block: { type: 'mcp_tool_result', is_error: false } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '## Verdict\n' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Clean.' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  const sent = [];
  const tools = [];
  let finish = null;
  const text = await stream('anthropic', { ...opts, mcp: { name: 'meticulous-community', url: 'https://community.meticuloushome.com/api/mcp' } }, { fetchImpl: async (url, init) => { sent.push({ headers: init.headers, body: JSON.parse(init.body) }); return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }); }, onTool: (t) => tools.push(t.name), onFinish: (f) => (finish = f) });
  assert.equal(text, '## Verdict\nClean.');
  assert.deepEqual(tools, ['how_to_brew_coffee']);
  assert.equal(finish, 'stop');
  assert.ok(sent[0].headers['anthropic-beta'] && sent[0].body.mcp_servers.length === 1 && sent[0].body.stream === true);
});

await test('cleaning & maintenance (v0.20): the schedule, the dates, the reminder that follows them', () => {
  const { MAINTENANCE_TASKS, MAINTENANCE_ROUTINE, MAINTENANCE_SOURCE, cleanMaintenanceLog, recordMaintenance, undoMaintenance, mergeMaintenanceLogs, addInterval, taskStatus, maintenanceStatus, maintenanceReminder, daysText, calendarDays } = maintenance;
  assert.deepEqual(MAINTENANCE_TASKS.map((t) => `${t.id}:${t.name}`), ['weekly:Internal cleaning', 'monthly:Chamber cleaning', 'deep:Deep cleaning'], 'the weekly, monthly and three-monthly jobs — not the per-shot and daily routine');
  assert.deepEqual(MAINTENANCE_TASKS.map((t) => t.every), [{ days: 7 }, { months: 1 }, { months: 3 }]);
  assert.ok(MAINTENANCE_ROUTINE.length === 2 && MAINTENANCE_SOURCE.url === 'https://meticuloushome.com/pages/maintenance-and-repairs');
  assert.ok(MAINTENANCE_TASKS.every((t) => t.steps.length >= 2 && t.warnings.length));
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
  assert.equal(addInterval(at(2026, 1, 31), { months: 1 }), at(2026, 2, 28), 'a month after 31 January is the end of February');
  assert.equal(addInterval(at(2026, 11, 14), { months: 3 }), at(2027, 2, 14));
  assert.equal(addInterval(at(2026, 11, 14), { days: 7 }), at(2026, 11, 21));
  assert.equal(calendarDays(at(2026, 11, 14, 23), at(2026, 11, 15, 1)), 1);
  assert.deepEqual([daysText(0), daysText(1), daysText(7), daysText(-1), daysText(-9)], ['today', 'tomorrow', 'in 7 days', 'yesterday', '9 days ago']);
  const now = at(2026, 11, 14);
  // storage: bounded, newest first, nothing from the future, junk dropped
  assert.deepEqual(cleanMaintenanceLog({ weekly: [5, 'x', now, now, now + 10 * 86400000, -1], evil: [1], monthly: 'no' }, { now }), { weekly: [now, 5], monthly: [], deep: [] });
  let log = cleanMaintenanceLog(null, { now });
  assert.equal(maintenanceStatus(log, { now }).allNever, true);
  assert.ok(/No cleaning dates entered yet/.test(maintenanceReminder(log, { now }).text) && maintenanceReminder(log, { now }).state === 'never');
  log = recordMaintenance(log, 'weekly', now, { now });
  const shots = [{ startedAt: now - 3600000 }, { startedAt: now + 60000 }, { startedAt: now + 120000 }, { startedAt: now + 180000, source: 'demo' }, { startedAt: now + 200000, inProgress: true }];
  const later = now + 3 * 86400000;
  const w = taskStatus(MAINTENANCE_TASKS[0], log, { now: later, shots });
  assert.deepEqual([w.state, w.dueInDays, w.brewsSince, w.dueAt], ['ok', 4, 2, at(2026, 11, 21)], 'brews since it was done are counted (not demo shots, not a recording in progress)');
  assert.equal(taskStatus(MAINTENANCE_TASKS[0], log, { now: now + 6.5 * 86400000 }).state, 'soon');
  assert.equal(taskStatus(MAINTENANCE_TASKS[0], log, { now: now + 8 * 86400000 }).state, 'due');
  const r1 = maintenanceReminder(log, { now, shots });
  assert.ok(/^Next: Internal cleaning — due in 7 days/.test(r1.text) && /No date yet for: chamber cleaning, deep cleaning\./.test(r1.text) && r1.state === 'ok', r1.text);
  log = recordMaintenance(log, 'monthly', at(2026, 10, 1), { now });
  const r2 = maintenanceReminder(log, { now, shots });
  assert.ok(/^Overdue: Chamber cleaning — it was due 13 days ago/.test(r2.text) && r2.state === 'due', r2.text);
  // a deep cleaning covers the smaller jobs
  log = recordMaintenance(log, 'deep', now, { now });
  const st = maintenanceStatus(log, { now });
  assert.deepEqual(st.tasks.map((t) => `${t.id}:${t.state}:${t.coveredBy || '-'}`), ['weekly:ok:-', 'monthly:ok:deep', 'deep:ok:-']);
  assert.equal(st.next.id, 'weekly');
  assert.equal(st.tasks[1].dueAt, at(2026, 12, 14));
  assert.deepEqual(undoMaintenance(log, 'deep', { now }).deep, []);
  assert.equal(recordMaintenance(log, 'nope', now, { now }).weekly.length, 1, 'an unknown job changes nothing');
  assert.deepEqual(mergeMaintenanceLogs({ weekly: [now] }, { weekly: [now, 5], deep: [7] }, { now }), { weekly: [now, 5], monthly: [], deep: [7] }, 'a backup merges: every date of both, once');
});

await test('piston check (v0.20): after a brew the piston must have travelled and come to rest; problems are named', () => {
  const { PistonMonitor, pistonSummary, cleanPistonResult } = maintenance;
  const run = (mon, steps) => {
    let res = null;
    for (const [t, st, pos, extra] of steps) {
      if (pos !== undefined && pos !== null) mon.onSensors({ m_pos: pos, m_pwr: st.extracting ? 25 : 0, motor_temp: 30 + (st.extracting ? 2 : 0) }, t * 1000);
      if (extra?.note) mon.onNotification(extra.note);
      res = mon.onStatus({ p: st.extracting ? 8.5 : 0, ...st }, t * 1000) || res;
    }
    return res;
  };
  const idle = { name: 'idle', state: 'idle', extracting: false };
  const brew = { name: 'Extract', state: 'brewing', extracting: true };
  const retract = { name: 'retracting', state: 'brewing', extracting: false };
  // a normal brew: out with the stroke, retract, back at rest
  const steps = [[0, idle, 0], [1, idle, 0]];
  for (let t = 2; t <= 30; t++) steps.push([t, brew, (t - 2) * 1.5]);
  for (let t = 31; t <= 36; t++) steps.push([t, retract, Math.max(0, 42 - (t - 30) * 8)]);
  for (let t = 37; t <= 45; t++) steps.push([t, idle, 0]);
  const ok = run(new PistonMonitor(), steps);
  assert.ok(ok && ok.ok && ok.returned && ok.posReported && ok.sawRetract && !ok.parkedElsewhere, JSON.stringify(ok));
  assert.deepEqual([ok.brewSec, ok.travel, ok.peakPressureBar, ok.motorPowerMaxPct, ok.motorTempMaxC], [29, 42, 8.5, 25, 32]);
  assert.ok(/^All operating OK — the piston travelled its stroke, retracted and was at rest (\d+ s|right) after the brew\.$/.test(ok.summary), ok.summary);
  // the page joined mid-brew: there is no rest position to compare with, a piston that has stopped is at rest
  const joined = run(new PistonMonitor(), [...steps.slice(10, 31), ...Array.from({ length: 8 }, (_, i) => [31 + i, idle, 3])]);
  assert.ok(joined && joined.ok && joined.returned, JSON.stringify(joined));
  // the piston never stops moving and the machine never goes idle
  const stuck = run(new PistonMonitor({ returnTimeoutSec: 20 }), [...steps.slice(0, 31), ...Array.from({ length: 25 }, (_, i) => [31 + i, retract, 40 + (i % 2) * 5])]);
  assert.ok(stuck && !stuck.ok && !stuck.returned && /had not gone back to idle 2\d s after the brew ended/.test(stuck.problems[0]), JSON.stringify(stuck));
  assert.ok(/^Check the piston:/.test(stuck.summary));
  const moving = run(new PistonMonitor({ returnTimeoutSec: 20 }), [...steps.slice(0, 31), ...Array.from({ length: 25 }, (_, i) => [31 + i, idle, 40 + (i % 2) * 5])]);
  assert.ok(moving && !moving.ok && /The piston was still moving/.test(moving.problems[0]), JSON.stringify(moving));
  // a firmware that reports no position: judged by the machine going back to idle
  const blind = run(new PistonMonitor(), [[0, idle], ...Array.from({ length: 20 }, (_, i) => [1 + i, brew]), [22, retract], [24, idle]]);
  assert.ok(blind && blind.ok && !blind.posReported && blind.travel === null && /does not report the piston's position/.test(blind.summary), JSON.stringify(blind));
  // a machine notification about the motor during the brew is a problem; a flicker of "extracting" is not a brew
  const noted = run(new PistonMonitor(), [...steps.slice(0, 20), [20.5, brew, 28, { note: { message: 'Motor error: stall detected <b>' } }], ...steps.slice(20)]);
  assert.ok(noted && !noted.ok && /The machine reported: Motor error: stall detected/.test(noted.problems.join(' ')), JSON.stringify(noted));
  assert.equal(run(new PistonMonitor(), [[0, idle, 0], [1, brew, 1], [2, idle, 0], [6, idle, 0]]), null);
  // a new brew before the check finished
  const m = new PistonMonitor();
  const first = run(m, [...steps.slice(0, 31), [31, retract, 20], [32, brew, 2]]);
  assert.ok(first && first.interrupted && first.ok && m.phase === 'brewing');
  // what is stored is brought back to plain fields
  const cleaned = cleanPistonResult({ ...ok, problems: ['x'.repeat(900), 5, null], summary: '<img>', extra: { nested: true } });
  assert.ok(cleaned.problems.length === 1 && cleaned.problems[0].length === 300 && !('extra' in cleaned) && cleaned.summary === pistonSummary(cleaned));
  assert.equal(cleanPistonResult('nope'), null);
});

await test('heating graph (v0.20): the CSV has one row per reading with the state, the profile and its target; Settings is made of folding sections', () => {
  const csv = exportMod.heatingCsv([
    { t: 12.34, wall: Date.UTC(2026, 10, 14, 13, 0, 0), ext1: 102.94, ext2: 103.4, barUp: 84, barMid: 88.1, barDown: 85.1, tube: 86.3, motor: 29.3, status: 91.26, target: 93, ready: false, heater: 55.4, motorPower: 0, motorPos: 0, state: 'brewing', stage: 'heating', profile: '=cmd|x' },
    { t: 13, wall: NaN, ext1: null, status: 93.01, target: 93, ready: true, state: 'brewing', stage: 'click to start', profile: 'Blooming, "Espresso"' },
  ]).split('\n');
  assert.equal(csv[0], exportMod.HEATING_COLUMNS.join(','));
  assert.equal(csv[1], "2026-11-14T13:00:00.000Z,12.3,102.9,103.4,84,88.1,85.1,86.3,29.3,91.3,93,no,55.4,0,0,brewing,heating,'=cmd|x", 'rounded; a formula-looking profile name is defused');
  assert.equal(csv[2], ',13,,,,,,,,93,93,yes,,,,brewing,click to start,"Blooming, ""Espresso"""');
  // the page: every settings section folds, in the order asked for, with the options where they were moved to
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const sections = [...html.matchAll(/<details class="set-section" data-section="([a-z]+)">\s*<summary class="panel-head"><h2>([^<]+)<\/h2>/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(sections, ['machine:Machine', 'heating:Heating', 'recording:Recording', 'files:Files and folders', 'estimates:Estimates', 'refractometer:Refractometer', 'ai:AI review', 'prep:Brew Prep.', 'backup:Backup and restore', 'logging:Logging and debug', 'startover:Start over', 'about:About']);
  const within = (id, section) => { const a = html.indexOf(`data-section="${section}"`); const b = html.indexOf('</details>\n      </section>', a); const i = html.indexOf(`id="${id}"`); return i > a && i < b; };
  assert.ok(within('set-heat-rule', 'heating') && within('set-heat-save', 'heating') && !within('set-heat-rule', 'machine'), 'Ready to brew moved to Heating');
  assert.ok(within('list-roaster', 'prep') && within('set-prep-rdt', 'prep') && within('set-water', 'prep'), 'Pick-lists, Grind Prep and Water under Brew Prep.');
  assert.ok(within('set-community', 'ai') && within('set-sec-verdict', 'ai') && within('set-ai-edit-query', 'ai') && within('set-maintenance', 'machine'));
  assert.ok(within('refcal-start', 'refractometer') && within('ref-guide', 'refractometer') && within('ref-history', 'refractometer') && within('set-ref-window', 'refractometer'), 'Refractometer: portal calibration, detail and history (v0.21)');
  const refHeads = html.slice(html.indexOf('data-section="refractometer"'), html.indexOf('data-section="ai"')).match(/<h3>[^<]+<\/h3>/g).map((h) => h.replace(/<\/?h3>/g, ''));
  assert.deepEqual(refHeads, ['Portal calibration', 'Detail', 'History']);
  const checked = (id) => new RegExp(`id="${id}"[^>]*\\bchecked\\b`).test(html);
  assert.deepEqual(['set-prep-rdt', 'set-prep-wdt', 'set-prep-distribution', 'set-prep-screen', 'set-prep-tamper', 'set-prep-single-dose'].map(checked), [true, true, true, false, true, true], 'Grind Prep defaults');
  assert.ok(checked('set-community') && ['coffee', 'roaster', 'grinder', 'espresso', 'pourover', 'profiles'].every((k) => checked(`set-community-${k}`)) && !checked('set-heat-save') && !checked('set-ai-edit-query'));
  // every setting main.js binds has its input in the page
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const bound = [...main.slice(main.indexOf('const SETTINGS = {'), main.indexOf('const settings = {};')).matchAll(/el: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(bound.length > 70 && bound.every((id) => html.includes(`id="${id}"`)), bound.filter((id) => !html.includes(`id="${id}"`)).join(','));
});

// ------------------------------------------------------------------ v0.21 --
const refr = await import('../js/refractometer.js');

await test('refractometer (v0.21): a calibration follows a brew — which brew counts, the reading that is stored, what it does to the coffee\'s calibration', () => {
  const { calibrationCandidate, shotEndedAt, averageReadings, buildReading, editReading, calibrationImpact, impactText, CALIBRATION_WINDOW_MIN, REFRACTOMETER_GUIDE, ZERO_WITH } = refr;
  const now = Date.UTC(2026, 10, 14, 15, 0, 0);
  const min = 60000;
  const brew = (over = {}) => ({ id: 'b1', startedAt: now - 5 * min, durationSec: 30, portal: Array.from({ length: 200 }, (_, i) => ({ t: i / 8, ec: 2 })), analysisCache: { status: 'ok', meanEcPerG: 0.94, coverageRatio: 1 }, context: { beanName: 'Supernova', doseG: 18 }, ...over });
  assert.equal(CALIBRATION_WINDOW_MIN, 30);
  assert.equal(shotEndedAt(brew()), now - 5 * min + 30000);
  assert.equal(shotEndedAt({ startedAt: 1000, endedAt: 9000, durationSec: 30 }), 9000);
  // which brew counts
  assert.equal(calibrationCandidate([], { now }).state, 'none');
  const ready = calibrationCandidate([brew({ id: 'old', startedAt: now - 3 * 3600000 }), brew()], { now });
  assert.deepEqual([ready.state, ready.shot.id, Math.round(ready.ageMin * 10) / 10, Math.round(ready.leftMin * 10) / 10, ready.hasReading], ['ready', 'b1', 4.5, 25.5, false], 'the newest finished brew, inside the window');
  assert.equal(calibrationCandidate([brew()], { now, recording: true }).state, 'recording');
  assert.equal(calibrationCandidate([brew({ startedAt: now - 45 * min })], { now }).state, 'old', 'past the window: brew again');
  assert.equal(calibrationCandidate([brew({ startedAt: now - 45 * min })], { now, windowMin: 60 }).state, 'ready', 'the window is a setting');
  assert.equal(calibrationCandidate([brew({ portal: [] })], { now }).state, 'no-portal');
  assert.equal(calibrationCandidate([brew({ analysisCache: { status: 'ok', meanEcPerG: 0 } })], { now }).state, 'no-portal', 'no conductivity, nothing to calibrate');
  assert.equal(calibrationCandidate([brew({ analysisCache: { status: 'low-coverage', meanEcPerG: 0.9 } })], { now }).state, 'poor-portal');
  assert.equal(calibrationCandidate([brew(), brew({ id: 'live', startedAt: now, inProgress: true })], { now }).shot.id, 'b1', 'a recording in progress is not a brew yet');
  assert.equal(calibrationCandidate([brew({ refractometer: { tdsPct: 9.1 } })], { now }).hasReading, true);
  // the readings
  assert.deepEqual(averageReadings(['9.20', '9.24', '']), { n: 2, mean: 9.22, spread: 0.04, values: [9.2, 9.24], steady: true });
  assert.equal(averageReadings([9.2, 9.5, 9.3]).steady, false, 'more than 0.1 apart: the sample was still settling');
  assert.deepEqual(averageReadings(['', 'abc', 0, -1, 31]), { n: 0, mean: null, spread: null, values: [], steady: true });
  // what is stored: flat, bounded
  const reading = buildReading({ readings: [9.2, 9.24, 9.22], beverageG: 38, doseG: 18, zeroWith: 'distilled', zeroedAt: now - min, filtered: true, note: '  Atago  PAL-COFFEE \n <b>x</b> ' + 'y'.repeat(400), at: now, meanEcPerG: 0.94123 });
  assert.deepEqual({ ...reading, note: undefined }, { tdsPct: 9.22, eyPct: (9.22 * 38) / 18, at: now, method: 'guided', tds1: 9.2, tds2: 9.24, tds3: 9.22, zeroWith: 'distilled', zeroedAt: now - min, filtered: true, meanEcPerG: 0.9412, note: undefined });
  assert.ok(reading.note.startsWith('Atago PAL-COFFEE <b>x</b> y') && reading.note.length === 300, 'the note is one bounded line (it is escaped where it is shown)');
  assert.ok(Object.values(reading).every((v) => ['number', 'string', 'boolean'].includes(typeof v)), 'flat: a restored backup keeps every field');
  assert.equal(buildReading({ readings: [] }), null);
  assert.equal(buildReading({ tdsPct: 45 }), null);
  const typed = buildReading({ tdsPct: 9.1, beverageG: 40, doseG: 18, method: 'typed', zeroWith: 'bogus', at: now });
  assert.deepEqual(typed, { tdsPct: 9.1, eyPct: (9.1 * 40) / 18, at: now, method: 'typed' });
  // an edit keeps what was recorded, except readings that no longer add up
  const sameTds = editReading(reading, { tdsPct: 9.22, beverageG: 40, doseG: 18, note: 'weighed again' });
  assert.deepEqual([sameTds.tds1, sameTds.tds3, sameTds.zeroWith, sameTds.filtered, sameTds.method, sameTds.note, sameTds.at], [9.2, 9.22, 'distilled', true, 'guided', 'weighed again', now]);
  assert.equal(sameTds.eyPct, (9.22 * 40) / 18);
  const changed = editReading(reading, { tdsPct: 9.5, beverageG: 38, doseG: 18, zeroWith: '', filtered: false, at: now + min });
  assert.ok(!('tds1' in changed) && !('zeroWith' in changed) && !('filtered' in changed) && changed.tdsPct === 9.5 && changed.at === now + min);
  assert.equal(editReading(reading, { tdsPct: 0 }), null);
  assert.equal(editReading(undefined, { tdsPct: 9, beverageG: 38, doseG: 18 }).method, 'typed');
  // what one more reading does to the coffee's calibration
  const coffee = { coffeeKey: 'supernova', roasterKey: 'hatch', roastLevel: 'light' };
  const pts = [0.9, 1.0, 1.1, 1.2].map((x, i) => ({ id: `p${i}`, meanEcPerG: x, tdsPct: 9.6 * x, reliable: true, coffeeKey: 'supernova' })).concat([{ id: 'other', meanEcPerG: 1, tdsPct: 5, reliable: true, coffeeKey: 'another coffee' }]);
  const first = calibrationImpact([], coffee, { id: 'n', meanEcPerG: 0.94, tdsPct: 9.22 });
  assert.deepEqual([first.before.calibrated, first.after.calibrated, first.after.shots, first.after.k, first.ratio, first.estimateBefore, first.after.preliminary], [false, true, 1, 9.8085, 9.8085, null, true], 'the first reading of a coffee gives a preliminary k');
  assert.ok(/^Supernova: k = 9\.809 % TDS per mS\/cm from 1 paired brew \(the first reading\) — preliminary\.$/.test(impactText(first, 'Supernova')), impactText(first, 'Supernova'));
  const fifth = calibrationImpact(pts, coffee, { id: 'n', meanEcPerG: 1.05, tdsPct: 10.3 }, { minShots: 5 });
  assert.deepEqual([fifth.before.shots, fifth.after.shots, fifth.before.k, fifth.after.preliminary, fifth.estimateBefore, fifth.errorBefore], [4, 5, 9.6, false, 10.08, -0.22], 'other coffees do not count; the estimate before is the old fit at this EC');
  assert.ok(fifth.after.k > 9.6 && fifth.after.k < 9.81 && /from 5 paired brews \(was 9\.600 from 4\)/.test(impactText(fifth)) && /would have estimated 10\.08 % TDS for the brew \(−0\.22\)/.test(impactText(fifth)), impactText(fifth));
  assert.equal(calibrationImpact([...pts, { id: 'n', meanEcPerG: 2, tdsPct: 3, coffeeKey: 'supernova' }], coffee, { id: 'n', meanEcPerG: 1.05, tdsPct: 10.3 }).before.shots, 4, 'the brew being calibrated is never part of its own "before"');
  const poor = calibrationImpact([], coffee, { id: 'n', meanEcPerG: 0.94, tdsPct: 9.22, reliable: false });
  assert.ok(!poor.after.calibrated && /not good enough to calibrate with/.test(impactText(poor)), 'a brew the Portal covered poorly is left out of the fit');
  // the procedure is the same text for the Detail section and the guided steps
  assert.deepEqual(REFRACTOMETER_GUIDE.map((g) => g.id), ['brew', 'zero', 'sample', 'calibrate']);
  assert.ok(REFRACTOMETER_GUIDE.every((g) => g.title && g.text && g.points.length >= 3) && /follows a brew/.test(REFRACTOMETER_GUIDE[0].text) && /distilled/i.test(REFRACTOMETER_GUIDE[1].points.join(' ')) && /Stir the cup/.test(REFRACTOMETER_GUIDE[2].points[0]));
  // written for the DiFluid R2 Extract (its own guide), with general steps for any other refractometer
  const { REFRACTOMETERS, GUIDES, refractometerGuide, refractometerOf, netWater, netTds } = refr;
  assert.equal(REFRACTOMETER_GUIDE, GUIDES.r2extract);
  assert.deepEqual([REFRACTOMETERS.r2extract.name, REFRACTOMETERS.r2extract.defaultZero, REFRACTOMETERS.other.defaultZero], ['DiFluid R2 Extract', 'brewing', 'distilled']);
  assert.ok(/range 0–30 % TDS · accuracy ±0\.03 %/.test(REFRACTOMETERS.r2extract.specs) && REFRACTOMETERS.r2extract.guideUrl.startsWith('https://digitizefluid.com/'));
  const r2 = GUIDES.r2extract.map((g) => g.points.join(' ')).join(' ');
  assert.ok(/hold the second press until the screen says Zeroing/.test(r2) && /Zero Failed/.test(r2) && /0\.00 %/.test(r2) && /brewing water is the simple choice/.test(r2) && /between 5 and 40 °C/.test(r2) && /5–10 seconds/.test(r2) && /fresh sample each time/.test(r2) && /paper filter/.test(r2), 'the R2 Extract\'s own procedure');
  assert.equal(GUIDES.r2extract[1].title, 'Zero the R2 Extract');
  assert.deepEqual(refractometerGuide('other').map((g) => g.id), ['brew', 'zero', 'sample', 'calibrate']);
  assert.ok(/press Zero/.test(refractometerGuide('other')[1].points.join(' ')) && refractometerGuide('nonsense') === GUIDES.r2extract && refractometerOf('nonsense') === REFRACTOMETERS.r2extract);
  // a distilled-water zero leaves the brewing water's own minerals in the reading: they are subtracted
  assert.deepEqual([netWater('distilled', '0.03'), netWater('brewing', 0.03), netWater('distilled', 2), netWater('distilled', ''), netWater('none', 0.03)], [0.03, 0, 0, 0, 0], 'only after a distilled zero, and only a plausible water reading');
  assert.deepEqual([netTds(9.22, 0.03), netTds(9.22, 0), netTds('9.2')], [9.19, 9.22, 9.2]);
  const net = buildReading({ readings: [9.2, 9.24, 9.22], beverageG: 38, doseG: 18, zeroWith: 'distilled', waterTdsPct: '0.03', device: 'DiFluid R2 Extract', at: now });
  assert.deepEqual([net.tdsPct, net.waterTdsPct, net.device, net.tds1, net.tds3, net.eyPct], [9.19, 0.03, 'DiFluid R2 Extract', 9.2, 9.22, (9.19 * 38) / 18], 'the stored TDS is the coffee\'s; the readings and the water\'s are kept beside it');
  assert.ok(!('waterTdsPct' in buildReading({ readings: [9.2], beverageG: 38, doseG: 18, zeroWith: 'brewing', waterTdsPct: 0.03, at: now })), 'a brewing-water zero has already taken it out');
  assert.equal(buildReading({ readings: [0.02], zeroWith: 'distilled', waterTdsPct: 0.05 }), null, 'water reading above the coffee\'s: no reading');
  assert.ok(!('waterTdsPct' in editReading(net, { tdsPct: 9.4, beverageG: 38, doseG: 18 })) && editReading(net, { tdsPct: 9.19, beverageG: 38, doseG: 18 }).waterTdsPct === 0.03 && editReading(net, { tdsPct: 9.4 }).device === 'DiFluid R2 Extract');
  assert.deepEqual(Object.keys(ZERO_WITH), ['distilled', 'brewing', 'none']);
});

await test('refractometer (v0.21): the history lists every reading with what was recorded, and each coffee\'s calibration', () => {
  const { readingRows, coffeeCalibrations } = refr;
  const t = Date.UTC(2026, 10, 10, 9, 0, 0);
  const day = 86400000;
  const shot = (id, i, over = {}) => ({ id, startedAt: t + i * day, durationSec: 30, finalWeightG: 40, profileName: 'Blooming Espresso', context: { beanName: 'Supernova', roaster: 'Hatch', doseG: 18 }, analysisCache: { status: 'ok', meanEcPerG: Math.round((0.9 + i * 0.05) * 100) / 100 }, coffeeKey: 'supernova', ...over });
  setBeveragePreference('scale');
  const shots = [
    shot('a', 0, { refractometer: { tdsPct: 8.7, at: t + 600000 } }),
    shot('b', 1, { refractometer: { tdsPct: 9.2, at: t + day + 600000, method: 'guided', tds1: 9.18, tds2: 9.22, zeroWith: 'distilled', zeroedAt: t + day + 300000, filtered: true, waterTdsPct: 0.03, device: 'DiFluid R2 Extract', note: '<img src=x onerror=alert(1)>' } }),
    shot('c', 2),
    shot('d', 3, { beverageG: 37.5, analysisCache: { status: 'low-coverage', meanEcPerG: 1.0 }, refractometer: { tdsPct: 9.6, at: t + 3 * day + 600000 } }),
    shot('e', 4, { portal: [], analysisCache: null, context: { beanName: 'Machine only', doseG: 0 }, coffeeKey: 'machine only', refractometer: { tdsPct: 8, at: t + 4 * day } }),
    shot('f', 5, { inProgress: true, refractometer: { tdsPct: 9 } }),
    shot('g', 6, { source: 'demo', context: { beanName: 'Demo coffee', doseG: 18 }, coffeeKey: 'demo coffee', refractometer: { tdsPct: 9.9, at: t + 6 * day, zeroWith: '<script>' } }),
  ];
  const rows = readingRows(shots);
  assert.deepEqual(rows.map((r) => r.id), ['g', 'e', 'd', 'b', 'a'], 'newest calibration first; brews without a reading and recordings in progress are not listed');
  const b = rows.find((r) => r.id === 'b');
  const a0 = () => rows.find((r) => r.id === 'a');
  assert.deepEqual([b.tdsPct, b.readings, b.spread, b.method, b.zeroWith, b.zeroedAt, b.filtered, b.beverageG, b.doseG, b.meanEcPerG, b.ratio, b.portalOk, b.bean, b.profile], [9.2, [9.18, 9.22], 0.04, 'guided', 'distilled', t + day + 300000, true, 40, 18, 0.95, 9.6842, true, 'Supernova', 'Blooming Espresso']);
  assert.deepEqual([b.device, b.waterTdsPct, a0().device, a0().waterTdsPct], ['DiFluid R2 Extract', 0.03, '', null], 'the refractometer and the water reading subtracted are listed when recorded');
  assert.equal(b.eyPct, (9.2 * 40) / 18);
  assert.equal(b.note, '<img src=x onerror=alert(1)>', 'kept as text; the page escapes it');
  const a = rows.find((r) => r.id === 'a');
  assert.deepEqual([a.method, a.zeroWith, a.readings, a.spread, a.filtered], ['typed', '', [], null, false], 'a reading from before v0.21 is "typed"');
  const d = rows.find((r) => r.id === 'd');
  assert.deepEqual([d.beverageG, d.portalOk], [37.5, false], 'the weighed cup is used; a poorly covered brew is marked');
  const e = rows.find((r) => r.id === 'e');
  assert.deepEqual([e.meanEcPerG, e.ratio, e.eyPct, e.doseG], [null, null, null, null], 'a reading on a brew without Portal data is listed but calibrates nothing');
  assert.deepEqual([rows[0].demo, rows[0].zeroWith], [true, ''], 'an unknown "zeroed with" is dropped');
  // each coffee's calibration, from the same points the estimate uses
  const points = shots.filter((s) => s.refractometer && s.analysisCache?.meanEcPerG > 0 && !s.inProgress).map((s) => ({ id: s.id, meanEcPerG: s.analysisCache.meanEcPerG, tdsPct: s.refractometer.tdsPct, reliable: s.analysisCache.status === 'ok', coffeeKey: s.coffeeKey, beanName: s.context.beanName }));
  const coffees = coffeeCalibrations(points, rows, { minShots: 5 });
  assert.deepEqual(coffees.map((c) => c.name), ['Demo coffee', 'Supernova'], 'most recently calibrated first');
  const sn = coffees[1];
  assert.deepEqual([sn.readings, sn.shots, sn.calibrated, sn.preliminary, sn.model, sn.lastAt, sn.minX, sn.maxX], [3, 2, true, true, 'proportional', t + 3 * day + 600000, 0.9, 0.95], 'three readings, two used (one brew was poorly covered)');
  assert.ok(Math.abs(sn.k - (0.9 * 8.7 + 0.95 * 9.2) / (0.9 * 0.9 + 0.95 * 0.95)) < 1e-3);
  assert.deepEqual(coffeeCalibrations([], []), []);
  setBeveragePreference('profile');
});

console.log(`\n${passed} test group(s) passed in total${process.exitCode ? ', with failures' : ''}.`);
