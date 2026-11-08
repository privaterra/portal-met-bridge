// main.js — wires the devices, the recorder, storage, charts and export together.

import { PortalBle, bluetoothSupported } from './portal-ble.js';
import { MeticulousClient, machineSamplesFromSavedShot, normalizeBaseUrl, extractionEndSec, DEFAULT_HOST } from './meticulous.js';
import { MachinePanel } from './machine-panel.js';
import { ShotRecorder } from './recorder.js';
import { Store, coffeeKey } from './store.js';
import { TimeChart, MassChart, CalibrationChart } from './charts.js';
import { analyzeShot, fitCalibration, estimateForShot, extractionYield, predictTds } from './analysis.js';
import { buildEnvelope, encodeHandoff, encodeForQr } from './beanconqueror.js';
import { makeDemoShot } from './demo.js';
import qrcode from '../vendor/qrcode.mjs';

const $ = (id) => document.getElementById(id);

const store = new Store();
const portal = new PortalBle();
let meticulous = null;
const recorder = new ShotRecorder();
const timeChart = new TimeChart($('chart-time'));
const massChart = new MassChart($('chart-mass'));
const calChart = new CalibrationChart($('chart-cal'));
const machinePanel = new MachinePanel($('view-machine'));

function showView(name) {
  for (const v of ['shots', 'machine']) $(`view-${v}`).hidden = v !== name;
  document.querySelectorAll('.view-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  if (name === 'machine') machinePanel.onShown();
  else {
    timeChart.u.setSize({ width: Math.max(320, $('chart-time').clientWidth), height: 320 });
    massChart.u.setSize({ width: Math.max(320, $('chart-mass').clientWidth), height: 300 });
  }
  store.setSetting('view', name);
  try {
    history.replaceState(null, '', '#' + name);
  } catch {
    /* ignore */
  }
}

const state = {
  shots: [],
  selected: null,
  analysis: null,
  fit: null,
  estimate: null,
  liveTimer: null,
  liveDirty: false,
  autoGraphSent: false,
};

// ------------------------------------------------------------------- setup --

async function init() {
  let host = await store.getSetting('meticulousHost', DEFAULT_HOST);
  if (host === 'meticulous.local:8080') host = DEFAULT_HOST; // migrate the v0.1 default
  $('meticulous-host').value = host;
  const view = location.hash === '#machine' ? 'machine' : await store.getSetting('view', 'shots');
  showView(view);
  const ctx = await store.getSetting('context', {});
  $('ctx-bean').value = ctx.beanName ?? '';
  $('ctx-roaster').value = ctx.roaster ?? '';
  $('ctx-dose').value = ctx.doseG ?? '';
  $('ctx-grind').value = ctx.grindSize ?? '';
  $('ctx-grinder').value = ctx.grinderName ?? 'Zerno Z1';
  $('ctx-note').value = ctx.note ?? '';
  $('settle-sec').value = await store.getSetting('settleSec', 6);
  $('lag-sec').value = await store.getSetting('lagSec', 0);
  $('portal-auto-graph').checked = await store.getSetting('autoGraph', true);
  recorder.settleSec = Number($('settle-sec').value) || 6;

  if (!bluetoothSupported()) {
    $('portal-connect').disabled = true;
    $('portal-hint').textContent = window.isSecureContext
      ? 'This browser has no Web Bluetooth. Open this page in Chrome or Edge.'
      : 'Web Bluetooth needs a secure page: open this app at http://localhost (not a file:// path or a LAN address).';
  }

  await refreshShotList();
  if (state.shots.length) selectShot(state.shots[0].id);
  if (await store.getSetting('autoConnectMeticulous', false)) connectMeticulous();
}

// ------------------------------------------------------------- Meticulous --

function connectMeticulous() {
  const host = $('meticulous-host').value;
  let url;
  try {
    url = normalizeBaseUrl(host);
  } catch {
    toast('That address does not look right.', 'error');
    return;
  }
  store.setSetting('meticulousHost', host);
  store.setSetting('autoConnectMeticulous', true);
  if (meticulous) meticulous.disconnect();
  meticulous = new MeticulousClient(url);
  meticulous.addEventListener('state', (e) => {
    const d = e.detail;
    setLink('meticulous', d.state, d.state === 'connected' ? url.replace(/^https?:\/\//, '') : d.state === 'error' ? d.error : d.state);
    $('meticulous-connect').disabled = d.state === 'connected' || d.state === 'connecting';
    $('meticulous-disconnect').disabled = d.state === 'disconnected';
    $('mach-last').disabled = d.state !== 'connected';
    $('shot-refresh').disabled = d.state !== 'connected' || !state.selected;
  });
  meticulous.addEventListener('status', (e) => onStatus(e.detail));
  meticulous.connect();
  machinePanel.attach(meticulous);
  meticulous.ping().then(
    (s) => {
      $('meticulous-hint').textContent = `Machine answered: ${s?.totalSavedShots ?? '?'} saved shots. Recording starts on its own when extraction begins.`;
    },
    () => {
      $('meticulous-hint').textContent = 'No answer on /api/v1. Check the address (the machine serves on port 80) and that this Mac is on the same network.';
    },
  );
}

function disconnectMeticulous() {
  store.setSetting('autoConnectMeticulous', false);
  machinePanel.detach();
  meticulous?.disconnect();
  meticulous = null;
  setLink('meticulous', 'idle', 'not connected');
  $('meticulous-connect').disabled = false;
  $('meticulous-disconnect').disabled = true;
}

function onStatus(s) {
  setText('ro-weight', fmt(s.w, 1));
  setText('ro-flow', fmt(s.f, 2));
  setText('ro-pressure', fmt(s.p, 1));
  if (recorder.isRecording) {
    setText('ro-time', fmt((performance.now() - recorder.wallZero) / 1000, 1));
    setText('ro-stage', s.name || s.state || 'extracting');
  } else {
    setText('ro-stage', s.state || s.name || 'idle');
  }
  recorder.onStatus(s);
}

// ----------------------------------------------------------------- Portal --

portal.addEventListener('state', (e) => {
  const d = e.detail;
  setLink('portal', d.state, d.state === 'connected' ? d.name : d.state === 'lost' ? 'connection lost' : d.state);
  const on = d.state === 'connected';
  $('portal-disconnect').disabled = !on;
  $('portal-show-graph').disabled = !on || !portal.command;
  $('portal-hide-graph').disabled = !on || !portal.command;
  if (!on) {
    setText('ro-ec', '–');
    setText('ro-tout', '–');
  }
});
portal.addEventListener('measurement', (e) => {
  const m = e.detail;
  setText('ro-ec', m.ec.toFixed(3));
  setText('ro-tout', m.tOut.toFixed(1));
  $('portal-detail').textContent = `${portal.device?.name || 'Portal'} · status ${m.status}`;
  recorder.onPortal(m);
});
portal.addEventListener('malformed', (e) => {
  console.warn('Portal notification of unexpected length', e.detail.byteLength);
});

async function connectPortal() {
  try {
    await portal.pick({ acceptAll: $('portal-accept-all').checked });
  } catch (err) {
    if (err?.name === 'NotFoundError') return; // user cancelled the chooser
    toast(err.message || String(err), 'error');
  }
}

// --------------------------------------------------------------- recorder --

recorder.addEventListener('state', (e) => {
  const d = e.detail;
  const ind = $('rec-indicator');
  ind.dataset.state = d.state;
  $('rec-text').textContent = d.state === 'recording' ? 'Recording' : d.state === 'settling' ? 'Pump stopped — catching the last drips' : 'Waiting for a shot';
  $('rec-manual').textContent = d.state === 'idle' ? 'Start recording now' : 'Stop and save';
  if (d.state === 'recording') {
    $('shot-title').textContent = 'Live shot';
    $('shot-sub').textContent = d.shot?.profileName ? `Profile: ${d.shot.profileName}` : '';
    massChart.setAnalysis(null);
    startLiveLoop();
    if (portal.connected && $('portal-auto-graph').checked && !state.autoGraphSent) {
      state.autoGraphSent = true;
      portal.showGraph().catch(() => {});
    }
  }
  if (d.state === 'idle') {
    stopLiveLoop();
    if (state.autoGraphSent) {
      state.autoGraphSent = false;
      if (portal.connected) portal.hideGraph().catch(() => {});
    }
  }
});
recorder.addEventListener('sample', () => {
  state.liveDirty = true;
});
recorder.addEventListener('shot', async (e) => {
  const shot = e.detail;
  if (shot.machine.length + shot.portal.length < 5) {
    toast('Recording was too short to keep.');
    return;
  }
  shot.context = readContext();
  shot.lagSec = Number($('lag-sec').value) || 0;
  recomputeCache(shot);
  await store.putShot(shot);
  await refreshShotList();
  selectShot(shot.id);
  toast(`Saved shot — ${fmt(shot.finalWeightG, 1)} g in ${fmt(shot.durationSec, 1)} s`);
  if (meticulous?.connected && !shot.manual) setTimeout(() => refreshFromMachine(shot.id, true), 4000);
});

function startLiveLoop() {
  stopLiveLoop();
  state.liveTimer = setInterval(() => {
    if (!state.liveDirty || !recorder.shot) return;
    state.liveDirty = false;
    timeChart.setShot(recorder.shot.machine, recorder.shot.portal);
    if (recorder.shot.portal.length > 5 && recorder.shot.machine.length > 5) {
      const a = analyzeShot(recorder.shot.portal, recorder.shot.machine.map((s) => ({ t: s.t, w: s.w })), { lagSec: Number($('lag-sec').value) || 0 });
      if (a.curve?.length) massChart.setAnalysis(a);
    }
  }, 250);
}
function stopLiveLoop() {
  if (state.liveTimer) clearInterval(state.liveTimer);
  state.liveTimer = null;
}

// ------------------------------------------------------------------ shots --

async function refreshShotList() {
  state.shots = await store.listShots();
  const ul = $('shot-list');
  ul.innerHTML = '';
  $('shot-count').textContent = state.shots.length ? `(${state.shots.length})` : '';
  for (const s of state.shots) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    if (s.id === state.selected?.id) li.classList.add('selected');
    const a = s.analysisCache;
    const meanEc = a?.meanEcPerG;
    li.innerHTML = `<span class="when">${fmtDate(s.startedAt)}</span><span class="ec">${Number.isFinite(meanEc) ? meanEc.toFixed(2) : '—'}</span>` +
      `<span class="what">${s.refractometer?.tdsPct ? `<b>TDS ${s.refractometer.tdsPct.toFixed(2)}</b> · ` : ''}${esc(s.context?.beanName || 'no bean')} · ${fmt(s.finalWeightG, 1)} g · ${fmt(s.durationSec, 0)} s${s.source === 'demo' ? ' · demo' : s.source === 'machine' ? ' · machine only' : ''}</span>`;
    li.addEventListener('click', () => selectShot(s.id));
    ul.appendChild(li);
  }
}

async function selectShot(id) {
  const shot = await store.getShot(id);
  if (!shot) return;
  state.selected = shot;
  document.querySelectorAll('.shot-list li').forEach((li) => li.classList.toggle('selected', li.dataset.id === id));
  renderShot();
}

function renderShot() {
  const shot = state.selected;
  const ctx = shot.context || {};
  $('shot-title').textContent = `${fmtDate(shot.startedAt)}${shot.profileName ? ' — ' + shot.profileName : ''}`;
  $('shot-sub').textContent = [
    ctx.beanName,
    ctx.doseG ? `${ctx.doseG} g in` : null,
    `${fmt(shot.finalWeightG, 1)} g out`,
    `${fmt(shot.durationSec, 1)} s`,
    `${shot.machine.length} machine · ${shot.portal.length} Portal samples`,
    shot.machineSource ? 'machine record attached' : null,
  ].filter(Boolean).join(' · ');
  $('shot-delete').disabled = false;
  $('shot-refresh').disabled = !meticulous?.connected;
  for (const id of ['bc-copy', 'bc-open', 'bc-json', 'dl-csv', 'dl-json', 'ref-save']) $(id).disabled = false;
  $('ref-clear').disabled = !shot.refractometer;
  $('ref-tds').value = shot.refractometer?.tdsPct ?? '';
  $('ref-bev').value = shot.refractometer?.beverageG ?? '';
  $('ref-bev').placeholder = fmt(shot.finalWeightG, 1);

  timeChart.setShot(shot.machine, shot.portal);
  const lag = Number.isFinite(shot.lagSec) ? shot.lagSec : Number($('lag-sec').value) || 0;
  state.analysis = analyzeShot(shot.portal, shot.machine.map((s) => ({ t: s.t, w: s.w })), { doseG: Number(ctx.doseG) || 0, lagSec: lag, stopTimeSec: shot.durationSec });
  massChart.setAnalysis(state.analysis);
  renderMetrics(state.analysis);
  renderCalibration();
  renderExport();
  updateRefEy();
}

function renderMetrics(a) {
  const m = $('metrics');
  const cells = [];
  const cell = (v, unit, k) => cells.push(`<div class="metric"><div class="v">${v}<small>${unit}</small></div><div class="k">${k}</div></div>`);
  if (a.status === 'no-portal-data') {
    m.innerHTML = '';
    setStatus('analysis-status', 'No Portal samples in this shot, so there is nothing to integrate. Machine data only.', 'warn');
    return;
  }
  cell(fmt(a.meanEcPerG, 3), 'mS/cm', 'mean EC per gram');
  cell(fmt(a.integralEcG, 1), 'mS·g/cm', '∫EC dm over the cup');
  cell(fmt(a.mainPeakEc, 3), 'mS/cm', `peak EC at ${fmt(a.mainPeakMassG, 1)} g`);
  cell(fmt(a.tail.last5g?.mean, 3), 'mS/cm', 'mean over the last 5 g');
  cell(fmt(a.tail.last5g?.slopePerG, 3), 'mS/cm per g', 'slope over the last 5 g');
  cell(fmt((a.tail.last5g?.share ?? 0) * 100, 0), '%', 'of ∫ from the last 5 g');
  cell(fmt(a.massAt90PctG, 1), 'g', 'cup mass at 90% of ∫');
  cell(fmt(a.coverageRatio * 100, 0), '%', 'of cup mass covered by the Portal');
  cell(fmt(a.firstDropTimeSec, 1), 's', 'first drop');
  cell(fmt(a.meanTempC, 1), '°C', `at the Portal (max ${fmt(a.maxTempC, 1)})`);
  m.innerHTML = cells.join('');
  const level = a.status === 'ok' ? 'ok' : 'warn';
  const msg = a.status === 'ok' ? 'Shot is usable for calibration and estimates.' + (a.reasons.length ? ' ' + a.reasons.join(' ') : '') : a.reasons.join(' ') || a.status;
  setStatus('analysis-status', msg, level);
}

function calibrationPoints(key, excludeId) {
  return state.shots
    .filter((s) => s.coffeeKey === key && s.refractometer?.tdsPct && s.analysisCache && s.id !== excludeId)
    .map((s) => ({ id: s.id, meanEcPerG: s.analysisCache.meanEcPerG, tdsPct: s.refractometer.tdsPct, reliable: s.analysisCache.status === 'ok', meanTempC: s.analysisCache.meanTempC, when: s.startedAt }));
}

function renderCalibration() {
  const shot = state.selected;
  const key = coffeeKey(shot.context?.beanName);
  $('cal-coffee').textContent = shot.context?.beanName || 'this coffee';
  // Each reviewed shot is excluded from its own fit (leave-one-out for the estimate).
  const pts = calibrationPoints(key, shot.id);
  state.fit = fitCalibration(pts);
  const allPts = calibrationPoints(key, null);
  calChart.setFit(allPts, fitCalibration(allPts), predictTds);

  const dl = $('cal-stats');
  const rows = [];
  if (!key) rows.push(['Bean', 'Give this shot a bean name so its reading can be grouped.']);
  rows.push(['Reference shots', `${allPts.length} with refractometer readings${pts.length !== allPts.length ? ` (${pts.length} used; this shot is left out)` : ''}`]);
  if (state.fit.calibrated) {
    const p = state.fit.proportional;
    rows.push(['Proportional k', `${p.k.toFixed(3)} %TDS per (mS/cm) — leave-one-out error ${isFinite(p.loocvRmse) ? '±' + p.loocvRmse.toFixed(2) + '% TDS' : 'n/a'}`]);
    if (state.fit.affine) rows.push(['Affine', `${state.fit.affine.a.toFixed(3)}·x + ${state.fit.affine.b.toFixed(2)} — leave-one-out ±${state.fit.affine.loocvRmse.toFixed(2)}% TDS`]);
    rows.push(['Active model', state.fit.activeModel + (state.fit.preliminary ? ' (preliminary)' : '')]);
    rows.push(['Measured EC/g range', `${state.fit.minX.toFixed(3)} – ${state.fit.maxX.toFixed(3)}`]);
    if (state.fit.tempCorrelation !== null) rows.push(['Residual vs outlet temp', `r = ${state.fit.tempCorrelation.toFixed(2)}`]);
  }
  dl.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  state.estimate = estimateForShot(state.analysis, state.fit, { beverageG: shot.refractometer?.beverageG || shot.finalWeightG, doseG: Number(shot.context?.doseG) || 0 });
  setText('est-tds', Number.isFinite(state.estimate.tdsPct) ? state.estimate.tdsPct.toFixed(2) : '–');
  setText('est-ey', Number.isFinite(state.estimate.eyPct) ? state.estimate.eyPct.toFixed(1) : '–');
  $('est-flags').innerHTML = state.estimate.flags.map((f) => `<li>${esc(f)}</li>`).join('');
}

async function saveRefractometer() {
  const shot = state.selected;
  const tds = Number($('ref-tds').value);
  if (!(tds > 0 && tds < 30)) {
    toast('Enter the refractometer TDS as a percentage, e.g. 9.2.', 'error');
    return;
  }
  const bev = Number($('ref-bev').value) || shot.finalWeightG;
  const dose = Number(shot.context?.doseG) || 0;
  shot.refractometer = { tdsPct: tds, beverageG: bev, eyPct: extractionYield(tds, bev, dose), at: Date.now() };
  shot.analysisCache = summarize(state.analysis);
  await store.putShot(shot);
  await refreshShotList();
  renderShot();
  toast('Reading saved; calibration updated.');
}

async function clearRefractometer() {
  const shot = state.selected;
  delete shot.refractometer;
  await store.putShot(shot);
  await refreshShotList();
  renderShot();
}

function updateRefEy() {
  const shot = state.selected;
  const tds = Number($('ref-tds').value);
  const bev = Number($('ref-bev').value) || shot?.finalWeightG;
  const dose = Number(shot?.context?.doseG) || 0;
  const ey = extractionYield(tds, bev, dose);
  $('ref-ey').textContent = tds > 0 ? (ey ? `→ EY ${ey.toFixed(1)}% at ${dose} g in` : 'Add a dose to get EY') : '';
}

async function deleteShot() {
  const shot = state.selected;
  if (!shot || !confirm('Delete this shot and its readings?')) return;
  await store.deleteShot(shot.id);
  state.selected = null;
  await refreshShotList();
  if (state.shots.length) selectShot(state.shots[0].id);
  else {
    $('shot-title').textContent = 'No shot selected';
    $('shot-sub').textContent = '';
    timeChart.setShot([], []);
    massChart.setAnalysis(null);
    $('metrics').innerHTML = '';
    $('qr').innerHTML = '';
  }
}

/** Keep the numbers the list and calibration need without re-running analysis per shot. */
function summarize(a) {
  if (!a) return null;
  return { status: a.status, meanEcPerG: a.meanEcPerG, integralEcG: a.integralEcG, coverageRatio: a.coverageRatio, mainPeakEc: a.mainPeakEc, meanTempC: a.meanTempC, totalMassG: a.totalMassG };
}

function recomputeCache(shot) {
  const lag = Number.isFinite(shot.lagSec) ? shot.lagSec : 0;
  const a = analyzeShot(shot.portal || [], (shot.machine || []).map((s) => ({ t: s.t, w: s.w })), { doseG: Number(shot.context?.doseG) || 0, lagSec: lag, stopTimeSec: shot.durationSec });
  shot.analysisCache = summarize(a);
  return a;
}

// --------------------------------------------------------- machine record --

async function fetchLastFromMachine() {
  if (!meticulous) return;
  try {
    const saved = await meticulous.lastShot();
    if (!saved) {
      $('mach-info').textContent = 'The machine has no saved shot yet.';
      return;
    }
    const samples = machineSamplesFromSavedShot(saved);
    const startedAt = saved.time * 1000;
    // Attach to a live recording from the same moment, else store as its own entry.
    const match = state.shots.find((s) => s.source === 'live' && Math.abs(s.startedAt - startedAt) < 45000);
    if (match) {
      await attachMachineRecord(match, saved, samples);
      $('mach-info').textContent = `Attached the machine's record to the ${fmtDate(match.startedAt)} shot.`;
      await refreshShotList();
      selectShot(match.id);
    } else {
      if (state.shots.some((s) => s.machineShotId === saved.id)) {
        $('mach-info').textContent = 'That machine shot is already in the list.';
        return;
      }
      const shot = {
        id: 'machine-' + saved.id,
        machineShotId: saved.id,
        startedAt,
        endedAt: startedAt + (samples.at(-1)?.t ?? 0) * 1000,
        profileName: saved.name || saved.profile_name || saved.profile?.name || null,
        profileTemperatureC: saved.profile?.temperature,
        finalWeightG: Math.max(0, ...samples.map((s) => s.w || 0)),
        durationSec: extractionEndSec(samples),
        machine: samples,
        portal: [],
        source: 'machine',
        machineSource: saved,
        context: readContext(),
      };
      await store.putShot(shot);
      await refreshShotList();
      selectShot(shot.id);
      $('mach-info').textContent = 'Added the machine’s last shot (no Portal data).';
    }
  } catch (err) {
    toast('Could not read the machine’s history: ' + (err.message || err), 'error');
  }
}

async function refreshFromMachine(id, quiet = false) {
  if (!meticulous) return;
  const shot = await store.getShot(id);
  if (!shot) return;
  try {
    const saved = await meticulous.lastShot();
    if (saved && Math.abs(saved.time * 1000 - shot.startedAt) < 45000) {
      await attachMachineRecord(shot, saved, machineSamplesFromSavedShot(saved));
      await refreshShotList();
      if (state.selected?.id === id) selectShot(id);
      if (!quiet) toast('Replaced the live machine samples with the machine’s saved record.');
    } else if (!quiet) {
      toast('The machine’s last saved shot is from a different time.');
    }
  } catch (err) {
    if (!quiet) toast('Could not reach the machine: ' + (err.message || err), 'error');
  }
}

async function attachMachineRecord(shot, saved, samples) {
  if (samples.length >= 2) {
    // Live machine samples already use the machine's own time, so no shift is
    // needed. The saved record has no per-sample brew temperature, so carry the
    // live temperature series over by nearest time.
    const live = (shot.machine || []).filter((s) => Number.isFinite(s.t) && Number.isFinite(s.temp));
    if (live.length) {
      let j = 0;
      for (const s of samples) {
        while (j < live.length - 1 && live[j + 1].t <= s.t) j++;
        const a = live[j];
        const b = live[Math.min(j + 1, live.length - 1)];
        s.temp = Math.abs(a.t - s.t) <= Math.abs(b.t - s.t) ? a.temp : b.temp;
      }
    }
    shot.machine = samples;
    shot.finalWeightG = Math.max(shot.finalWeightG || 0, ...samples.map((s) => s.w || 0));
    // The machine's record ends with a "retracting" stage; the extraction proper ends before it.
    shot.durationSec = Math.max(shot.durationSec || 0, extractionEndSec(samples));
  }
  shot.machineShotId = saved.id;
  shot.profileName = saved.profile_name || saved.profile?.name || shot.profileName;
  shot.profileTemperatureC = saved.profile?.temperature ?? shot.profileTemperatureC;
  shot.machineSource = { id: saved.id, time: saved.time, profile: saved.profile ?? null, profile_name: saved.profile_name ?? null };
  recomputeCache(shot);
  await store.putShot(shot);
}

// ----------------------------------------------------------------- export --

async function renderExport() {
  const shot = state.selected;
  const ctx = shot.context || {};
  const qrEl = $('qr');
  qrEl.innerHTML = '';
  $('qr-info').textContent = 'Building…';
  try {
    const qr = await encodeForQr(shot, state.analysis, state.estimate, ctx);
    if (qr) {
      const q = qrcode(0, 'L');
      q.addData(qr.url, 'Byte');
      q.make();
      qrEl.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      const pts = qr.envelope.flow?.t?.length ?? 0;
      $('qr-info').textContent = `${qr.urlChars} characters · ${pts} flow points${qr.envelope.metrics ? ' · ' + qr.envelope.metrics.map((m) => m.name).join(', ') : ''}.`;
    } else {
      $('qr-info').textContent = 'Too large for a QR code; use the link.';
    }
  } catch (err) {
    $('qr-info').textContent = 'QR failed: ' + (err.message || err);
  }
}

async function fullLink() {
  const shot = state.selected;
  const env = buildEnvelope(shot, state.analysis, state.estimate, shot.context || {});
  return { env, ...(await encodeHandoff(env)) };
}

async function copyFullLink() {
  try {
    const { url, urlChars, chunks } = await fullLink();
    await navigator.clipboard.writeText(url);
    toast(`Copied the Beanconqueror link (${urlChars} characters, ${chunks} chunks). Paste it into Notes or Messages and tap it on the phone.`);
  } catch (err) {
    toast('Copy failed: ' + (err.message || err), 'error');
  }
}

async function openLink() {
  const { url } = await fullLink();
  window.location.href = url;
}

async function downloadEnvelope() {
  const { env } = await fullLink();
  download(`beanconqueror-${stamp(state.selected.startedAt)}.json`, JSON.stringify(env, null, 2), 'application/json');
}

function downloadShotJson() {
  const shot = state.selected;
  const out = { ...shot, analysis: state.analysis, estimate: state.estimate };
  download(`portal-shot-${stamp(shot.startedAt)}.json`, JSON.stringify(out, null, 2), 'application/json');
}

function downloadCsv() {
  const shot = state.selected;
  const rows = [['t_s', 'source', 'pressure_bar', 'flow_mls', 'weight_g', 'grav_flow_gs', 'machine_temp_c', 'stage', 'portal_ec_mscm', 'portal_out_temp_c', 'portal_int_temp_c', 'portal_status']];
  for (const s of shot.machine) rows.push([s.t, 'machine', s.p, s.f, s.w, s.g, s.temp, s.status ?? '', '', '', '', '']);
  for (const s of shot.portal) rows.push([s.t, 'portal', '', '', '', '', '', '', s.ec, s.tOut, s.tInt, s.status]);
  rows.sort((a, b) => (a[0] === 't_s' ? -1 : b[0] === 't_s' ? 1 : a[0] - b[0]));
  const csv = rows.map((r) => r.map((v) => (v === undefined || v === null || Number.isNaN(v) ? '' : typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n');
  download(`portal-shot-${stamp(shot.startedAt)}.csv`, csv, 'text/csv');
}

// ------------------------------------------------------------------- demo --

async function addDemoShot() {
  const shot = makeDemoShot({ seed: Math.floor(Math.random() * 1000) });
  shot.context = { ...readContext(), beanName: readContext().beanName || 'Demo coffee' };
  shot.analysisCache = summarize(analyzeShot(shot.portal, shot.machine.map((s) => ({ t: s.t, w: s.w }))));
  await store.putShot(shot);
  await refreshShotList();
  selectShot(shot.id);
}

let replayTimer = null;
function replayDemoLive() {
  if (replayTimer) return;
  const shot = makeDemoShot({ seed: Math.floor(Math.random() * 1000) });
  const speed = 2; // 2× real time
  const t0 = performance.now();
  let mi = 0;
  let pi = 0;
  // one idle status first so the recorder sees extracting rise
  recorder.onStatus({ extracting: false, timeMs: 0, w: 0, f: 0, p: 0, temp: 25, g: 0, name: 'idle', state: 'idle', profile: null, at: t0 });
  replayTimer = setInterval(() => {
    const elapsed = ((performance.now() - t0) / 1000) * speed;
    while (mi < shot.machine.length && shot.machine[mi].t <= elapsed) {
      const s = shot.machine[mi++];
      const extracting = s.t < shot.durationSec;
      onStatus({ extracting, timeMs: Math.round(s.t * 1000), w: s.w, f: s.f, p: s.p, temp: s.temp, g: s.g, name: s.status, state: extracting ? 'brewing' : 'idle', profile: shot.profileName, setpoints: null, at: performance.now() });
    }
    while (pi < shot.portal.length && shot.portal[pi].t <= elapsed) {
      const m = shot.portal[pi++];
      setText('ro-ec', m.ec.toFixed(3));
      setText('ro-tout', m.tOut.toFixed(1));
      recorder.onPortal({ ...m, at: performance.now() });
    }
    if (mi >= shot.machine.length && pi >= shot.portal.length) {
      // final idle status ends the recording through the normal path
      onStatus({ extracting: false, timeMs: -1, w: shot.finalWeightG, f: 0, p: 0, temp: 25, g: 0, name: 'idle', state: 'idle', profile: null, setpoints: null, at: performance.now() });
      clearInterval(replayTimer);
      replayTimer = null;
    }
  }, 50);
  toast('Replaying a synthetic shot at 2× speed.');
}

// --------------------------------------------------------------- context --

function readContext() {
  return {
    beanName: $('ctx-bean').value.trim(),
    roaster: $('ctx-roaster').value.trim(),
    doseG: Number($('ctx-dose').value) || 0,
    grindSize: $('ctx-grind').value ? `${$('ctx-grind').value} µm` : '',
    grinderName: $('ctx-grinder').value.trim(),
    note: $('ctx-note').value.trim(),
  };
}

async function contextChanged() {
  const ctx = readContext();
  await store.setSetting('context', ctx);
  // Apply to the selected shot too, so a bag name typed after the shot still counts.
  if (state.selected && state.selected.source !== 'demo') {
    const prev = state.selected.context || {};
    const changed = ['beanName', 'roaster', 'doseG', 'grindSize', 'grinderName', 'note'].some((k) => (prev[k] ?? '') !== (ctx[k] ?? ''));
    if (changed) {
      state.selected.context = ctx;
      state.selected.analysisCache = summarize(state.analysis);
      await store.putShot(state.selected);
      await refreshShotList();
      renderShot();
    }
  }
}

// ---------------------------------------------------------------- helpers --

function setLink(which, st, detail) {
  const el = $(`link-${which}`);
  el.querySelector('.dot').dataset.state = st;
  $(`${which}-detail`).textContent = detail || st;
}
function setText(id, v) {
  $(id).textContent = v;
}
function setStatus(id, msg, level) {
  const el = $(id);
  el.textContent = msg;
  el.dataset.level = level;
}
const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
let toastTimer = null;
function toast(msg, level = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.level = level;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), level === 'error' ? 7000 : 4500);
}

// ---------------------------------------------------------------- events --

document.querySelectorAll('.view-tab').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('mc-refresh-profiles').addEventListener('click', () => machinePanel.refreshProfiles());
$('mc-refresh-stats').addEventListener('click', () => machinePanel.refreshStats());
$('meticulous-connect').addEventListener('click', connectMeticulous);
$('meticulous-disconnect').addEventListener('click', disconnectMeticulous);
$('portal-connect').addEventListener('click', connectPortal);
$('portal-disconnect').addEventListener('click', () => portal.disconnect());
$('portal-show-graph').addEventListener('click', () => portal.showGraph().then(() => toast('Portal acknowledged the graph-on command.')).catch((e) => toast(e.message, 'error')));
$('portal-hide-graph').addEventListener('click', () => portal.hideGraph().then(() => toast('Portal acknowledged the graph-off command.')).catch((e) => toast(e.message, 'error')));
$('portal-auto-graph').addEventListener('change', (e) => store.setSetting('autoGraph', e.target.checked));
$('rec-manual').addEventListener('click', () => (recorder.isRecording ? recorder.stopManual() : recorder.startManual()));
$('settle-sec').addEventListener('change', (e) => {
  recorder.settleSec = Math.max(0, Number(e.target.value) || 0);
  store.setSetting('settleSec', recorder.settleSec);
});
$('lag-sec').addEventListener('change', async (e) => {
  await store.setSetting('lagSec', Number(e.target.value) || 0);
  if (state.selected) {
    state.selected.lagSec = Number(e.target.value) || 0;
    await store.putShot(state.selected);
    renderShot();
  }
});
for (const id of ['ctx-bean', 'ctx-roaster', 'ctx-dose', 'ctx-grind', 'ctx-grinder', 'ctx-note']) $(id).addEventListener('change', contextChanged);
$('ref-tds').addEventListener('input', updateRefEy);
$('ref-bev').addEventListener('input', updateRefEy);
$('ref-save').addEventListener('click', saveRefractometer);
$('ref-clear').addEventListener('click', clearRefractometer);
$('shot-delete').addEventListener('click', deleteShot);
$('shot-refresh').addEventListener('click', () => state.selected && refreshFromMachine(state.selected.id));
$('mach-last').addEventListener('click', fetchLastFromMachine);
$('bc-copy').addEventListener('click', copyFullLink);
$('bc-open').addEventListener('click', openLink);
$('bc-json').addEventListener('click', downloadEnvelope);
$('dl-csv').addEventListener('click', downloadCsv);
$('dl-json').addEventListener('click', downloadShotJson);
$('demo-load').addEventListener('click', addDemoShot);
$('demo-replay').addEventListener('click', replayDemoLive);
$('backup-export').addEventListener('click', async () => download(`portal-bridge-backup-${stamp(Date.now())}.json`, JSON.stringify(await store.exportAll()), 'application/json'));
$('backup-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const n = await store.importAll(JSON.parse(await file.text()));
    await refreshShotList();
    toast(`Restored ${n} shots.`);
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
  e.target.value = '';
});

// Handy in the console while debugging: window.__pb.state.selected, .massChart.u, ...
window.__pb = { state, store, portal, recorder, timeChart, massChart, calChart, machinePanel, get meticulous() { return meticulous; } };

init().catch((err) => {
  console.error(err);
  toast('Start-up problem: ' + (err.message || err), 'error');
});
