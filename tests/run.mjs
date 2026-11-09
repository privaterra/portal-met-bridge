// Run with:  node tests/run.mjs
import assert from 'node:assert/strict';
import { analyzeShot, fitCalibration, predictTds, estimateForShot, buildSegments, evalEcAt } from '../js/analysis.js';
import { buildEnvelope, encodeHandoff, decodeHandoff, encodeForQr, CHUNK, QR_MAX_URL_CHARS } from '../js/beanconqueror.js';
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
