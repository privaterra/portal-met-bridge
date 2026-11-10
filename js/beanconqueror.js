// beanconqueror.js — build and encode a Beanconqueror brew hand-off.
//
// Wire format (from Beanconqueror's docs/brew-import-api.md):
//   beanconqueror://ADD_BREW?len=<payload length>&shareBrew0=<chunk>&shareBrew1=...
//   payload = base64url(gzip(JSON envelope)), unpadded, split into 400-char chunks.
// Works in the browser and in Node ≥ 18 (CompressionStream is global in both).

import { downsample, beverageOf } from './analysis.js?v=0.11.2';

export const CHUNK = 400;
export const MAX_SINGLE_INFLATED = 524_288;
export const MAX_SERIES_POINTS = 10_000;
// A byte-mode QR at error level L holds 2,953 bytes, but anything past ~1,600
// is a version-30+ code that phone cameras struggle to read off a screen.
export const QR_MAX_URL_CHARS = 1_600;

const dg = (g) => Math.round(g * 10); // grams → decigrams, integer

/**
 * Build the hand-off envelope from a recorded shot.
 * @param {object} shot      recorded shot (see recorder.js for the shape)
 * @param {object} analysis  result of analyzeShot()
 * @param {object} estimate  result of estimateForShot() (may have null tds)
 * @param {object} ctx       { beanName, roaster, grinderName, grindSize, doseG, note, rating }
 * @param {object} opts      { maxPoints, includeMetrics }
 */
export function buildEnvelope(shot, analysis, estimate, ctx = {}, opts = {}) {
  const maxPoints = opts.maxPoints ?? MAX_SERIES_POINTS;
  const includeMetrics = opts.includeMetrics ?? ['pressure', 'flow', 'ec', 'portalTemp'];

  const machine = (shot.machine || []).filter((s) => Number.isFinite(s.t));
  const portal = (shot.portal || []).filter((s) => Number.isFinite(s.t) && Number.isFinite(s.ec));
  const durationSec = shot.durationSec ?? (machine.length ? machine[machine.length - 1].t : 0);

  // Flow block: absolute → delta coded. Water in = ∫ flow dt (ml≈g), weight = scale.
  const flowSrc = downsample(machine, maxPoints);
  const t = [];
  const waterDispensed = [];
  const weight = [];
  const temperature = [];
  let prevT = 0;
  let prevWater = 0;
  let prevWeight = 0;
  let cumWater = 0;
  let lastT = null;
  for (const s of machine) {
    // integrate on the full-resolution series so downsampling does not lose water
    if (lastT !== null) cumWater += Math.max(0, s.f ?? 0) * Math.max(0, s.t - lastT);
    lastT = s.t;
    s._cumWater = cumWater;
  }
  for (const s of flowSrc) {
    const ms = Math.max(0, Math.round(s.t * 1000));
    t.push(Math.max(0, ms - prevT));
    prevT = ms;
    const w = dg(Math.max(0, s.w ?? 0));
    const wi = dg(s._cumWater ?? 0);
    weight.push(w - prevWeight);
    waterDispensed.push(wi - prevWater);
    prevWeight = w;
    prevWater = wi;
    temperature.push(round1(s.temp ?? 0));
  }
  const totalWaterMl = round1(cumWater);
  // The cup the user weighed wins, then the profile's target or the machine's scale (Settings → Recording); all are kept on the shot.
  const beverageG = round1(beverageOf(shot) ?? analysis?.totalMassG ?? (machine.length ? Math.max(...machine.map((s) => s.w ?? 0)) : 0));

  const metrics = [];
  const addMetric = (key, name, unit, src, pick) => {
    const pts = downsample(src, maxPoints).filter((s) => Number.isFinite(pick(s)));
    if (pts.length < 2) return;
    metrics.push({
      key,
      name,
      unit,
      kind: 'measured',
      t: pts.map((s) => Math.max(0, Math.round(s.t * 1000))),
      v: pts.map((s) => round3(pick(s))),
    });
  };
  if (includeMetrics.includes('pressure')) addMetric('pressure', 'Pressure', 'bar', machine, (s) => s.p);
  if (includeMetrics.includes('flow')) addMetric('flowRate', 'Flow', 'ml/s', machine, (s) => s.f);
  if (includeMetrics.includes('ec')) addMetric('portalEc', 'Portal EC', 'mS/cm', portal, (s) => s.ec);
  if (includeMetrics.includes('portalTemp')) addMetric('portalTemp', 'Portal outlet temp', '°C', portal, (s) => s.tOut);

  const noteLines = [];
  if (ctx.note) noteLines.push(ctx.note.trim());
  if (analysis && analysis.status !== 'no-portal-data') {
    noteLines.push(`Portal: mean EC ${fmt(analysis.meanEcPerG, 3)} mS/cm over ${fmt(analysis.coveredMassG, 1)} g (∫EC dm = ${fmt(analysis.integralEcG, 1)}), peak ${fmt(analysis.mainPeakEc, 3)}, last-5g ${fmt(analysis.tail?.last5g?.mean, 3)}.`);
  }
  if (estimate && Number.isFinite(estimate.tdsPct)) {
    noteLines.push(`Estimated from EC: TDS ${fmt(estimate.tdsPct, 2)}%, EY ${fmt(estimate.eyPct, 1)}% (${estimate.model} fit${estimate.flags?.length ? '; ' + estimate.flags.join(' ') : ''}). Enter your refractometer reading in the TDS field.`);
  }
  if (shot.refractometer?.tdsPct) noteLines.push(`Refractometer: TDS ${fmt(shot.refractometer.tdsPct, 2)}%.`);

  const envelope = {
    v: 1,
    app: { name: 'portal-met-bridge', version: '0.11.2' },
    brew: {
      date: new Date(shot.startedAt ?? Date.now()).toISOString(),
      waterIn: { value: clamp(totalWaterMl || beverageG, 0, 100000), unit: 'ml' },
      beverageOut: { value: clamp(beverageG, 0, 100000), unit: 'g' },
      brewTime: clamp(round3(durationSec), 0, 86400),
      preparationMethod: 'Meticulous',
      preparationType: 'METICULOUS',
      note: noteLines.join('\n\n').slice(0, 10000),
    },
    imported: {
      source: 'portal-met-bridge',
      sourceName: 'portal-met-bridge (Belka Portal + Meticulous)',
      device: 'Belka Portal',
      schema: 1,
      params: {
        shotId: String(shot.id ?? ''),
        profile: shot.profileName ?? null,
        meanEcPerG: numOrNull(analysis?.meanEcPerG),
        integralEcG: numOrNull(analysis?.integralEcG),
        coverageRatio: numOrNull(analysis?.coverageRatio),
        peakEc: numOrNull(analysis?.mainPeakEc),
        estimatedTdsPct: numOrNull(estimate?.tdsPct),
        estimatedEyPct: numOrNull(estimate?.eyPct),
        refractometerTdsPct: numOrNull(shot.refractometer?.tdsPct),
      },
    },
  };
  if (Number.isFinite(ctx.doseG) && ctx.doseG > 0) envelope.brew.doseIn = { value: clamp(round1(ctx.doseG), 0, 200), unit: 'g' };
  const temp = Number.isFinite(shot.profileTemperatureC) ? shot.profileTemperatureC : meanOf(machine.map((s) => s.temp));
  if (Number.isFinite(temp) && temp > -50 && temp < 250) envelope.brew.temperature = round1(temp);
  if (ctx.grindSize) envelope.brew.grindSize = String(ctx.grindSize).slice(0, 512);
  if (ctx.grinderName) envelope.brew.grinderName = String(ctx.grinderName).slice(0, 512);
  if (Number.isInteger(ctx.rating) && ctx.rating >= 0 && ctx.rating <= 10) envelope.brew.rating = ctx.rating;
  if (Number.isFinite(analysis?.firstDropTimeSec)) envelope.brew.firstDripTime = round3(analysis.firstDropTimeSec);
  if (ctx.beanName) {
    envelope.bean = { name: String(ctx.beanName).slice(0, 512) };
    if (ctx.roaster) envelope.bean.roaster = String(ctx.roaster).slice(0, 512);
  }
  if (t.length >= 2) {
    envelope.flow = {
      fidelity: flowSrc.length === machine.length ? 'full' : 'downsampled',
      t,
      waterDispensed,
      weight,
      temperature,
    };
  }
  if (metrics.length) envelope.metrics = metrics;
  return envelope;
}

/** gzip + base64url (unpadded). */
export async function encodePayload(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > MAX_SINGLE_INFLATED) throw new Error(`Envelope is ${bytes.length} bytes; Beanconqueror accepts at most ${MAX_SINGLE_INFLATED}.`);
  const gz = await pipeThrough(bytes, new CompressionStream('gzip'));
  return { payload: base64url(gz), jsonBytes: bytes.length, gzipBytes: gz.length };
}

export function buildUrl(payload, intent = 'ADD_BREW') {
  const parts = [`len=${payload.length}`];
  for (let i = 0, n = 0; i < payload.length; i += CHUNK, n++) parts.push(`shareBrew${n}=${payload.slice(i, i + CHUNK)}`);
  return `beanconqueror://${intent}?${parts.join('&')}`;
}

/** Convenience: envelope → URL with size diagnostics. */
export async function encodeHandoff(envelope) {
  const { payload, jsonBytes, gzipBytes } = await encodePayload(envelope);
  const url = buildUrl(payload);
  return { url, payload, jsonBytes, gzipBytes, chunks: Math.ceil(payload.length / CHUNK), urlChars: url.length };
}

/**
 * Produce a URL small enough for a QR code by progressively thinning the
 * envelope. Returns { url, envelope, level } or null if even the bare brew
 * does not fit (it always should).
 */
export async function encodeForQr(shot, analysis, estimate, ctx) {
  const ladders = [
    { maxPoints: 40, includeMetrics: ['ec', 'pressure'] },
    { maxPoints: 30, includeMetrics: ['ec', 'pressure'] },
    { maxPoints: 30, includeMetrics: ['ec'] },
    { maxPoints: 20, includeMetrics: ['ec'] },
    { maxPoints: 12, includeMetrics: [] },
    { maxPoints: 2, includeMetrics: [] },
  ];
  for (const level of ladders) {
    const env = buildEnvelope(shot, analysis, estimate, ctx, level);
    const enc = await encodeHandoff(env);
    if (enc.urlChars <= QR_MAX_URL_CHARS) return { ...enc, envelope: env, level };
  }
  return null;
}

/** Decoder mirroring Beanconqueror's rules — used by the tests and the preview. */
export async function decodeHandoff(url) {
  const q = url.indexOf('?');
  if (q < 0) throw new Error('No query string');
  const scheme = url.slice(0, q);
  if (scheme !== 'beanconqueror://ADD_BREW' && scheme !== 'beanconqueror://ADD_BREWS') throw new Error('Unknown intent ' + scheme);
  const params = new URLSearchParams(url.slice(q + 1));
  const len = params.get('len');
  if (!/^\d+$/.test(len ?? '')) throw new Error('Bad len');
  const chunks = [];
  for (const [k, v] of params) {
    const m = /^shareBrew(\d+)$/.exec(k);
    if (!m) continue;
    if (v.length > CHUNK) throw new Error(`Chunk ${k} exceeds ${CHUNK} chars`);
    chunks[Number(m[1])] = v;
  }
  if (!chunks.length || chunks.length > 1024) throw new Error('Bad chunk count');
  for (let i = 0; i < chunks.length; i++) if (chunks[i] === undefined) throw new Error(`Missing chunk ${i}`);
  const payload = chunks.join('');
  if (payload.length !== Number(len)) throw new Error('len mismatch');
  if (!/^[A-Za-z0-9_-]*$/.test(payload) || payload.length % 4 === 1) throw new Error('Bad base64url');
  const bytes = fromBase64url(payload);
  const inflated = await pipeThrough(bytes, new DecompressionStream('gzip'));
  if (inflated.length > MAX_SINGLE_INFLATED) throw new Error('Inflated payload too large');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inflated));
}

// ------------------------------------------------------------------ helpers --

async function pipeThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function base64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const round1 = (x) => Math.round(x * 10) / 10;
const round3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const numOrNull = (x) => (Number.isFinite(x) ? round3(x) : null);
const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '–');
function meanOf(arr) {
  const v = arr.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}
