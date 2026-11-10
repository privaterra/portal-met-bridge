// main.js — wires the devices, the recorder, storage, charts and export together.

import { PortalBle, bluetoothSupported, environmentCheck, STEPS } from './portal-ble.js?v=0.11.1';
import { MeticulousClient, machineSamplesFromSavedShot, normalizeBaseUrl, extractionEndSec, DEFAULT_HOST } from './meticulous.js?v=0.11.1';
import { MachinePanel } from './machine-panel.js?v=0.11.1';
import { ShotRecorder, finalizeCheckpoint } from './recorder.js?v=0.11.1';
import { Store, coffeeKey, deleteAllDatabases, LIST_KINDS } from './store.js?v=0.11.1';
import { TimeChart, MassChart, CalibrationChart, CompareChart, COMPARE_COLORS } from './charts.js?v=0.11.1';
import { analyzeShot, fitCalibration, fitForCoffee, estimateForShot, extractionYield, predictTds, beverageOf, beverageOverridden, beverageSource, beverageDefaultOf, profileTargetOf, setBeveragePreference, grindMicrons, measuredEy, DEFAULTS } from './analysis.js?v=0.11.1';
import { buildShotDigest, buildReviewMessages, compactProfile, renderMarkdown, reviewTitle, approxTokens } from './review.js?v=0.11.1';
import { PROVIDERS, streamCompletion, listModels, testKey, maskKey } from './ai.js?v=0.11.1';
import { buildEnvelope, encodeHandoff, encodeForQr } from './beanconqueror.js?v=0.11.1';
import { makeDemoShot } from './demo.js?v=0.11.1';
import { chartToJpeg, legendOf, shotReportPdf, shotSamplesCsv, summaryRow, SUMMARY_COLUMNS, rowsToCsv, buildZip, download, stamp, slug } from './export.js?v=0.11.1';
import { log, Logger, formatLine } from './log.js?v=0.11.1';
import qrcode from '../vendor/qrcode.mjs';

const $ = (id) => document.getElementById(id);

const store = new Store();
const portal = new PortalBle();
let meticulous = null;
const recorder = new ShotRecorder();
const timeChart = new TimeChart($('chart-time'));
const massChart = new MassChart($('chart-mass'));
const calChart = new CalibrationChart($('chart-cal'));
const compareChart = new CompareChart($('cmp-chart'));
const machinePanel = new MachinePanel($('view-machine'));

const VIEWS = ['shots', 'history', 'analysis', 'machine', 'settings'];

function showView(name) {
  if (!VIEWS.includes(name)) name = 'shots';
  if (name !== 'settings' && !$('view-settings').hidden && dirtySettings().length) {
    // Leaving Settings with edits still in the inputs: keep them rather than lose them.
    saveAllSettings({ quiet: true }).catch(() => {});
  }
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  document.querySelectorAll('.view-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  if (name === 'machine') machinePanel.onShown();
  else if (name === 'history') renderHistory();
  else if (name === 'analysis') renderAnalysis();
  else if (name === 'shots') {
    timeChart.u.setSize({ width: Math.max(320, $('chart-time').clientWidth), height: 320 });
    massChart.u.setSize({ width: Math.max(320, $('chart-mass').clientWidth), height: 300 });
  } else if (name === 'settings') renderLogTail();
  if (!erasing) store.setSetting('view', name).catch(() => {});
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

// ---------------------------------------------------------------- settings --

/** Every user setting, its default, and the input it is bound to. */
const SETTINGS = {
  meticulousHost: { def: DEFAULT_HOST, el: 'meticulous-host' },
  autoConnectMeticulous: { def: false, el: 'set-autoconnect', bool: true },
  autoAttach: { def: true, el: 'set-autoattach', bool: true },
  attachDelaySec: { def: 4, el: 'set-attach-delay', num: true, min: 1, max: 60 },
  autoRecord: { def: true, el: 'set-autorecord', bool: true },
  settleSec: { def: 6, el: 'settle-sec', num: true, min: 0, max: 60 },
  lagSec: { def: 0, el: 'lag-sec', num: true, min: -2, max: 3 },
  minShotSec: { def: 5, el: 'set-min-shot', num: true, min: 0, max: 60 },
  autoGraph: { def: true, el: 'portal-auto-graph', bool: true },
  autoSaveFiles: { def: true, el: 'set-autosave-files', bool: true },
  beverageDefault: { def: 'profile', el: 'set-beverage-default' },
  minCalibrationShots: { def: 5, el: 'set-min-cal', num: true, min: 2, max: 20 },
  estimatePool: { def: 'auto', el: 'est-pool' },
  aiProvider: { def: 'anthropic', el: 'set-ai-provider' },
  aiKeyAnthropic: { def: '', el: 'set-ai-key-anthropic', secret: true },
  aiModelAnthropic: { def: '', el: 'set-ai-model-anthropic' },
  aiKeyOpenai: { def: '', el: 'set-ai-key-openai', secret: true },
  aiModelOpenai: { def: '', el: 'set-ai-model-openai' },
  aiBaseOpenai: { def: '', el: 'set-ai-base-openai' },
  aiKeyGoogle: { def: '', el: 'set-ai-key-google', secret: true },
  aiModelGoogle: { def: '', el: 'set-ai-model-google' },
  aiGrindStepUm: { def: 5, el: 'set-ai-grind-step', num: true, min: 1, max: 100 },
  aiDrink: { def: 'espresso', el: 'set-ai-drink' },
  aiNotes: { def: '', el: 'set-ai-notes' },
  logEnabled: { def: false, el: 'log-enabled', bool: true },
  logLevel: { def: 'info', el: 'log-level' },
  logPackets: { def: false, el: 'log-packets', bool: true },
  logSaveExports: { def: false, el: 'log-save-exports', bool: true },
  logShowTail: { def: true, el: 'log-show', bool: true },
};
const settings = {}; // live values

async function loadSettings() {
  for (const [key, spec] of Object.entries(SETTINGS)) {
    let v = await store.getSetting(key, spec.def);
    if (key === 'meticulousHost' && v === 'meticulous.local:8080') v = DEFAULT_HOST; // v0.1 default
    settings[key] = v;
  }
  writeSettings();
}

/** Push the live values into the inputs. */
function writeSettings() {
  for (const [key, spec] of Object.entries(SETTINGS)) {
    const el = $(spec.el);
    if (!el) continue;
    if (spec.bool) el.checked = !!settings[key];
    else el.value = settings[key] ?? '';
  }
  $('meticulous-addr').textContent = settings.meticulousHost || DEFAULT_HOST;
}

/** Read one input, clamp, persist, apply. Returns the stored value. */
async function settingChanged(key) {
  const spec = SETTINGS[key];
  const el = $(spec.el);
  let v = spec.bool ? el.checked : el.value;
  if (spec.num) {
    v = Number(v);
    if (!Number.isFinite(v)) v = spec.def;
    v = Math.min(spec.max, Math.max(spec.min, v));
    el.value = v;
  }
  if (typeof v === 'string') v = v.trim();
  if (settings[key] === v) return v; // e.g. a second 'change' event for the same value
  settings[key] = v;
  await store.setSetting(key, v);
  applySetting(key, v);
  log.info('settings', `${key} = ${spec.secret ? (v ? `(key ${maskKey(v)})` : '(cleared)') : JSON.stringify(v)}`);
  flashSaved([key]);
  return v;
}

/** Side effects of a setting taking a new value. */
function applySetting(key, v) {
  switch (key) {
    case 'meticulousHost':
      $('meticulous-addr').textContent = v || DEFAULT_HOST;
      if (meticulous) {
        try {
          const url = normalizeBaseUrl(v);
          if (url !== meticulous.baseUrl) connectMeticulous();
        } catch {
          /* bad address; leave the connection alone */
        }
      }
      break;
    case 'settleSec':
      recorder.settleSec = v;
      break;
    case 'autoRecord':
      recorder.autoStart = v;
      $('meticulous-hint').textContent = v ? 'Shots start recording on their own when the machine begins extracting.' : 'Automatic recording is off; use "Start recording now".';
      break;
    case 'lagSec':
      if (state.selected) {
        state.selected.lagSec = v;
        store.putShot(state.selected).then(() => renderShot());
      }
      break;
    case 'estimatePool':
    case 'minCalibrationShots':
      if (state.selected) renderShot();
      break;
    case 'beverageDefault':
      setBeveragePreference(v);
      renderHistory();
      if (state.selected) renderShot();
      break;
    case 'logEnabled':
    case 'logLevel':
    case 'logPackets':
      log.configure({ enabled: settings.logEnabled, level: settings.logLevel, packets: settings.logPackets });
      renderLogStatus();
      break;
    case 'logShowTail':
      renderLogTail();
      break;
    case 'aiProvider':
    case 'aiKeyAnthropic':
    case 'aiKeyOpenai':
    case 'aiKeyGoogle':
    case 'aiModelAnthropic':
    case 'aiModelOpenai':
    case 'aiModelGoogle':
    case 'aiBaseOpenai':
      renderAiSettings();
      break;
    default:
      break;
  }
}

/** Settings as a portable JSON document (no file handles, no shots). */
function settingsDocument() {
  const out = { app: 'portal-met-bridge-settings', version: 1, exportedAt: new Date().toISOString(), settings: {}, context: readContext() };
  for (const [key, spec] of Object.entries(SETTINGS)) if (!spec.secret) out.settings[key] = settings[key]; // API keys never leave the browser's database
  return out;
}

async function importSettingsDocument(doc) {
  if (!doc || doc.app !== 'portal-met-bridge-settings' || typeof doc.settings !== 'object') throw new Error('Not a portal-met-bridge settings file.');
  let n = 0;
  for (const [key, spec] of Object.entries(SETTINGS)) {
    if (!(key in doc.settings)) continue;
    let v = doc.settings[key];
    if (spec.bool) v = !!v;
    else if (spec.num) {
      v = Number(v);
      if (!Number.isFinite(v)) continue;
      v = Math.min(spec.max, Math.max(spec.min, v));
    } else v = String(v ?? spec.def);
    settings[key] = v;
    await store.setSetting(key, v);
    n++;
  }
  writeSettings();
  for (const key of Object.keys(SETTINGS)) applySetting(key, settings[key]);
  renderSavebar();
  if (doc.context && typeof doc.context === 'object') {
    writeContext(doc.context);
    await store.setSetting('context', readContext());
  }
  return n;
}

async function resetSettings() {
  for (const [key, spec] of Object.entries(SETTINGS)) {
    settings[key] = spec.def;
    await store.setSetting(key, spec.def);
  }
  writeSettings();
  for (const key of Object.keys(SETTINGS)) applySetting(key, settings[key]);
  renderSavebar();
}

// Human-readable names for the save bar.
const SETTING_LABELS = {
  meticulousHost: 'machine address', autoConnectMeticulous: 'connect on open', autoAttach: 'attach machine record', attachDelaySec: 'attach delay',
  autoRecord: 'auto-record', settleSec: 'settle window', lagSec: 'Portal lag', minShotSec: 'minimum shot length', autoGraph: 'Portal screen', autoSaveFiles: 'write shot files', beverageDefault: 'beverage weight',
  minCalibrationShots: 'reference shots', estimatePool: 'estimate pool', logEnabled: 'logging', logLevel: 'log detail', logPackets: 'packet logging',
  logSaveExports: 'save exports to folder', logShowTail: 'live tail',
  aiProvider: 'AI provider', aiKeyAnthropic: 'Anthropic key', aiModelAnthropic: 'Claude model', aiKeyOpenai: 'OpenAI key', aiModelOpenai: 'OpenAI model', aiBaseOpenai: 'OpenAI endpoint',
  aiKeyGoogle: 'Gemini key', aiModelGoogle: 'Gemini model', aiGrindStepUm: 'grinder step', aiDrink: 'usual drink', aiNotes: 'standing notes',
};

/** Read an input's current value in the setting's type, without persisting. */
function inputValue(key) {
  const spec = SETTINGS[key];
  const el = $(spec.el);
  if (!el) return settings[key];
  if (spec.bool) return !!el.checked;
  if (spec.num) {
    const n = Number(el.value);
    return Number.isFinite(n) ? Math.min(spec.max, Math.max(spec.min, n)) : settings[key];
  }
  return String(el.value ?? '').trim();
}

/** Keys whose input differs from what is stored. */
function dirtySettings() {
  return Object.keys(SETTINGS).filter((k) => inputValue(k) !== settings[k]);
}

let savebarTimer = null;
const flashKeys = new Set(); // settings saved during the current "Saved …" flash
function renderSavebar(stateOverride, text) {
  const bar = $('savebar');
  if (!bar) return;
  const dirty = dirtySettings();
  if (stateOverride) {
    bar.dataset.state = stateOverride;
    $('savebar-status').textContent = text;
  } else if (dirty.length) {
    bar.dataset.state = 'dirty';
    $('savebar-status').textContent = `Unsaved: ${dirty.map((k) => SETTING_LABELS[k] || k).join(', ')} — press Enter, ⌘S or Save settings`;
  } else if (savebarTimer) {
    // a "Saved …" flash is showing and nothing new is pending: leave it until its timer runs out
  } else {
    bar.dataset.state = 'clean';
    $('savebar-status').textContent = 'All changes saved';
  }
  $('settings-discard').disabled = dirty.length === 0;
}

/**
 * Confirm a save in the bar. Every path that persists a setting (blur, Enter, ⌘S, the Save
 * button, leaving the tab) ends here, so the Save button reports the fields a blur committed
 * a moment before the click as well: "Saved 2 settings (machine address, settle) at 12:59:32".
 */
function flashSaved(keys) {
  keys.forEach((k) => flashKeys.add(k));
  const when = new Date().toLocaleTimeString();
  const names = [...flashKeys].map((k) => SETTING_LABELS[k] || k).join(', ');
  const n = flashKeys.size;
  renderSavebar('saved', n ? `Saved ${n} setting${n === 1 ? '' : 's'} (${names}) at ${when}` : `All settings saved — nothing was pending (${when})`);
  if (savebarTimer) clearTimeout(savebarTimer);
  savebarTimer = setTimeout(() => { savebarTimer = null; flashKeys.clear(); renderSavebar(); }, 4000);
}

/** Save every setting from its input (used by the Save button, Enter, ⌘S and when leaving the tab). */
async function saveAllSettings({ quiet = false } = {}) {
  const dirty = dirtySettings();
  const errors = [];
  for (const key of dirty) {
    try {
      await settingChanged(key); // flashes each key as it lands
    } catch (err) {
      errors.push(`${SETTING_LABELS[key] || key}: ${err?.message || err}`);
    }
  }
  if (errors.length) {
    if (savebarTimer) { clearTimeout(savebarTimer); savebarTimer = null; }
    renderSavebar('error', `Could not save ${errors.join('; ')}`);
    return false;
  }
  if (!quiet) flashSaved([]); // button/Enter/⌘S: always confirm, even if blur already committed the fields
  if (dirty.length) log.info('settings', `saved ${dirty.length} setting(s): ${dirty.join(', ')}`);
  return true;
}

function discardSettingChanges() {
  writeSettings();
  if (savebarTimer) { clearTimeout(savebarTimer); savebarTimer = null; }
  flashKeys.clear();
  renderSavebar();
}

// ------------------------------------------------------------------- setup --

async function init() {
  await loadSettings();
  const hashView = location.hash.replace('#', '');
  const view = VIEWS.includes(hashView) ? hashView : await store.getSetting('view', 'shots');
  showView(view);
  const ctx = await store.getSetting('context', {});
  writeContext(ctx);
  recorder.settleSec = settings.settleSec;
  recorder.autoStart = settings.autoRecord;
  setBeveragePreference(settings.beverageDefault);
  log.configure({ enabled: settings.logEnabled, level: settings.logLevel, packets: settings.logPackets });
  await restoreLogFolder();
  renderLogStatus();
  $('about-version').textContent = 'v0.11.1';
  log.info('app', `portal-met-bridge v0.11.1 started · ${navigator.userAgent}`);

  const env = await environmentCheck();
  renderPortalSteps({ secure: env.secure, api: env.api, adapter: env.adapter });
  if (!env.secure || !env.api) {
    $('portal-connect').disabled = true;
    $('portal-hint').textContent = env.hint;
  } else if (env.adapter === false) {
    $('portal-hint').textContent = env.hint;
  }

  const seeded = await store.seedListsFromHistory();
  if (seeded) log.info('lists', `seeded pick-lists with ${seeded} entries from earlier shots and beans`);
  const promoted = await store.promoteLegacyBeverage();
  if (promoted) log.info('shots', `moved the hand-weighed beverage of ${promoted} older shot(s) from the reading to the shot`);
  await refreshBeanLists();
  await refreshShotList();
  await recoverUnfinishedShots();
  renderAiSettings();
  await renderSavedReviews();
  const first = state.shots.find((x) => !x.inProgress);
  if (first) selectShot(first.id);
  if (await store.getSetting('autoConnectMeticulous', false)) connectMeticulous();
}

// ------------------------------------------------------------- Meticulous --

function connectMeticulous() {
  const host = settings.meticulousHost || $('meticulous-host').value;
  let url;
  try {
    url = normalizeBaseUrl(host);
  } catch {
    toast('That address does not look right. Set it under Settings → Machine.', 'error');
    return;
  }
  if (meticulous) {
    machinePanel.detach();
    meticulous.disconnect();
  }
  log.info('machine', `connecting to ${url}`);
  meticulous = new MeticulousClient(url);
  meticulous.addEventListener('state', (e) => {
    const d = e.detail;
    log.info('machine', `socket ${d.state}${d.error ? ': ' + d.error : ''}${d.reason ? ' (' + d.reason + ')' : ''}`);
    setLink('meticulous', d.state, d.state === 'connected' ? url.replace(/^https?:\/\//, '') : d.state === 'error' ? d.error : d.state);
    $('meticulous-connect').disabled = d.state === 'connected' || d.state === 'connecting';
    $('meticulous-disconnect').disabled = d.state === 'disconnected';
    $('mach-last').disabled = d.state !== 'connected';
    $('shot-refresh').disabled = d.state !== 'connected' || !state.selected;
    if (d.state === 'connected') {
      refreshProfileTargets().catch(() => {});
      setTimeout(() => backfillMachineRecords().catch(() => {}), 1500);
    }
    $('brew-controls').hidden = d.state !== 'connected';
    if (d.state !== 'connected') $('brew-state').textContent = '—';
  });
  meticulous.addEventListener('status', (e) => onStatus(e.detail));
  meticulous.connect();
  machinePanel.attach(meticulous);
  meticulous.ping().then(
    (s) => {
      log.info('machine', `REST answered: ${s?.totalSavedShots ?? '?'} saved shots`);
      $('meticulous-hint').textContent = `Machine answered: ${s?.totalSavedShots ?? '?'} saved shots. ${settings.autoRecord ? 'Recording starts on its own when extraction begins.' : 'Automatic recording is off.'}`;
    },
    (err) => {
      log.warn('machine', `REST ping failed: ${err?.message || err}`);
      $('meticulous-hint').textContent = 'No answer on /api/v1. Check the address under Settings (the machine serves on port 80) and that this Mac is on the same network.';
    },
  );
}

/** Settings → Test connection: REST ping + device info, without touching the live socket. */
async function testMeticulous() {
  const out = $('meticulous-test-result');
  let url;
  try {
    url = normalizeBaseUrl($('meticulous-host').value);
  } catch {
    out.textContent = 'That address does not look right.';
    return;
  }
  out.textContent = `Trying ${url} …`;
  const probe = new MeticulousClient(url);
  try {
    const t0 = performance.now();
    const [stats, info] = await Promise.all([probe.ping(), probe.machineInfo().catch(() => null)]);
    const ms = Math.round(performance.now() - t0);
    const pending = dirtySettings().includes('meticulousHost') ? ' — press Enter or Save settings to keep this address' : '';
    out.textContent = `OK in ${ms} ms — ${info?.name || 'machine'} · firmware ${info?.firmware || '?'} · ${stats?.totalSavedShots ?? '?'} saved shots${pending}`;
    log.info('machine', `test ${url}: ok ${ms} ms`, { firmware: info?.firmware, shots: stats?.totalSavedShots });
  } catch (err) {
    out.textContent = `No answer: ${err?.message || err}. The machine serves on port 80; check the IP and that you are on the same network.`;
    log.warn('machine', `test ${url} failed: ${err?.message || err}`);
  }
}

function disconnectMeticulous() {
  log.info('machine', 'disconnect requested');
  machinePanel.detach();
  meticulous?.disconnect();
  meticulous = null;
  setLink('meticulous', 'idle', 'not connected');
  $('meticulous-connect').disabled = false;
  $('meticulous-disconnect').disabled = true;
}

let lastStatusLog = 0;
function onStatus(s) {
  if (settings.logPackets) log.packet('machine', `status ${s.name}/${s.state} ext=${s.extracting} t=${s.timeMs} p=${fmt(s.p, 2)} f=${fmt(s.f, 2)} w=${fmt(s.w, 2)} T=${fmt(s.temp, 1)}`);
  else if (s.extracting && performance.now() - lastStatusLog > 1000) {
    lastStatusLog = performance.now();
    log.debug('machine', `${s.name} t=${(s.timeMs / 1000).toFixed(1)} p=${fmt(s.p, 1)} f=${fmt(s.f, 2)} w=${fmt(s.w, 1)}`);
  }
  setText('ro-weight', fmt(s.w, 1));
  setText('ro-flow', fmt(s.f, 2));
  setText('ro-pressure', fmt(s.p, 1));
  renderBrewState(s);
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
  log.info('portal', `state ${d.state}${d.name ? ' ' + d.name : ''}${d.error ? ': ' + d.error : ''}`);
  // Connected (or reconnected) while a shot is already running: switch the screen now.
  if (d.state === 'connected' && recorder.isRecording && settings.autoGraph && !state.autoGraphSent) {
    state.autoGraphSent = true;
    portal.showGraph().catch((err) => log.warn('portal', `show-graph failed: ${err?.message || err}`));
  }
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
  log.packet('portal', `ec ${m.ec.toFixed(4)} tInt ${m.tInt.toFixed(2)} tOut ${m.tOut.toFixed(2)} status ${m.status}`);
  if (portal.packetCount % 8 === 1) {
    $('portal-raw').textContent = `Last packet: EC ${m.ec.toFixed(4)} · internal ${m.tInt.toFixed(1)} °C · outlet ${m.tOut.toFixed(1)} °C · status ${m.status} · bytes ${m.raw.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`;
    $('portal-rate').textContent = `· ${portal.packetRate().toFixed(1)}/s`;
  }
  recorder.onPortal(m);
});
portal.addEventListener('malformed', (e) => {
  log.warn('portal', `notification of unexpected length ${e.detail.byteLength} B`);
});
portal.addEventListener('step', (e) => {
  log.debug('portal', `step ${e.detail.name}: ${JSON.stringify(e.detail.value)}`);
  renderPortalSteps(e.detail.steps);
});

/** Paint the connection-check list: true ✓, false ✗, string = note, null = pending. */
function renderPortalSteps(steps) {
  let ok = 0;
  let bad = false;
  for (const name of STEPS) {
    const li = document.querySelector(`#portal-steps li[data-step="${name}"]`);
    if (!li) continue;
    const v = steps[name];
    li.querySelector('.why')?.remove();
    if (v === true) {
      li.dataset.ok = 'true';
      ok++;
    } else if (v === false) {
      li.dataset.ok = 'false';
      bad = true;
    } else if (typeof v === 'string') {
      const soft = name === 'command' || name === 'device';
      li.dataset.ok = soft ? (name === 'device' ? 'true' : 'warn') : 'false';
      if (name === 'device') ok++;
      else if (!soft) bad = true;
      const span = document.createElement('span');
      span.className = 'why' + (soft ? ' warn' : '');
      span.textContent = '— ' + v;
      li.appendChild(span);
    } else {
      delete li.dataset.ok;
    }
  }
  const all = steps.packet === true;
  $('portal-check-summary').textContent = all ? '— connected to the Portal, packets flowing' : bad ? '— a step failed' : ok ? `— ${ok}/${STEPS.length}` : '';
  if (all || bad) $('portal-check').open = true;
}

async function connectPortal() {
  try {
    await portal.pick({ acceptAll: $('portal-accept-all').checked });
    toast(`Connected to ${portal.device?.name || 'the Portal'} — the connection check shows each step.`);
  } catch (err) {
    if (err?.name === 'NotFoundError') {
      // The chooser closed with nothing picked: either cancelled, or no Portal was visible.
      $('portal-hint').textContent = 'No device picked. If the Portal was missing from Chrome’s list: wake it, close the Belka app on your phone, and try "Show every nearby Bluetooth device".';
      return;
    }
    toast(err.message || String(err), 'error');
  }
}

// --------------------------------------------------------------- recorder --

recorder.addEventListener('state', (e) => {
  const d = e.detail;
  log.info('recorder', `→ ${d.state}${d.t !== undefined ? ' at ' + d.t.toFixed(1) + ' s' : ''}`);
  const ind = $('rec-indicator');
  ind.dataset.state = d.state;
  $('rec-text').textContent = d.state === 'recording' ? 'Recording' : d.state === 'settling' ? 'Pump stopped — catching the last drips' : 'Waiting for a shot';
  $('rec-manual').textContent = d.state === 'idle' ? 'Start recording now' : 'Stop and save';
  if (d.state === 'recording') {
    applyProfileTarget(d.shot);
    $('shot-title').textContent = 'Live shot';
    $('shot-sub').textContent = liveShotSub(d.shot);
    massChart.setAnalysis(null);
    startLiveLoop();
    if (portal.connected && settings.autoGraph && !state.autoGraphSent) {
      state.autoGraphSent = true;
      portal.showGraph().then(() => log.info('portal', 'show-graph sent')).catch((err) => log.warn('portal', `show-graph failed: ${err?.message || err}`));
    }
  }
  if (d.state === 'idle') {
    stopLiveLoop();
    if (state.autoGraphSent) {
      state.autoGraphSent = false;
      if (portal.connected) portal.hideGraph().then(() => log.info('portal', 'hide-graph sent')).catch((err) => log.warn('portal', `hide-graph failed: ${err?.message || err}`));
    }
  }
});
recorder.addEventListener('sample', () => {
  state.liveDirty = true;
  if (recorder.shot && !recorder.shot.profileTargetG && recorder.shot.profileName) applyProfileTarget(recorder.shot); // the name can arrive a few samples in
  checkpointLiveShot();
});

// ----------------------------------------------------- profile target weight --
// The output weight each profile is set to, by name, from the machine's profile
// list. A shot picks up its profile's target when recording starts (so the
// value is known even if the machine's record is never attached) and again,
// from the record itself, when that record is attached.
state.profileTargets = new Map();
let profileTargetsPromise = null;
async function refreshProfileTargets() {
  if (!meticulous) return state.profileTargets;
  if (profileTargetsPromise) return profileTargetsPromise;
  profileTargetsPromise = (async () => {
    try {
      const list = await meticulous.profiles();
      const next = new Map();
      for (const p of Array.isArray(list) ? list : []) {
        const target = Number(p?.final_weight);
        if (p?.name && target > 0) next.set(p.name, target);
      }
      state.profileTargets = next;
      state.profileList = (Array.isArray(list) ? list : []).filter((p) => p?.id && p?.name).map((p) => ({ id: p.id, name: p.name, finalWeightG: Number(p.final_weight) || null, temperatureC: Number(p.temperature) || null }));
      renderBrewProfiles();
      log.info('machine', `profile list: ${next.size} profiles with a target weight`);
      if (recorder.shot && !recorder.shot.profileTargetG) applyProfileTarget(recorder.shot);
    } catch (err) {
      log.warn('machine', `profile list failed: ${err?.message || err}`);
    } finally {
      profileTargetsPromise = null;
    }
    return state.profileTargets;
  })();
  return profileTargetsPromise;
}

const liveShotSub = (shot) => (shot?.profileName ? `Profile: ${shot.profileName}${shot.profileTargetG > 0 ? ` · target ${fmt(shot.profileTargetG, 1)} g` : ''}` : '');

/** Stamp the profile's target output weight on a shot from the cached list; refresh the list when the name is unknown. */
function applyProfileTarget(shot) {
  if (!shot?.profileName) return false;
  const target = state.profileTargets.get(shot.profileName);
  if (target > 0) {
    if (shot.profileTargetG !== target) {
      shot.profileTargetG = target;
      log.info('recorder', `profile "${shot.profileName}" targets ${fmt(target, 1)} g`);
      if (shot === recorder.shot && recorder.isRecording) $('shot-sub').textContent = liveShotSub(shot);
    }
    return true;
  }
  if (meticulous?.connected) refreshProfileTargets().catch(() => {});
  return false;
}

// While a shot is being recorded it is written to the database every
// CHECKPOINT_MS as an `inProgress` entry under its final id, so a closed tab
// or a crash mid-shot loses at most that much. recoverUnfinishedShots() turns
// any leftover checkpoint into a normal shot on the next start.
const CHECKPOINT_MS = 2000;
let lastCheckpoint = 0;
let checkpointPromise = null; // the write in flight, awaited before the final save so it cannot overwrite it
function checkpointLiveShot(force = false) {
  const live = recorder.shot;
  if (!live || checkpointPromise) return checkpointPromise;
  const now = performance.now();
  if (!force && now - lastCheckpoint < CHECKPOINT_MS) return null;
  lastCheckpoint = now;
  const snap = { ...live, machine: live.machine.slice(), portal: live.portal.slice(), inProgress: true, checkpointAt: Date.now(), context: readContext(), lagSec: settings.lagSec || 0 };
  snap.durationSec = snap.machine.at(-1)?.t ?? snap.portal.at(-1)?.t ?? 0;
  checkpointPromise = (async () => {
    try {
      await store.putShot(snap);
      if (!state.shots.some((x) => x.id === live.id)) await refreshShotList(); // first checkpoint: show the row
    } catch (err) {
      log.warn('recorder', `checkpoint failed: ${err?.message || err}`);
    } finally {
      checkpointPromise = null;
    }
  })();
  return checkpointPromise;
}

/** Finish any shot that was left as a checkpoint (tab closed or crashed mid-shot). */
async function recoverUnfinishedShots() {
  let n = 0;
  for (const s of state.shots.filter((x) => x.inProgress)) {
    const shot = await store.getShot(s.id);
    if (!shot) continue;
    if (!finalizeCheckpoint(shot)) {
      await store.deleteShot(shot.id);
      log.info('recorder', `dropped an empty checkpoint ${shot.id}`);
      continue;
    }
    recomputeCache(shot);
    await store.putShot(shot);
    log.warn('recorder', `recovered an unfinished recording from ${fmtDate(shot.startedAt)}: ${fmt(shot.durationSec, 1)} s, ${shot.machine?.length || 0} machine + ${shot.portal?.length || 0} Portal samples`);
    if (settings.autoSaveFiles) autosaveShotFiles(shot).catch(() => {});
    n++;
  }
  if (n) {
    await refreshShotList();
    toast(`Recovered ${n} unfinished recording${n === 1 ? '' : 's'} from the last session.`);
  }
  return n;
}

recorder.addEventListener('shot', async (e) => {
  const shot = e.detail;
  if (checkpointPromise) await checkpointPromise; // never let a late checkpoint overwrite the final record
  if (shot.machine.length + shot.portal.length < 5 || (!shot.manual && shot.durationSec < settings.minShotSec)) {
    log.info('recorder', `discarded a ${shot.durationSec.toFixed(1)} s recording (${shot.machine.length} machine, ${shot.portal.length} Portal samples; minimum ${settings.minShotSec} s)`);
    toast(`Recording was shorter than ${settings.minShotSec} s and was not kept (change this under Settings → Recording).`);
    await store.deleteShot(shot.id).catch(() => {}); // remove its checkpoint
    await refreshShotList();
    return;
  }
  shot.context = readContext();
  shot.lagSec = settings.lagSec || 0;
  if (!shot.profileTargetG) applyProfileTarget(shot);
  delete shot.inProgress;
  delete shot.checkpointAt;
  recomputeCache(shot);
  await store.putShot(shot);
  await store.rememberBean(shot.context);
  await rememberContextValues(shot.context);
  await refreshBeanLists();
  await refreshShotList();
  selectShot(shot.id);
  log.info('recorder', `saved shot ${shot.id}: ${fmt(shot.finalWeightG, 1)} g in ${fmt(shot.durationSec, 1)} s, ${shot.machine.length} machine + ${shot.portal.length} Portal samples`);
  toast(`Saved shot — ${fmt(shot.finalWeightG, 1)} g in ${fmt(shot.durationSec, 1)} s`);
  if (settings.autoSaveFiles) autosaveShotFiles(shot).catch(() => {});
  if (settings.autoAttach && meticulous?.connected && !shot.manual) setTimeout(() => refreshFromMachine(shot.id, true), settings.attachDelaySec * 1000);
});

/**
 * Write a shot's JSON and CSV into <save folder>/portal-met-bridge/shots/ and
 * remember where. Quiet when no folder is configured: the database copy is the
 * record of truth; files are a convenience for other tools.
 */
async function autosaveShotFiles(shot) {
  if (!log.folder || log.folderState !== 'granted') return false;
  const analysis = recomputeCache(shot);
  let estimate = null;
  try {
    estimate = estimateShot(shot, analysis).estimate;
  } catch {
    /* no calibration yet */
  }
  const base = fileBase(shot);
  const json = await log.saveFile('shots', `${base}.json`, new Blob([shotJson(shot, analysis, estimate)], { type: 'application/json' }));
  const csv = await log.saveFile('shots', `${base}.csv`, new Blob([shotSamplesCsv(shot)], { type: 'text/csv' }));
  shot.files = { json, csv, at: Date.now() };
  await store.putShot(shot);
  log.info('export', `shot files written: ${json}, ${csv}`);
  const i = state.shots.findIndex((x) => x.id === shot.id);
  if (i >= 0) state.shots[i] = shot;
  if (state.selected?.id === shot.id) state.selected = shot;
  renderHistory();
  if (state.selected?.id === shot.id) $('shot-files-note').textContent = `This shot's JSON and CSV were written to ${json.replace(/[^/]+$/, '')} at ${new Date(shot.files.at).toLocaleTimeString()}.`;
  return true;
}

/**
 * Shots recorded live that never got the machine's own record (the tab was
 * closed before the attach delay, or the machine was unreachable) are
 * completed from the machine's history the next time it connects.
 */
async function backfillMachineRecords() {
  if (!meticulous?.connected) return 0;
  const since = Date.now() - 7 * 86400e3;
  const missing = state.shots.filter((s) => s.source === 'live' && !s.inProgress && !s.machineSource && !s.manual && s.startedAt > since);
  if (!missing.length) return 0;
  let list;
  try {
    list = await meticulous.history({ maxResults: 60, dumpData: false });
  } catch (err) {
    log.warn('machine', `history lookup for backfill failed: ${err?.message || err}`);
    return 0;
  }
  let n = 0;
  for (const s of missing) {
    const hit = list.find((h) => Number.isFinite(h.time) && Math.abs(h.time * 1000 - s.startedAt) < 45000);
    if (!hit) continue;
    try {
      const saved = hit.data?.length ? hit : await meticulous.shotById(hit.id);
      if (!saved) continue;
      const shot = await store.getShot(s.id);
      if (!shot) continue;
      await attachMachineRecord(shot, saved, machineSamplesFromSavedShot(saved));
      if (settings.autoSaveFiles) await autosaveShotFiles(shot).catch(() => {});
      n++;
      log.info('machine', `attached the machine record ${saved.id} to the ${fmtDate(shot.startedAt)} shot (backfill)`);
    } catch (err) {
      log.warn('machine', `backfill for ${s.id} failed: ${err?.message || err}`);
    }
  }
  if (n) {
    await refreshShotList();
    if (state.selected) selectShot(state.selected.id);
    toast(`Attached the machine's record to ${n} earlier shot${n === 1 ? '' : 's'}.`);
  }
  return n;
}

function startLiveLoop() {
  stopLiveLoop();
  state.liveTimer = setInterval(() => {
    if (!state.liveDirty || !recorder.shot) return;
    state.liveDirty = false;
    timeChart.setShot(recorder.shot.machine, recorder.shot.portal);
    if (recorder.shot.portal.length > 5 && recorder.shot.machine.length > 5) {
      const a = analyzeShot(recorder.shot.portal, recorder.shot.machine.map((s) => ({ t: s.t, w: s.w })), { lagSec: settings.lagSec || 0 });
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
  const n = state.shots.filter((x) => !x.inProgress).length;
  $('shot-count').textContent = n ? `(${n})` : '';
  $('history-tab-count').textContent = n ? `(${n})` : '';
  renderHistory();
  updateShotNav();
}

/** Newer/older buttons on the Shots tab step through the saved shots. */
function updateShotNav() {
  const list = state.shots.filter((x) => !x.inProgress);
  const i = list.findIndex((x) => x.id === state.selected?.id);
  $('shot-prev').disabled = i <= 0;
  $('shot-next').disabled = i < 0 || i >= list.length - 1;
}
function stepShot(delta) {
  const list = state.shots.filter((x) => !x.inProgress);
  const i = list.findIndex((x) => x.id === state.selected?.id);
  const j = i + delta;
  if (j >= 0 && j < list.length) selectShot(list[j].id);
}

async function selectShot(id, { show = false } = {}) {
  const shot = await store.getShot(id);
  if (!shot) return;
  state.selected = shot;
  document.querySelectorAll('#hist-rows tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === id));
  updateShotNav();
  renderShot();
  if (show) showView('shots');
}

// ---------------------------------------------------------------- history --

const hist = { search: '', filter: 'all', sort: 'startedAt', dir: 'desc', checked: new Set() };

/** The number History sorts and shows for TDS: a reading if there is one, else the estimate. */
function histTds(shot) {
  if (shot.refractometer?.tdsPct) return { v: shot.refractometer.tdsPct, measured: true };
  const a = shot.analysisCache;
  if (!a || !(a.meanEcPerG > 0) || shot.inProgress) return { v: NaN, measured: false };
  try {
    const { estimate } = estimateShot(shot, { status: a.status, meanEcPerG: a.meanEcPerG, coverageRatio: a.coverageRatio, totalMassG: a.totalMassG }, { excludeSelf: true });
    return { v: estimate.tdsPct, measured: false };
  } catch {
    return { v: NaN, measured: false };
  }
}

/** Brew ratio as beverage ÷ dose (e.g. 2.24 for 18.5 g → 41.5 g); null without a dose. */
function ratioOf(shot) {
  const dose = Number(shot?.context?.doseG);
  const out = beverageOf(shot);
  return dose > 0 && Number.isFinite(out) && out > 0 ? out / dose : null;
}
const fmtRatio = (r) => (Number.isFinite(r) ? `1 : ${r.toFixed(r >= 10 ? 1 : 2)}` : '–');

/** Short words for where a shot's beverage weight comes from. */
const BEVERAGE_SOURCE_LABEL = { weighed: 'weighed by hand', reading: 'weighed with the reading', profile: 'profile target', scale: "machine's scale" };
function beverageLabel(shot) {
  return BEVERAGE_SOURCE_LABEL[beverageSource(shot)] || 'unknown';
}
/** The ⚖ / ◎ mark after a beverage weight that is not the machine's reading, with the scale's value in the tooltip. */
function beverageMarker(shot) {
  if (!beverageOverridden(shot)) return '';
  const src = beverageSource(shot);
  const scale = Number.isFinite(shot.finalWeightG) && shot.finalWeightG > 0 ? `the machine's scale saw ${fmt(shot.finalWeightG, 1)} g` : 'no scale reading';
  if (src === 'profile') return `<span class="weighed target" title="profile target weight; ${scale}">◎</span>`;
  return `<span class="weighed" title="${beverageLabel(shot)}; ${scale}">⚖</span>`;
}
/** "(weighed; machine 41.2 g)"-style suffix for headers and reports; empty when the scale's value is in use. */
function beverageNote(shot) {
  if (!beverageOverridden(shot)) return '';
  const scale = Number.isFinite(shot.finalWeightG) && shot.finalWeightG > 0 ? `; machine ${fmt(shot.finalWeightG, 1)} g` : '';
  return ` (${beverageSource(shot) === 'profile' ? 'profile target' : 'weighed'}${scale})`;
}

function histMatches(shot) {
  const q = hist.search.trim().toLowerCase();
  if (q) {
    const c = shot.context || {};
    const hay = [c.beanName, c.roaster, c.origin, c.grinderName, c.grindSize, c.note, c.roastLevel, c.process, shot.profileName, fmtDate(shot.startedAt)].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  switch (hist.filter) {
    case 'portal': return (shot.portal?.length || 0) > 0;
    case 'reading': return !!shot.refractometer?.tdsPct;
    case 'noreading': return !shot.refractometer?.tdsPct;
    case 'machine': return shot.source === 'machine' || !(shot.portal?.length);
    case 'unsaved': return !shot.files?.json;
    default: return true;
  }
}

function histSortValue(shot, key) {
  switch (key) {
    case 'bean': return (shot.context?.beanName || '').toLowerCase();
    case 'profileName': return (shot.profileName || '').toLowerCase();
    case 'meanEc': return shot.analysisCache?.meanEcPerG ?? -1;
    case 'tds': return histTds(shot).v || -1;
    case 'finalWeightG': return beverageOf(shot) ?? -1;
    case 'ratio': return ratioOf(shot) ?? -1;
    case 'grind': return grindMicrons(shot.context) ?? -1;
    default: return shot[key] ?? -1;
  }
}

function renderHistory() {
  const tbody = $('hist-rows');
  if (!tbody) return;
  const rows = state.shots.filter(histMatches);
  const dir = hist.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const x = histSortValue(a, hist.sort);
    const y = histSortValue(b, hist.sort);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || (b.startedAt - a.startedAt);
  });
  document.querySelectorAll('#hist-table th[data-sort]').forEach((th) => th.setAttribute('aria-sort', th.dataset.sort === hist.sort ? (hist.dir === 'asc' ? 'ascending' : 'descending') : 'none'));
  const total = state.shots.filter((x) => !x.inProgress).length;
  $('hist-count').textContent = total ? (rows.length === total ? `(${total})` : `(${rows.length} of ${total})`) : '';
  $('hist-empty').hidden = state.shots.length > 0;
  for (const id of [...hist.checked]) if (!state.shots.some((x) => x.id === id)) hist.checked.delete(id);
  tbody.innerHTML = '';
  for (const s of rows) {
    const c = s.context || {};
    // Shots restored from an older backup may lack the cached summary; compute it once, in memory.
    const a = s.analysisCache || (!s.inProgress && s.portal?.length ? recomputeCache(s) : null);
    const tds = histTds(s);
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;
    if (s.id === state.selected?.id) tr.classList.add('selected');
    if (s.inProgress) tr.classList.add('recording');
    const when = new Date(s.startedAt);
    const coffee = s.inProgress ? '<i>recording now…</i>' : `${esc(c.beanName || 'no bean')}${c.roaster || c.origin ? `<small>${esc([c.roaster, c.origin].filter(Boolean).join(' · '))}</small>` : ''}`;
    const bev = beverageOf(s);
    const inOut = `${c.doseG ? fmt(Number(c.doseG), 1) : '–'} → ${fmt(bev, 1)} g${beverageMarker(s)}`;
    const grind = grindMicrons(c);
    const data = [
      `<span class="tag ${s.portal?.length ? 'on' : 'off'}" title="Portal samples">P ${s.portal?.length || 0}</span>`,
      `<span class="tag ${s.machine?.length ? 'on' : 'off'}" title="machine samples">M ${s.machine?.length || 0}</span>`,
      s.inProgress ? '<span class="tag rec">● recording</span>' : `<span class="tag ${s.machineSource ? 'on' : 'off'}" title="${s.machineSource ? 'machine record attached' : 'machine record not attached'}">⌂</span>`,
      s.inProgress ? '' : `<span class="tag ${s.files?.json ? 'on' : 'off'}" title="${s.files?.json ? 'JSON + CSV in the save folder: ' + s.files.json : 'files not written to a folder'}">▤</span>`,
      s.source === 'demo' ? '<span class="tag off">demo</span>' : '',
      s.recovered ? '<span class="tag off" title="recovered from a checkpoint after the tab closed mid-shot">recovered</span>' : '',
    ].join('');
    tr.innerHTML = `<td class="sel"><input type="checkbox" aria-label="Select shot" ${hist.checked.has(s.id) ? 'checked' : ''} ${s.inProgress ? 'disabled' : ''} /></td>` +
      `<td class="when">${esc(when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}<small>${esc(when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</small></td>` +
      `<td class="coffee">${coffee}</td>` +
      `<td class="prof">${esc(s.profileName || '–')}</td>` +
      `<td class="num grind">${grind ? `${fmt(grind, 0)} <small>µm</small>` : '–'}</td>` +
      `<td class="num">${inOut}</td>` +
      `<td class="num ratio" title="${c.doseG ? 'beverage ÷ dose' : 'enter a dose to get the ratio'}">${fmtRatio(ratioOf(s))}</td>` +
      `<td class="num">${fmt(s.durationSec, 0)} s</td>` +
      `<td class="num ec">${Number.isFinite(a?.meanEcPerG) ? a.meanEcPerG.toFixed(2) : '–'}</td>` +
      `<td class="num tds">${Number.isFinite(tds.v) ? (tds.measured ? `<b>${tds.v.toFixed(2)}</b>` : `<i>~${tds.v.toFixed(2)}</i>`) : '–'}</td>` +
      `<td class="data">${data}</td>` +
      `<td class="actions">${s.inProgress ? '' : '<button class="btn small" data-act="open">Open</button><button class="btn small" data-act="edit">Edit</button><button class="btn small danger" data-act="delete">Delete</button>'}</td>`;
    tbody.appendChild(tr);
  }
  $('hist-delete-selected').disabled = hist.checked.size === 0;
  $('hist-delete-selected').textContent = hist.checked.size ? `Delete selected (${hist.checked.size})` : 'Delete selected';
  const n = hist.checked.size;
  $('hist-compare').disabled = n < 2 || n > COMPARE_MAX;
  $('hist-compare').textContent = n >= 2 ? `Compare selected (${n})` : 'Compare selected';
  $('hist-compare').title = n > COMPARE_MAX ? `Up to ${COMPARE_MAX} shots can be overlaid at once` : 'Overlay the graphs of the ticked shots (2–8)';
  $('hist-analyze').disabled = n < 1 || n > REVIEW_MAX;
  $('hist-analyze').textContent = n >= 1 ? `Analyze selected (${n})` : 'Analyze selected';
  if (compare.ids.length && compare.ids.some((id) => !state.shots.some((x) => x.id === id))) {
    compare.ids = compare.ids.filter((id) => state.shots.some((x) => x.id === id));
    if (compare.ids.length < 2) closeCompare();
    else renderCompare().catch(() => {});
  }
  const all = $('hist-select-all');
  const selectable = rows.filter((x) => !x.inProgress);
  all.checked = selectable.length > 0 && selectable.every((x) => hist.checked.has(x.id));
  all.indeterminate = !all.checked && selectable.some((x) => hist.checked.has(x.id));
}

async function onHistoryClick(ev) {
  const tr = ev.target.closest('tr[data-id]');
  if (!tr) return;
  const id = tr.dataset.id;
  const shot = state.shots.find((x) => x.id === id);
  if (!shot || shot.inProgress) return;
  if (ev.target.matches('input[type="checkbox"]')) {
    if (ev.target.checked) hist.checked.add(id);
    else hist.checked.delete(id);
    renderHistory();
    return;
  }
  const act = ev.target.closest('button[data-act]')?.dataset.act;
  if (act === 'open') return selectShot(id, { show: true });
  if (act === 'edit') return openShotDialog(await store.getShot(id));
  if (act === 'delete') return deleteShots([id]);
  selectShot(id);
}

/** A generic confirm box (the browser's confirm() blocks the page and is not styleable). */
function confirmDialog({ title, body, action = 'Delete' }) {
  return new Promise((resolve) => {
    const dlg = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('confirm-go').textContent = action;
    const done = (ok) => {
      dlg.removeEventListener('close', onClose);
      $('confirm-go').removeEventListener('click', onGo);
      $('confirm-cancel').removeEventListener('click', onCancel);
      if (dlg.open) dlg.close();
      resolve(ok);
    };
    const onGo = () => done(true);
    const onCancel = () => done(false);
    const onClose = () => done(false);
    $('confirm-go').addEventListener('click', onGo);
    $('confirm-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

async function deleteShots(ids) {
  ids = ids.filter((id) => state.shots.some((x) => x.id === id && !x.inProgress));
  if (!ids.length) return;
  const first = state.shots.find((x) => x.id === ids[0]);
  const body = ids.length === 1
    ? `${fmtDate(first.startedAt)}${first.context?.beanName ? ' — ' + first.context.beanName : ''}: its samples, analysis and refractometer reading are removed from this browser. Files already written to the save folder stay there.`
    : `${ids.length} shots and their readings are removed from this browser. Files already written to the save folder stay there.`;
  const ok = await confirmDialog({ title: ids.length === 1 ? 'Delete this shot?' : `Delete ${ids.length} shots?`, body, action: ids.length === 1 ? 'Delete shot' : `Delete ${ids.length} shots` });
  if (!ok) return;
  for (const id of ids) {
    await store.deleteShot(id);
    hist.checked.delete(id);
  }
  log.info('shots', `deleted ${ids.length} shot(s): ${ids.join(', ')}`);
  const wasSelected = ids.includes(state.selected?.id);
  if (wasSelected) state.selected = null;
  await refreshShotList();
  if (wasSelected) {
    const next = state.shots.find((x) => !x.inProgress);
    if (next) selectShot(next.id);
    else clearShotPanel();
  }
  toast(ids.length === 1 ? 'Shot deleted.' : `${ids.length} shots deleted.`);
}

function clearShotPanel() {
  $('shot-title').textContent = 'No shot selected';
  $('shot-sub').textContent = '';
  timeChart.setShot([], []);
  massChart.setAnalysis(null);
  $('metrics').innerHTML = '';
  $('qr').innerHTML = '';
  for (const id of ['shot-delete', 'shot-edit', 'shot-refresh', 'bc-copy', 'bc-open', 'bc-json', 'dl-csv', 'dl-json', 'dl-jpeg', 'dl-pdf', 'ref-save', 'ref-clear']) $(id).disabled = true;
  updateShotNav();
}

// ---------------------------------------------------------------- compare --

const COMPARE_MAX = COMPARE_COLORS.length;
const compare = { ids: [], series: 'ec-mass', x: 'g' };

/** What can be overlaid. `kind` decides whether the mass-axis option applies. */
const COMPARE_SERIES = {
  'ec-mass': { kind: 'mass', yLabel: 'EC (mS/cm)', yUnit: 'mS/cm', yDigits: 3, pick: (shot, a) => a.curve.filter((k) => k.ec !== null).map((k) => [k.m, k.ec]) },
  'integral-mass': { kind: 'mass', yLabel: '∫EC dm (mS·g/cm)', yUnit: 'mS·g/cm', yDigits: 1, pick: (shot, a) => a.curve.map((k) => [k.m, k.I]) },
  'ec-time': { kind: 'time', yLabel: 'EC (mS/cm)', yUnit: 'mS/cm', yDigits: 3, pick: (shot) => (shot.portal || []).filter((s) => Number.isFinite(s.ec)).map((s) => [s.t, s.ec]) },
  'weight-time': { kind: 'time', yLabel: 'Cup weight (g)', yUnit: 'g', yDigits: 1, pick: (shot) => (shot.machine || []).filter((s) => Number.isFinite(s.w)).map((s) => [s.t, s.w]) },
  'flow-time': { kind: 'time', yLabel: 'Flow (ml/s)', yUnit: 'ml/s', yDigits: 2, pick: (shot) => (shot.machine || []).filter((s) => Number.isFinite(s.f)).map((s) => [s.t, s.f]) },
  'pressure-time': { kind: 'time', yLabel: 'Pressure (bar)', yUnit: 'bar', yDigits: 2, pick: (shot) => (shot.machine || []).filter((s) => Number.isFinite(s.p)).map((s) => [s.t, s.p]) },
};

function compareLabel(shot) {
  const c = shot.context || {};
  const when = new Date(shot.startedAt);
  return `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}${c.beanName ? ' · ' + c.beanName : ''}`;
}

async function openCompare(ids) {
  compare.ids = ids.slice(0, COMPARE_MAX);
  $('compare-panel').hidden = false;
  await renderCompare();
  $('compare-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  log.info('history', `comparing ${compare.ids.length} shots: ${compare.ids.join(', ')}`);
}

function closeCompare() {
  compare.ids = [];
  $('compare-panel').hidden = true;
  compareChart.setSeries([]);
  $('cmp-legend').innerHTML = '';
}

async function renderCompare() {
  const def = COMPARE_SERIES[compare.series] || COMPARE_SERIES['ec-mass'];
  const massAxis = def.kind === 'mass';
  $('cmp-x-field').hidden = !massAxis;
  const byRatio = massAxis && compare.x === 'ratio';
  const shots = [];
  for (const id of compare.ids) {
    const shot = await store.getShot(id);
    if (shot) shots.push(shot);
  }
  $('cmp-count').textContent = `(${shots.length})`;
  const rows = [];
  const series = [];
  const excluded = [];
  shots.forEach((shot, i) => {
    const color = COMPARE_COLORS[i % COMPARE_COLORS.length];
    const analysis = recomputeCache(shot);
    const dose = Number(shot.context?.doseG) || 0;
    let pts = def.pick(shot, analysis).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    let note = '';
    if (byRatio) {
      if (dose > 0) pts = pts.map(([x, y]) => [x / dose, y]);
      else {
        excluded.push(shot);
        note = 'no dose — left out of the ratio view';
        pts = [];
      }
    } else if (!pts.length) {
      note = def.kind === 'mass' ? 'no Portal + weight data' : 'no data for this graph';
    }
    // uPlot needs ascending x: mass curves are monotone already; time series are sorted by t.
    pts.sort((a, b) => a[0] - b[0]);
    series.push({ label: compareLabel(shot), color, xs: pts.map((p) => p[0]), ys: pts.map((p) => p[1]) });
    const est = histTds(shot);
    rows.push({ shot, color, analysis, note, tds: est });
  });
  compareChart.setSeries(series, {
    xLabel: massAxis ? (byRatio ? 'Brew ratio (cup mass ÷ dose)' : 'Cup mass (g)') : 'Time (s)',
    xUnit: massAxis ? (byRatio ? '×' : 'g') : 's',
    xDigits: byRatio ? 2 : 1,
    yLabel: def.yLabel,
    yUnit: def.yUnit,
    yDigits: def.yDigits,
  });
  const legend = $('cmp-legend');
  legend.innerHTML = `<thead><tr><th></th><th>Shot</th><th>Coffee</th><th>Profile</th><th class="num">In → out</th><th class="num">Ratio</th><th class="num">Time</th><th class="num">Peak EC</th><th class="num">EC/g</th><th class="num">TDS</th><th></th></tr></thead>` +
    '<tbody>' + rows.map(({ shot, color, analysis, note, tds }) => {
      const c = shot.context || {};
      return `<tr data-id="${shot.id}" class="${note ? 'excluded' : ''}">` +
        `<td><span class="swatch" style="background:${color}"></span></td>` +
        `<td>${esc(fmtDate(shot.startedAt))}</td>` +
        `<td class="coffee">${esc([c.beanName, c.roaster].filter(Boolean).join(' · ') || '–')}${note ? `<br><small>${esc(note)}</small>` : ''}</td>` +
        `<td>${esc(shot.profileName || '–')}</td>` +
        `<td class="num">${c.doseG ? fmt(Number(c.doseG), 1) : '–'} → ${fmt(beverageOf(shot), 1)} g</td>` +
        `<td class="num">${fmtRatio(ratioOf(shot))}</td>` +
        `<td class="num">${fmt(shot.durationSec, 1)} s</td>` +
        `<td class="num">${Number.isFinite(analysis?.mainPeakEc) && analysis.mainPeakEc > 0 ? analysis.mainPeakEc.toFixed(3) : '–'}</td>` +
        `<td class="num">${Number.isFinite(analysis?.meanEcPerG) && analysis.meanEcPerG > 0 ? analysis.meanEcPerG.toFixed(3) : '–'}</td>` +
        `<td class="num">${Number.isFinite(tds.v) ? (tds.measured ? `<b>${tds.v.toFixed(2)}</b>` : `<i>~${tds.v.toFixed(2)}</i>`) : '–'}</td>` +
        `<td><button class="linkish" data-act="open">Open</button></td>` +
        '</tr>';
    }).join('') + '</tbody>';
  $('cmp-note').textContent = excluded.length ? `${excluded.length} shot${excluded.length === 1 ? ' has' : 's have'} no dose and ${excluded.length === 1 ? 'is' : 'are'} not drawn in the brew-ratio view; add the dose under Edit to include ${excluded.length === 1 ? 'it' : 'them'}.` : '';
}

// ------------------------------------------------------------ edit dialog --

let editingId = null;
function openShotDialog(shot) {
  if (!shot) return;
  editingId = shot.id;
  const c = shot.context || {};
  $('shot-dialog-sub').textContent = `${fmtDate(shot.startedAt)}${shot.profileName ? ' — ' + shot.profileName : ''} · ${fmt(shot.finalWeightG, 1)} g in ${fmt(shot.durationSec, 1)} s · ${shot.portal?.length || 0} Portal + ${shot.machine?.length || 0} machine samples`;
  $('e-bean').value = c.beanName || '';
  $('e-roaster').value = c.roaster || '';
  $('e-roast').value = c.roastLevel || '';
  $('e-process').value = c.process || '';
  $('e-origin').value = c.origin || '';
  $('e-grinder').value = c.grinderName || '';
  $('e-dose').value = c.doseG || '';
  $('e-grind').value = (c.grindSize || '').replace(/\s*µm$/, '');
  $('e-note').value = c.note || '';
  $('e-tds').value = shot.refractometer?.tdsPct ?? '';
  // Beverage weighed is a field of the shot in its own right: editable with or without a reading.
  $('e-bev').value = Number.isFinite(shot.beverageG) && shot.beverageG > 0 ? shot.beverageG : '';
  const fallback = beverageDefaultOf(shot);
  const fallbackSrc = beverageSource({ ...shot, beverageG: undefined, refractometer: undefined });
  $('e-bev').placeholder = Number.isFinite(fallback) ? `${fmt(fallback, 1)} (${fallbackSrc === 'profile' ? 'profile target' : 'machine'})` : '';
  const target = profileTargetOf(shot);
  $('e-bev-hint').textContent = [
    target > 0 ? `Profile target ${fmt(target, 1)} g` : 'No profile target known for this shot',
    Number.isFinite(shot.finalWeightG) && shot.finalWeightG > 0 ? `machine's scale ${fmt(shot.finalWeightG, 1)} g` : null,
    `blank uses the ${fallbackSrc === 'profile' ? 'profile target' : "machine's scale"} (Settings → Recording → Beverage weight)`,
  ].filter(Boolean).join(' · ');
  $('shot-dialog').showModal();
  $('e-bean').focus();
}

async function saveShotDialog() {
  const shot = await store.getShot(editingId);
  if (!shot) return;
  const grind = $('e-grind').value;
  shot.context = {
    beanName: $('e-bean').value.trim(),
    roaster: $('e-roaster').value.trim(),
    roastLevel: $('e-roast').value,
    process: $('e-process').value,
    origin: $('e-origin').value.trim(),
    doseG: Number($('e-dose').value) || 0,
    grindSize: grind ? `${grind} µm` : '',
    grinderName: $('e-grinder').value.trim(),
    note: $('e-note').value.trim(),
  };
  const weighed = Number($('e-bev').value);
  if (weighed > 0 && weighed < 5000) shot.beverageG = Math.round(weighed * 10) / 10;
  else delete shot.beverageG; // blank → back to the profile target or the machine's scale
  const tds = Number($('e-tds').value);
  if (tds > 0 && tds < 30) {
    // EY is recomputed wherever it is shown (measuredEy), so the beverage setting can change later; the value here is a snapshot for exports.
    shot.refractometer = { tdsPct: tds, eyPct: extractionYield(tds, beverageOf(shot), shot.context.doseG), at: shot.refractometer?.at || Date.now() };
  } else {
    delete shot.refractometer;
  }
  recomputeCache(shot);
  await store.putShot(shot);
  if (shot.context.beanName && shot.source !== 'demo') await store.rememberBean(shot.context);
  await rememberContextValues(shot.context);
  await refreshBeanLists();
  log.info('shots', `edited shot ${shot.id}`);
  await refreshShotList();
  if (state.selected?.id === shot.id) await selectShot(shot.id);
  if (settings.autoSaveFiles) autosaveShotFiles(shot).catch(() => {});
  $('shot-dialog').close();
  toast('Shot updated.');
}

function renderShot() {
  const shot = state.selected;
  const ctx = shot.context || {};
  $('shot-title').textContent = `${fmtDate(shot.startedAt)}${shot.profileName ? ' — ' + shot.profileName : ''}`;
  $('shot-sub').textContent = [
    ctx.beanName,
    ctx.doseG ? `${ctx.doseG} g in` : null,
    `${fmt(beverageOf(shot), 1)} g out${beverageNote(shot)}`,
    ratioOf(shot) ? fmtRatio(ratioOf(shot)) : null,
    `${fmt(shot.durationSec, 1)} s`,
    `${shot.machine.length} machine · ${shot.portal.length} Portal samples`,
    shot.machineSource ? 'machine record attached' : null,
    shot.recovered ? 'recovered from a checkpoint' : null,
  ].filter(Boolean).join(' · ');
  $('shot-files-note').textContent = shot.files?.json ? `This shot's JSON and CSV were written to ${shot.files.json.replace(/[^/]+$/, '')} at ${new Date(shot.files.at).toLocaleTimeString()}.` : '';
  $('shot-delete').disabled = false;
  $('shot-edit').disabled = false;
  $('shot-refresh').disabled = !meticulous?.connected;
  for (const id of ['bc-copy', 'bc-open', 'bc-json', 'dl-csv', 'dl-json', 'dl-jpeg', 'dl-pdf', 'ref-save']) $(id).disabled = false;
  $('ref-clear').disabled = !shot.refractometer;
  $('ref-tds').value = shot.refractometer?.tdsPct ?? '';
  $('ref-bev').value = Number.isFinite(shot.beverageG) && shot.beverageG > 0 ? shot.beverageG : '';
  $('ref-bev').placeholder = Number.isFinite(beverageDefaultOf(shot)) ? `${fmt(beverageDefaultOf(shot), 1)} (${beverageSource({ ...shot, beverageG: undefined }) === 'profile' ? 'profile target' : 'machine'})` : 'auto';

  timeChart.setShot(shot.machine, shot.portal);
  const lag = Number.isFinite(shot.lagSec) ? shot.lagSec : settings.lagSec || 0;
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

/** Every shot with a refractometer reading, as a calibration point carrying its coffee identity. */
function allCalibrationPoints(shots = state.shots) {
  return shots
    .filter((s) => s.refractometer?.tdsPct && s.analysisCache && s.analysisCache.meanEcPerG > 0)
    .map((s) => ({
      id: s.id,
      meanEcPerG: s.analysisCache.meanEcPerG,
      tdsPct: s.refractometer.tdsPct,
      reliable: s.analysisCache.status === 'ok',
      meanTempC: s.analysisCache.meanTempC,
      when: s.startedAt,
      coffeeKey: s.coffeeKey || coffeeKey(s.context?.beanName),
      roasterKey: s.roasterKey || coffeeKey(s.context?.roaster),
      roastLevel: s.context?.roastLevel || '',
      beanName: s.context?.beanName || '',
    }));
}

function coffeeIdentity(shot) {
  const c = shot.context || {};
  return { coffeeKey: coffeeKey(c.beanName), roasterKey: coffeeKey(c.roaster), roastLevel: c.roastLevel || '' };
}

/** Fit + estimate for any shot under the current "estimate from" setting. */
function estimateShot(shot, analysis, { excludeSelf = true, points } = {}) {
  const mode = settings.estimatePool || 'auto';
  const fit = fitForCoffee(points || allCalibrationPoints(), coffeeIdentity(shot), mode, { excludeId: excludeSelf ? shot.id : undefined, minShots: settings.minCalibrationShots });
  const estimate = estimateForShot(analysis, fit, { beverageG: beverageOf(shot), doseG: Number(shot.context?.doseG) || 0, poolLabel: fit.poolLabel });
  if (fit.calibrated && fit.pool !== 'bean') estimate.flags.unshift(`Borrowed from ${fit.poolLabel}: ${fit.shotCount} shot${fit.shotCount === 1 ? '' : 's'} of ${fit.distinctCoffees} coffee${fit.distinctCoffees === 1 ? '' : 's'}${fit.fallbackFrom ? ' (no readings for this bean yet)' : ''}.`);
  return { fit, estimate };
}

function renderCalibration() {
  const shot = state.selected;
  const key = coffeeKey(shot.context?.beanName);
  // Each reviewed shot is excluded from its own fit (leave-one-out for the estimate).
  const { fit, estimate } = estimateShot(shot, state.analysis);
  state.fit = fit;
  state.estimate = estimate;
  $('cal-coffee').textContent = fit.pool === 'bean' ? shot.context?.beanName || 'this coffee' : fit.poolLabel;

  // The chart shows the chosen pool including this shot, so the point you just saved is visible.
  const poolPts = fitForCoffee(allCalibrationPoints(), coffeeIdentity(shot), fit.pool, { minShots: settings.minCalibrationShots }).poolPoints;
  calChart.setFit(poolPts, fitCalibration(poolPts), predictTds);

  const dl = $('cal-stats');
  const rows = [];
  if (!key) rows.push(['Bean', 'Give this shot a bean name so its reading can be grouped.']);
  rows.push(['Pool', `${fit.poolLabel}${fit.mode === 'auto' ? ' (auto)' : ''} — ${poolPts.length} reference shot${poolPts.length === 1 ? '' : 's'}${fit.distinctCoffees > 1 ? ` across ${fit.distinctCoffees} coffees` : ''}${poolPts.length !== fit.shotCount ? ` (${fit.shotCount} used; this shot is left out)` : ''}`]);
  if (fit.calibrated) {
    const p = fit.proportional;
    rows.push(['Proportional k', `${p.k.toFixed(3)} %TDS per (mS/cm) — leave-one-out error ${isFinite(p.loocvRmse) ? '±' + p.loocvRmse.toFixed(2) + '% TDS' : 'n/a'}`]);
    if (fit.affine) rows.push(['Affine', `${fit.affine.a.toFixed(3)}·x + ${fit.affine.b.toFixed(2)} — leave-one-out ±${fit.affine.loocvRmse.toFixed(2)}% TDS`]);
    rows.push(['Active model', fit.activeModel + (fit.preliminary ? ' (preliminary)' : '')]);
    rows.push(['Measured EC/g range', `${fit.minX.toFixed(3)} – ${fit.maxX.toFixed(3)}`]);
    if (fit.tempCorrelation !== null) rows.push(['Residual vs outlet temp', `r = ${fit.tempCorrelation.toFixed(2)}`]);
  }
  dl.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  setText('est-tds', Number.isFinite(estimate.tdsPct) ? estimate.tdsPct.toFixed(2) : '–');
  setText('est-ey', Number.isFinite(estimate.eyPct) ? estimate.eyPct.toFixed(1) : '–');
  $('est-basis').textContent = fit.calibrated ? `Based on ${fit.poolLabel} · ${fit.activeModel} model · ${fit.shotCount} reference shot${fit.shotCount === 1 ? '' : 's'}` : '';
  $('est-flags').innerHTML = estimate.flags.map((f) => `<li>${esc(f)}</li>`).join('');
}

async function saveRefractometer() {
  const shot = state.selected;
  const tds = Number($('ref-tds').value);
  if (!(tds > 0 && tds < 30)) {
    toast('Enter the refractometer TDS as a percentage, e.g. 9.2.', 'error');
    return;
  }
  const typed = Number($('ref-bev').value);
  if (typed > 0 && typed < 5000) shot.beverageG = Math.round(typed * 10) / 10; // a weighed cup entered with the reading is kept on the shot
  else delete shot.beverageG;
  const dose = Number(shot.context?.doseG) || 0;
  shot.refractometer = { tdsPct: tds, eyPct: extractionYield(tds, beverageOf(shot), dose), at: Date.now() };
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
  const bev = Number($('ref-bev').value) || beverageOf(shot);
  const dose = Number(shot?.context?.doseG) || 0;
  const ey = extractionYield(tds, bev, dose);
  $('ref-ey').textContent = tds > 0 ? (ey ? `→ EY ${ey.toFixed(1)}% at ${dose} g in` : 'Add a dose to get EY') : '';
}

async function deleteShot() {
  if (state.selected) await deleteShots([state.selected.id]);
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
  if (Number(saved.profile?.final_weight) > 0) shot.profileTargetG = Number(saved.profile.final_weight); // the record says what was actually brewed
  shot.machineSource = { id: saved.id, time: saved.time, profile: saved.profile ?? null, profile_name: saved.profile_name ?? null };
  recomputeCache(shot);
  await store.putShot(shot);
  if (settings.autoSaveFiles) autosaveShotFiles(shot).catch((err) => log.warn('export', `shot files after attach failed: ${err?.message || err}`));
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
  deliver(`beanconqueror-${stamp(state.selected.startedAt)}.json`, JSON.stringify(env, null, 2), 'application/json');
}

// ---------------------------------------------------------- files out --

/**
 * Hand a file to the user: into the chosen folder (Settings → Logging) when
 * "save exports there" is on and the folder is writable, else a browser download.
 */
async function deliver(name, data, type, sub = 'exports') {
  if (settings.logSaveExports && log.folder && log.folderState === 'granted') {
    try {
      const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
      const path = await log.saveFile(sub, name, blob);
      log.info('export', `saved ${path} (${blob.size} B)`);
      toast(`Saved ${path}`);
      return path;
    } catch (err) {
      log.warn('export', `folder save failed for ${name}: ${err?.message || err}; downloading instead`);
    }
  }
  log.info('export', `download ${name}`);
  download(name, data, type);
  return null;
}

const fileBase = (shot) => `shot-${stamp(shot.startedAt)}-${slug(shot.context?.beanName)}`;

function shotJson(shot, analysis, estimate) {
  return JSON.stringify({ app: 'portal-met-bridge', version: 2, shot, analysis, estimate }, null, 2);
}

function downloadShotJson() {
  const shot = state.selected;
  deliver(`${fileBase(shot)}.json`, shotJson(shot, state.analysis, state.estimate), 'application/json');
}

function downloadCsv() {
  const shot = state.selected;
  deliver(`${fileBase(shot)}.csv`, shotSamplesCsv(shot), 'text/csv');
}

/** Render both charts for a shot to JPEG. Charts must be visible (Shots view). */
async function chartImages(shot, analysis) {
  const c = shot.context || {};
  const sub = [fmtDate(shot.startedAt), shot.profileName, c.beanName, c.doseG ? `${c.doseG} g in` : null, `${fmt(beverageOf(shot), 1)} g out`, `${fmt(shot.durationSec, 1)} s`].filter(Boolean).join(' · ');
  const time = await chartToJpeg(timeChart.u, { title: 'Shot against time', subtitle: sub, legend: legendOf(timeChart.u) });
  let mass = null;
  if (analysis?.curve?.length) {
    const sub2 = `mean EC ${fmt(analysis.meanEcPerG, 3)} mS/cm · ∫EC dm ${fmt(analysis.integralEcG, 1)} · peak ${fmt(analysis.mainPeakEc, 3)} at ${fmt(analysis.mainPeakMassG, 1)} g · 90 % of ∫ at ${fmt(analysis.massAt90PctG, 1)} g`;
    mass = await chartToJpeg(massChart.u, { title: 'Conductivity against cup mass', subtitle: sub2, legend: legendOf(massChart.u) });
  }
  return { time, mass };
}

async function downloadJpegs() {
  const shot = state.selected;
  if ($('view-shots').hidden) showView('shots');
  const { time, mass } = await chartImages(shot, state.analysis);
  await deliver(`${fileBase(shot)}-time.jpg`, time.blob);
  if (mass) {
    await new Promise((r) => setTimeout(r, 300));
    await deliver(`${fileBase(shot)}-ec-vs-mass.jpg`, mass.blob);
  }
}

function reportFor(shot, analysis, estimate, fit, images) {
  const c = shot.context || {};
  const a = analysis || {};
  const metrics = [
    ['Profile', shot.profileName || '–'],
    ['Bean', c.beanName || '–'],
    ['Roaster', c.roaster || '–'],
    ['Roast · process · origin', [c.roastLevel, c.process, c.origin].filter(Boolean).join(' · ') || '–'],
    ['Dose', c.doseG ? `${c.doseG} g` : '–'],
    ['Grind · grinder', [c.grindSize, c.grinderName].filter(Boolean).join(' · ') || '–'],
    ['Beverage', `${fmt(beverageOf(shot), 1)} g${beverageOverridden(shot) ? ` ${beverageLabel(shot)}${Number.isFinite(shot.finalWeightG) && shot.finalWeightG > 0 ? ` (machine ${fmt(shot.finalWeightG, 1)} g)` : ''}` : ''}`],
    ['Profile target', profileTargetOf(shot) > 0 ? `${fmt(profileTargetOf(shot), 1)} g` : '–'],
    ['Extraction', `${fmt(shot.durationSec, 1)} s`],
    ['Samples', `${shot.machine?.length ?? 0} machine · ${shot.portal?.length ?? 0} Portal`],
    ['Analysis', a.status || '–'],
    ['Mean EC per g', `${fmt(a.meanEcPerG, 3)} mS/cm`],
    ['∫EC dm', `${fmt(a.integralEcG, 1)} mS·g/cm`],
    ['Peak EC', `${fmt(a.mainPeakEc, 3)} at ${fmt(a.mainPeakMassG, 1)} g`],
    ['Last 5 g', `mean ${fmt(a.tail?.last5g?.mean, 3)} · slope ${fmt(a.tail?.last5g?.slopePerG, 3)}/g`],
    ['Mass at 90 % of ∫', `${fmt(a.massAt90PctG, 1)} g`],
    ['Portal coverage', `${fmt((a.coverageRatio ?? 0) * 100, 0)} %`],
    ['First drop', `${fmt(a.firstDropTimeSec, 1)} s`],
    ['Portal temperature', `${fmt(a.meanTempC, 1)} °C mean · ${fmt(a.maxTempC, 1)} max`],
  ];
  const est = [
    ['Refractometer TDS', shot.refractometer?.tdsPct ? `${shot.refractometer.tdsPct.toFixed(2)} %` : '–'],
    ['Refractometer EY', Number.isFinite(measuredEy(shot)) ? `${measuredEy(shot).toFixed(1)} %` : '–'],
    ['Estimated TDS', Number.isFinite(estimate?.tdsPct) ? `${estimate.tdsPct.toFixed(2)} %` : '–'],
    ['Estimated EY', Number.isFinite(estimate?.eyPct) ? `${estimate.eyPct.toFixed(1)} %` : '–'],
    ['Based on', fit?.calibrated ? `${fit.poolLabel} · ${fit.activeModel} · ${fit.shotCount} shots` : 'no calibration'],
    ['k (proportional)', fit?.proportional ? `${fit.proportional.k.toFixed(3)} ± ${isFinite(fit.proportional.loocvRmse) ? fit.proportional.loocvRmse.toFixed(2) : '–'} % TDS` : '–'],
  ];
  const notes = [...(estimate?.flags || [])];
  if (c.note) notes.push(c.note);
  notes.push('EC is a conductivity proxy; TDS/EY here are estimates from refractometer calibration unless a refractometer reading is shown.');
  const imgs = [];
  if (images.time) imgs.push({ ...images.time, caption: 'Pressure, flow, weight and Portal EC against time; dotted lines mark the machine’s stages.' });
  if (images.mass) imgs.push({ ...images.mass, caption: 'Portal EC against cumulative cup mass; the shaded area is ∫EC dm, the dashed line its running share.' });
  return {
    title: `${fmtDate(shot.startedAt)}${shot.profileName ? ' — ' + shot.profileName : ''}`,
    subtitle: [c.beanName, c.roaster, c.doseG ? `${c.doseG} g → ${fmt(beverageOf(shot), 1)} g in ${fmt(shot.durationSec, 1)} s` : null].filter(Boolean).join(' · '),
    images: imgs,
    metrics,
    estimate: est,
    notes,
  };
}

async function downloadPdf() {
  const shot = state.selected;
  if ($('view-shots').hidden) showView('shots');
  toast('Building the PDF…');
  try {
    const images = await chartImages(shot, state.analysis);
    const blob = await shotReportPdf(reportFor(shot, state.analysis, state.estimate, state.fit, images));
    deliver(`${fileBase(shot)}-report.pdf`, blob);
  } catch (err) {
    toast('PDF failed: ' + (err.message || err), 'error');
  }
}

/** Analysis + estimate for every shot, computed once for the summary and the zip. */
async function analyseAll() {
  const shots = await store.listShots({ limit: 100000 });
  const points = allCalibrationPoints(shots);
  return shots.map((shot) => {
    const analysis = recomputeCache(shot);
    const mode = settings.estimatePool || 'auto';
    const fit = fitForCoffee(points, coffeeIdentity(shot), mode, { excludeId: shot.id, minShots: settings.minCalibrationShots });
    const estimate = estimateForShot(analysis, fit, { beverageG: beverageOf(shot), doseG: Number(shot.context?.doseG) || 0, poolLabel: fit.poolLabel });
    return { shot, analysis, estimate, fit };
  });
}

async function downloadSummaryCsv() {
  const all = await analyseAll();
  const rows = [SUMMARY_COLUMNS, ...all.map(({ shot, analysis, estimate }) => summaryRow(shot, analysis, estimate))];
  deliver(`portal-met-bridge-shots-${stamp(Date.now())}.csv`, rowsToCsv(rows), 'text/csv');
}

async function downloadZip() {
  const all = await analyseAll();
  if (!all.length) {
    toast('No shots to export yet.');
    return;
  }
  if ($('view-shots').hidden) showView('shots');
  const prog = $('dl-progress');
  const files = {};
  files['shots-summary.csv'] = rowsToCsv([SUMMARY_COLUMNS, ...all.map(({ shot, analysis, estimate }) => summaryRow(shot, analysis, estimate))]);
  files['backup.json'] = JSON.stringify(await store.exportAll());
  files['README.txt'] = `portal-met-bridge export — ${new Date().toString()}\n\nshots-summary.csv   one row per shot (EC metrics, refractometer reading, estimate)\nbackup.json         full backup; restore it with the Restore button\nshots/<shot>/       samples.csv, shot.json, time.jpg, ec-vs-mass.jpg, report.pdf per shot\n\nEC is a conductivity proxy; TDS/EY are estimates from refractometer calibration unless a refractometer reading is present.\n`;
  const selectedId = state.selected?.id;
  let i = 0;
  for (const { shot, analysis, estimate, fit } of all) {
    i++;
    prog.textContent = `Rendering ${i}/${all.length}…`;
    const dir = `shots/${fileBase(shot)}`;
    files[`${dir}/samples.csv`] = shotSamplesCsv(shot);
    files[`${dir}/shot.json`] = shotJson(shot, analysis, estimate);
    // Render this shot's charts, then capture.
    timeChart.setShot(shot.machine, shot.portal);
    massChart.setAnalysis(analysis);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    try {
      const images = await chartImages(shot, analysis);
      files[`${dir}/time.jpg`] = images.time.blob;
      if (images.mass) files[`${dir}/ec-vs-mass.jpg`] = images.mass.blob;
      files[`${dir}/report.pdf`] = await shotReportPdf(reportFor(shot, analysis, estimate, fit, images));
    } catch (err) {
      files[`${dir}/ERROR.txt`] = String(err?.message || err);
    }
  }
  prog.textContent = 'Zipping…';
  try {
    const blob = await buildZip(files);
    deliver(`portal-met-bridge-export-${stamp(Date.now())}.zip`, blob);
    prog.textContent = `${all.length} shots exported.`;
  } catch (err) {
    toast('Zip failed: ' + (err.message || err), 'error');
    prog.textContent = '';
  }
  if (selectedId) selectShot(selectedId);
  setTimeout(() => (prog.textContent = ''), 6000);
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

const CONTEXT_KEYS = ['beanName', 'roaster', 'roastLevel', 'process', 'origin', 'doseG', 'grindSize', 'grinderName', 'note'];

function readContext() {
  return {
    beanName: $('ctx-bean').value.trim(),
    roaster: $('ctx-roaster').value.trim(),
    roastLevel: $('ctx-roast').value,
    process: $('ctx-process').value,
    origin: $('ctx-origin').value.trim(),
    doseG: Number($('ctx-dose').value) || 0,
    grindSize: $('ctx-grind').value ? `${$('ctx-grind').value} µm` : '',
    grinderName: $('ctx-grinder').value.trim(),
    note: $('ctx-note').value.trim(),
  };
}

function writeContext(ctx) {
  $('ctx-bean').value = ctx.beanName ?? '';
  $('ctx-roaster').value = ctx.roaster ?? '';
  $('ctx-roast').value = ctx.roastLevel ?? '';
  $('ctx-process').value = ctx.process ?? '';
  $('ctx-origin').value = ctx.origin ?? '';
  $('ctx-dose').value = ctx.doseG || '';
  $('ctx-grind').value = (ctx.grindSize ?? '').replace(/\s*µm$/, '');
  $('ctx-grinder').value = ctx.grinderName ?? '';
  $('ctx-note').value = ctx.note ?? '';
}

/** Rebuild the bean / roaster pick-lists from the bean library. */
/** Rebuild every pick-list (bean, roaster, origin, grinder) and the Settings chips. */
async function refreshBeanLists() {
  const beans = await store.listBeans();
  state.beans = beans;
  $('bean-list').innerHTML = beans.map((b) => `<option value="${esc(b.name)}">${esc([b.roaster, b.roastLevel, b.origin].filter(Boolean).join(' · '))}</option>`).join('');
  $('bean-count').textContent = beans.length ? `(${beans.length} known)` : '';
  state.lists = {};
  for (const kind of LIST_KINDS) {
    const values = await store.listValues(kind);
    state.lists[kind] = values;
    $(`${kind}-list`).innerHTML = values.map((v) => `<option value="${esc(v.value)}">${esc(`used ${v.uses}× · ${new Date(v.lastUsed).toLocaleDateString()}`)}</option>`).join('');
  }
  renderPickListChips();
}

function renderPickListChips() {
  const chip = (label, meta, onRemove) => {
    const el = document.createElement('span');
    el.className = 'chip';
    el.innerHTML = `${esc(label)}${meta ? ` <small>${esc(meta)}</small>` : ''}`;
    const b = document.createElement('button');
    b.type = 'button';
    b.title = `Remove "${label}" from the list`;
    b.setAttribute('aria-label', `Remove ${label}`);
    b.textContent = '×';
    b.addEventListener('click', onRemove);
    el.appendChild(b);
    return el;
  };
  const beanBox = $('list-bean');
  beanBox.innerHTML = '';
  for (const b of state.beans || []) {
    beanBox.appendChild(
      chip(b.name, [b.roaster, `${b.uses || 1}×`].filter(Boolean).join(' · '), async () => {
        await store.deleteBean(b.name);
        log.info('lists', `removed bean "${b.name}"`);
        await refreshBeanLists();
      }),
    );
  }
  for (const kind of LIST_KINDS) {
    const box = $(`list-${kind}`);
    box.innerHTML = '';
    for (const v of state.lists?.[kind] || []) {
      box.appendChild(
        chip(v.value, `${v.uses}×`, async () => {
          await store.forgetValue(kind, v.value);
          log.info('lists', `removed ${kind} "${v.value}"`);
          await refreshBeanLists();
        }),
      );
    }
  }
}

/** Save the free-text fields of a context into their pick-lists. */
async function rememberContextValues(ctx) {
  await store.rememberValue('roaster', ctx.roaster);
  await store.rememberValue('origin', ctx.origin);
  await store.rememberValue('grinder', ctx.grinderName);
}

/** A previous bean was picked (or typed exactly): fill in what we know about it. */
async function beanPicked() {
  const b = await store.getBean($('ctx-bean').value);
  if (!b) return false;
  if (!$('ctx-roaster').value.trim() || b.roaster) $('ctx-roaster').value = b.roaster || '';
  if (b.roastLevel) $('ctx-roast').value = b.roastLevel;
  if (b.process) $('ctx-process').value = b.process;
  if (b.origin) $('ctx-origin').value = b.origin;
  if (!$('ctx-dose').value && b.lastDoseG) $('ctx-dose').value = b.lastDoseG;
  if (!$('ctx-grind').value && b.lastGrind) $('ctx-grind').value = String(b.lastGrind).replace(/\s*µm$/, '');
  return true;
}

async function contextChanged(ev) {
  const id = ev?.target?.id;
  if (id === 'ctx-bean') await beanPicked();
  const ctx = readContext();
  await store.setSetting('context', ctx);
  let listsTouched = false;
  if (ctx.beanName && (id === 'ctx-bean' || id === 'ctx-roaster' || id === 'ctx-roast' || id === 'ctx-process' || id === 'ctx-origin' || id === 'ctx-dose' || id === 'ctx-grind')) {
    await store.rememberBean(ctx);
    listsTouched = true;
  }
  const kindFor = { 'ctx-roaster': ['roaster', ctx.roaster], 'ctx-origin': ['origin', ctx.origin], 'ctx-grinder': ['grinder', ctx.grinderName] };
  if (kindFor[id]) {
    const [kind, value] = kindFor[id];
    if (value && (await store.rememberValue(kind, value))) listsTouched = true;
  }
  if (listsTouched) await refreshBeanLists();
  // Apply to the shot shown too — but only while it is the most recent one, so a bag
  // name typed right after a shot still counts and older shots are edited deliberately
  // (History → Edit) rather than overwritten by preparing the next brew.
  const newest = state.shots.find((x) => !x.inProgress);
  if (state.selected && state.selected.source !== 'demo' && newest?.id === state.selected.id) {
    const prev = state.selected.context || {};
    const changed = CONTEXT_KEYS.some((k) => (prev[k] ?? '') !== (ctx[k] ?? ''));
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
let toastTimer = null;
function toast(msg, level = 'info', ms) {
  if (level === 'error') log.error('ui', msg);
  else log.debug('ui', msg);
  const el = $('toast');
  el.textContent = msg;
  el.dataset.level = level;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms || (level === 'error' ? 7000 : 4500));
}

// ------------------------------------------------------------ log & debug --

const LOG_FOLDER_KEY = 'logFolderHandle';

async function restoreLogFolder() {
  try {
    const handle = await store.getSetting(LOG_FOLDER_KEY, null);
    if (handle && typeof handle.queryPermission === 'function') await log.useFolder(handle);
  } catch (err) {
    log.warn('log', `could not restore the log folder: ${err?.message || err}`);
  }
  renderLogFolder();
}

async function pickLogFolder() {
  try {
    const handle = await log.pickFolder();
    try {
      await store.setSetting(LOG_FOLDER_KEY, handle); // Chrome can persist the handle
    } catch (err) {
      log.warn('log', `folder handle could not be saved for next time: ${err?.message || err}`);
    }
    renderLogFolder();
    toast(`Log folder set to ${handle.name}`);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    toast(err.message || String(err), 'error');
  }
}

async function reallowLogFolder() {
  if (!log.folder) return;
  await log.useFolder(log.folder, { request: true });
  renderLogFolder();
}

async function forgetLogFolder() {
  await log.flush().catch(() => {});
  log.forgetFolder();
  await store.setSetting(LOG_FOLDER_KEY, null);
  renderLogFolder();
}

function renderLogFolder() {
  const name = log.folder?.name;
  const st = log.folderState;
  const el = $('log-folder');
  $('log-reallow-folder').hidden = st !== 'prompt';
  $('log-forget-folder').hidden = !log.folder;
  if (!log.folder) el.textContent = Logger.canPickFolder ? 'No folder chosen — the log stays in the page.' : 'Folder picking needs Chrome or Edge; use Download instead.';
  else if (st === 'granted') el.textContent = `${name}/portal-met-bridge/ — writable${log.bytesWritten ? ` · ${(log.bytesWritten / 1024).toFixed(1)} kB written this session` : ''}${log.lastFlushError ? ' · last error: ' + log.lastFlushError : ''}`;
  else if (st === 'prompt') el.textContent = `${name} — Chrome needs you to re-allow it (click Re-allow folder).`;
  else el.textContent = `${name} — not writable (${st}${log.lastFlushError ? ': ' + log.lastFlushError : ''}).`;
  renderLogStatus();
}

function renderLogStatus() {
  const bits = [];
  bits.push(log.enabled ? `on · ${settings.logLevel}${settings.logPackets ? ' + packets' : ''}` : 'off');
  bits.push(`${log.ring.length} lines in memory${log.dropped ? ` (${log.dropped} dropped)` : ''}`);
  if (log.folder && log.folderState === 'granted') bits.push(`writing to ${log.folder.name}`);
  $('log-status').textContent = bits.join(' · ');
  const tab = document.querySelector('.view-tab[data-view="settings"]');
  let badge = tab.querySelector('.badge');
  if (log.enabled && !badge) {
    badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'debug';
    tab.appendChild(badge);
  } else if (!log.enabled && badge) badge.remove();
}

let tailDirty = true;
function renderLogTail() {
  const el = $('log-tail');
  if (!settings.logShowTail || $('view-settings').hidden) return;
  if (!tailDirty) return;
  tailDirty = false;
  const lines = log.ring.slice(-300);
  el.innerHTML = lines.map((e) => `<span class="lvl-${e.level}">${esc(formatLine(e))}</span>`).join('\n');
  el.scrollTop = el.scrollHeight;
  renderLogStatus();
}
log.addEventListener('entry', () => {
  tailDirty = true;
});
log.addEventListener('cleared', () => {
  tailDirty = true;
  renderLogTail();
});
log.addEventListener('folder', () => renderLogFolder());
setInterval(renderLogTail, 700);
window.addEventListener('beforeunload', () => {
  log.flush().catch(() => {});
});

async function downloadLog(json = false) {
  await log.flush().catch(() => {});
  const name = `portal-met-bridge-log-${stamp(Date.now())}.${json ? 'jsonl' : 'txt'}`;
  await deliver(name, json ? log.asJsonLines() : log.asText(), 'text/plain', 'logs');
}

async function copyLogTail() {
  try {
    await navigator.clipboard.writeText(log.ring.slice(-200).map(formatLine).join('\n'));
    toast('Copied the last 200 log lines.');
  } catch (err) {
    toast('Copy failed: ' + (err.message || err), 'error');
  }
}

// -------------------------------------------------------------- start over --

let erasing = false;

async function openResetDialog() {
  const dlg = $('reset-dialog');
  const shots = await store.listShots({ limit: 100000 });
  const beans = await store.listBeans({ limit: 100000 });
  const withReadings = shots.filter((s) => s.refractometer?.tdsPct).length;
  const reviews = await store.listReviews({ limit: 100000 });
  const keys = ['aiKeyAnthropic', 'aiKeyOpenai', 'aiKeyGoogle'].filter((k) => settings[k]).length;
  const items = [
    `${shots.length} shot${shots.length === 1 ? '' : 's'} with ${shots.length === 1 ? 'its' : 'their'} samples${withReadings ? ` (${withReadings} with refractometer readings)` : ''}`,
    `${beans.length} bean${beans.length === 1 ? '' : 's'} in the bean library and the roaster / origin / grinder pick-lists`,
    `${reviews.length} saved AI review${reviews.length === 1 ? '' : 's'}`,
    `all settings (machine address, recording, estimates, logging, AI review${keys ? ` including ${keys} API key${keys === 1 ? '' : 's'}` : ''}) and the current coffee`,
    `the debug log in this page (${log.ring.length} lines)`,
  ];
  if (portal.device) items.push(`the Bluetooth pairing with ${portal.device.name || 'the Portal'} (Chrome will ask you to pick it again)`);
  $('reset-list').innerHTML = items.map((t) => `<li>${esc(t)}</li>`).join('');
  const hasFolder = !!log.folder;
  $('reset-folder-row').hidden = !hasFolder;
  if (hasFolder) {
    $('reset-folder-label').textContent = `Also delete the files this app wrote in ${log.folder.name}/portal-met-bridge/ (logs, exports, backups)${log.folderState !== 'granted' ? ' — folder access must be re-allowed first' : ''}`;
    $('reset-folder').checked = log.folderState === 'granted';
    $('reset-folder').disabled = log.folderState !== 'granted';
  }
  $('reset-confirm').value = '';
  $('reset-go').disabled = true;
  $('reset-progress').textContent = '';
  $('reset-progress').dataset.level = 'bad';
  dlg.showModal();
  $('reset-confirm').focus();
}

async function eraseEverything() {
  if (erasing) return;
  erasing = true;
  const prog = $('reset-progress');
  const say = (t, level = 'warn') => {
    prog.textContent = t;
    prog.dataset.level = level;
  };
  const report = [];
  $('reset-go').disabled = true;
  $('reset-cancel').disabled = true;
  $('reset-confirm').disabled = true;
  const wipeFolder = !$('reset-folder-row').hidden && $('reset-folder').checked && !$('reset-folder').disabled;
  log.info('reset', `erase everything requested${wipeFolder ? ' (including the save folder contents)' : ''}`);
  try {
    // 1. Devices: stop streams, forget the Portal pairing.
    say('Disconnecting…');
    stopLiveLoop();
    recorder.reset();
    try {
      await portal.disconnect();
      if (portal.device?.forget) {
        await portal.device.forget();
        report.push('Portal pairing forgotten');
      }
    } catch (err) {
      report.push(`Portal: ${err?.message || err}`);
    }
    try {
      machinePanel.detach();
      meticulous?.disconnect();
      meticulous = null;
    } catch {
      /* ignore */
    }

    // 2. Files in the save folder (only our own subfolder), then stop using the folder.
    if (wipeFolder) {
      say('Deleting files in the save folder…');
      try {
        const folderName = log.folder?.name || 'folder';
        const removed = await log.eraseFolderContents();
        report.push(removed ? `deleted ${folderName}/portal-met-bridge/` : 'save folder had no app files');
      } catch (err) {
        report.push(`save folder: ${err?.message || err}`);
      }
    } else {
      log.forgetFolder(); // never recreate logs after the wipe
    }

    // 3. The database (shots, beans, settings, folder handle) and any other storage.
    say('Deleting the database…');
    await store.close();
    const results = await deleteAllDatabases();
    for (const r of results) {
      if (r.name === 'portal-met-bridge') report.push(r.ok && !r.blocked ? 'database deleted' : `database: ${r.error || 'blocked'} — close other tabs of this app`);
    }
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* not available */
    }
    try {
      if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
    } catch {
      /* ignore */
    }
    log.clear();

    // 4. Restart into defaults.
    const bad = results.some((r) => r.name === 'portal-met-bridge' && (!r.ok || r.blocked));
    say(`${report.join(' · ')}. ${bad ? 'Reload once the other tabs are closed.' : 'Restarting…'}`, bad ? 'bad' : 'ok');
    if (!bad) setTimeout(() => location.replace(location.pathname), 1200);
    else {
      $('reset-cancel').disabled = false;
      $('reset-cancel').textContent = 'Close';
      erasing = false;
    }
  } catch (err) {
    say(`Could not finish: ${err?.message || err}. Nothing more will be changed; reload the page.`, 'bad');
    $('reset-cancel').disabled = false;
    $('reset-cancel').textContent = 'Close';
    erasing = false;
  }
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

$('rec-manual').addEventListener('click', () => (recorder.isRecording ? recorder.stopManual() : recorder.startManual()));
// Two kinds of setting control:
//  - toggles and drop-downs commit the moment they change (one click, nothing to mistype);
//  - typed fields (address, seconds, counts) wait for Enter, ⌘/Ctrl+S, the Save button or
//    leaving the tab, so a half-typed address is never committed by a stray click and
//    "Discard changes" can really discard it. The save bar shows which fields are pending.
for (const [key, spec] of Object.entries(SETTINGS)) {
  const el = $(spec.el);
  if (!el) continue;
  const typed = el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
  if (typed) {
    el.addEventListener('input', () => renderSavebar());
    el.addEventListener('change', () => renderSavebar()); // blur just refreshes the bar; nothing is saved yet
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveAllSettings();
      }
    });
  } else {
    el.addEventListener('change', () => settingChanged(key).catch((err) => renderSavebar('error', `Could not save ${SETTING_LABELS[key] || key}: ${err?.message || err}`)));
  }
}
$('settings-save').addEventListener('click', () => saveAllSettings());
$('settings-discard').addEventListener('click', discardSettingChanges);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !$('view-settings').hidden) {
    e.preventDefault();
    saveAllSettings();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (erasing) return;
  if (recorder.isRecording) checkpointLiveShot(true); // best effort; the periodic checkpoint is the real guarantee
  if ((!$('view-settings').hidden && dirtySettings().length) || recorder.isRecording) {
    e.preventDefault();
    e.returnValue = '';
  }
});
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));
$('meticulous-test').addEventListener('click', testMeticulous);
$('settings-export').addEventListener('click', () => deliver(`portal-met-bridge-settings-${stamp(Date.now())}.json`, JSON.stringify(settingsDocument(), null, 2), 'application/json', 'backups'));
$('settings-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const n = await importSettingsDocument(JSON.parse(await file.text()));
    toast(`Imported ${n} settings.`);
    log.info('settings', `imported ${n} settings from ${file.name}`);
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
  e.target.value = '';
});
$('settings-reset').addEventListener('click', async () => {
  if (!confirm('Reset every setting to its default? Shots, beans and the log folder are kept.')) return;
  await resetSettings();
  toast('Settings reset to defaults.');
});
$('reset-all').addEventListener('click', openResetDialog);
$('reset-confirm').addEventListener('input', (e) => {
  $('reset-go').disabled = e.target.value.trim().toUpperCase() !== 'ERASE';
});
$('reset-confirm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!$('reset-go').disabled) eraseEverything();
  }
});
$('reset-go').addEventListener('click', eraseEverything);
$('reset-cancel').addEventListener('click', () => $('reset-dialog').close());
$('reset-dialog').addEventListener('cancel', (e) => {
  if (erasing) e.preventDefault(); // Esc must not interrupt a wipe in progress
});
$('log-pick-folder').addEventListener('click', pickLogFolder);
$('log-reallow-folder').addEventListener('click', reallowLogFolder);
$('log-forget-folder').addEventListener('click', forgetLogFolder);
$('log-download').addEventListener('click', () => downloadLog(false));
$('log-download-json').addEventListener('click', () => downloadLog(true));
$('log-copy').addEventListener('click', copyLogTail);
$('log-clear').addEventListener('click', () => log.clear());
for (const id of ['ctx-bean', 'ctx-roaster', 'ctx-roast', 'ctx-process', 'ctx-origin', 'ctx-dose', 'ctx-grind', 'ctx-grinder', 'ctx-note']) $(id).addEventListener('change', contextChanged);

$('ref-tds').addEventListener('input', updateRefEy);
$('ref-bev').addEventListener('input', updateRefEy);
$('ref-save').addEventListener('click', saveRefractometer);
$('ref-clear').addEventListener('click', clearRefractometer);
$('shot-delete').addEventListener('click', deleteShot);
$('shot-edit').addEventListener('click', () => state.selected && openShotDialog(state.selected));
$('shot-prev').addEventListener('click', () => stepShot(-1));
$('shot-next').addEventListener('click', () => stepShot(1));
$('hist-rows').addEventListener('click', onHistoryClick);
$('hist-rows').addEventListener('dblclick', (ev) => {
  const tr = ev.target.closest('tr[data-id]');
  if (tr && !ev.target.matches('input, button')) selectShot(tr.dataset.id, { show: true });
});
$('hist-rows').addEventListener('keydown', (ev) => {
  const tr = ev.target.closest('tr[data-id]');
  if (tr && ev.key === 'Enter' && !ev.target.matches('input, button')) selectShot(tr.dataset.id, { show: true });
});
$('hist-search').addEventListener('input', () => { hist.search = $('hist-search').value; renderHistory(); });
$('hist-filter').addEventListener('change', () => { hist.filter = $('hist-filter').value; renderHistory(); });
document.querySelectorAll('#hist-table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  if (hist.sort === key) hist.dir = hist.dir === 'asc' ? 'desc' : 'asc';
  else { hist.sort = key; hist.dir = key === 'startedAt' || key === 'meanEc' || key === 'tds' || key === 'finalWeightG' || key === 'durationSec' ? 'desc' : 'asc'; }
  renderHistory();
}));
$('hist-select-all').addEventListener('change', () => {
  const rows = state.shots.filter((x) => histMatches(x) && !x.inProgress);
  if ($('hist-select-all').checked) rows.forEach((x) => hist.checked.add(x.id));
  else rows.forEach((x) => hist.checked.delete(x.id));
  renderHistory();
});
$('hist-delete-selected').addEventListener('click', () => deleteShots([...hist.checked]));
$('hist-compare').addEventListener('click', () => openCompare([...hist.checked]));
$('hist-analyze').addEventListener('click', () => openAnalysis([...hist.checked]));
$('cmp-close').addEventListener('click', closeCompare);
$('cmp-series').addEventListener('change', () => { compare.series = $('cmp-series').value; renderCompare().catch((err) => toast(`Could not draw the comparison: ${err?.message || err}`, 'error')); });
$('cmp-x').addEventListener('change', () => { compare.x = $('cmp-x').value; renderCompare().catch((err) => toast(`Could not draw the comparison: ${err?.message || err}`, 'error')); });
$('cmp-legend').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-id]');
  if (tr && ev.target.closest('button[data-act="open"]')) selectShot(tr.dataset.id, { show: true });
});
$('shot-form').addEventListener('submit', (ev) => { ev.preventDefault(); saveShotDialog().catch((err) => toast(`Could not save: ${err?.message || err}`, 'error')); });
$('shot-dialog-cancel').addEventListener('click', () => $('shot-dialog').close());
$('shot-refresh').addEventListener('click', () => state.selected && refreshFromMachine(state.selected.id));
$('mach-last').addEventListener('click', fetchLastFromMachine);
$('bc-copy').addEventListener('click', copyFullLink);
$('bc-open').addEventListener('click', openLink);
$('bc-json').addEventListener('click', downloadEnvelope);
$('dl-csv').addEventListener('click', downloadCsv);
$('dl-json').addEventListener('click', downloadShotJson);
$('dl-jpeg').addEventListener('click', downloadJpegs);
$('dl-pdf').addEventListener('click', downloadPdf);
$('dl-summary').addEventListener('click', downloadSummaryCsv);
$('dl-zip').addEventListener('click', downloadZip);
$('demo-load').addEventListener('click', addDemoShot);
$('demo-replay').addEventListener('click', replayDemoLive);
$('backup-export').addEventListener('click', async () => {
  const doc = await store.exportAll();
  await deliver(`portal-met-bridge-backup-${stamp(Date.now())}.json`, JSON.stringify(doc), 'application/json', 'backups');
  $('backup-note').textContent = `${doc.shots.length} shots, ${doc.beans.length} beans.`;
});
$('backup-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const n = await store.importAll(JSON.parse(await file.text()));
    await refreshBeanLists();
    await refreshShotList();
    toast(`Restored ${n} shots.`);
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
  e.target.value = '';
});

// Handy in the console while debugging: window.__pb.state.selected, .massChart.u, ...

// ------------------------------------------------------------ brew control --
// The dial's actions, over the machine's own API (api/action.py): start is the
// dial click, abort ends a running profile safely, preheat heats the group.

function renderBrewProfiles() {
  const sel = $('brew-profile');
  if (!sel) return;
  const current = sel.value;
  const list = state.profileList || [];
  sel.innerHTML = list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.finalWeightG ? ` · ${fmt(p.finalWeightG, 0)} g` : ''}${p.temperatureC ? ` · ${fmt(p.temperatureC, 0)} °C` : ''}</option>`).join('');
  const loaded = meticulous?.lastStatus?.profile;
  const match = list.find((p) => p.id === current) || list.find((p) => p.name === loaded) || list[0];
  if (match) sel.value = match.id;
  $('brew-load').disabled = !list.length;
}

let brewStateText = '';
function renderBrewState(s) {
  const el = $('brew-state');
  if (!el || $('brew-controls').hidden) return;
  const name = (s.name || '').trim();
  const ready = /click to start/i.test(name);
  const heating = /heating/i.test(name) || /heating/i.test(s.state || '');
  const busy = s.extracting || (s.state === 'brewing' && !ready && !heating);
  const text = `${ready ? 'Ready — click to start' : heating ? 'Heating' : busy ? name || 'Brewing' : name || s.state || 'idle'}${Number.isFinite(s.temp) ? ` · ${fmt(s.temp, 1)} °C` : ''}${s.profile ? ` · ${s.profile}` : ''}`;
  if (text !== brewStateText) {
    brewStateText = text;
    el.textContent = text;
    el.dataset.ready = String(ready);
    $('brew-start').textContent = ready ? 'Start brew now' : s.extracting ? 'Brewing…' : 'Start brew';
    $('brew-start').disabled = !!s.extracting;
    $('brew-stop').disabled = !(s.extracting || heating || ready || s.state === 'brewing');
    $('brew-preheat').disabled = !!s.extracting || heating || ready;
    $('brew-load').disabled = !!s.extracting || !(state.profileList || []).length;
  }
}

async function brewAction(name, label) {
  if (!meticulous?.connected) return toast('Connect the machine first.', 'error');
  const btn = { start: 'brew-start', abort: 'brew-stop', preheat: 'brew-preheat', tare: 'brew-tare' }[name];
  const el = btn && $(btn);
  if (el) el.disabled = true;
  try {
    await meticulous.action(name);
    log.info('machine', `action ${name} accepted`);
    toast(label);
  } catch (err) {
    log.warn('machine', `action ${name} failed: ${err?.message || err}`);
    toast(`The machine did not accept "${name}": ${err?.message || err}`, 'error');
  } finally {
    if (el) setTimeout(() => (el.disabled = false), 800);
    brewStateText = ''; // force the next status to re-render the buttons
  }
}

$('brew-start').addEventListener('click', () => brewAction('start', /click to start/i.test(meticulous?.lastStatus?.name || '') ? 'Shot started.' : 'Start sent — the machine heats and then waits at "click to start"; press again (or press the dial) to begin the shot.'));
$('brew-stop').addEventListener('click', () => brewAction('abort', 'Stop sent.'));
$('brew-preheat').addEventListener('click', () => brewAction('preheat', 'Preheating.'));
$('brew-tare').addEventListener('click', () => brewAction('tare', 'Scale tared.'));
$('brew-load').addEventListener('click', async () => {
  const id = $('brew-profile').value;
  const p = (state.profileList || []).find((x) => x.id === id);
  if (!p || !meticulous?.connected) return;
  $('brew-load').disabled = true;
  try {
    const r = await meticulous.loadProfile(id);
    log.info('machine', `profile loaded: ${r?.name || p.name}`);
    toast(`Loaded "${r?.name || p.name}" on the machine.`);
  } catch (err) {
    toast(`Could not load the profile: ${err?.message || err}`, 'error');
  } finally {
    $('brew-load').disabled = false;
  }
});

// -------------------------------------------------------------- AI review --

const REVIEW_MAX = 8;
const an = { ids: [], search: '', running: false, failed: false, abort: null, markdown: '', digests: [], shots: [], meta: null, savedId: null, chartShotId: null, chart: null };

/** Provider, key and model currently chosen in Settings. */
function aiConfig() {
  const provider = PROVIDERS[settings.aiProvider] ? settings.aiProvider : 'anthropic';
  const keyKey = { anthropic: 'aiKeyAnthropic', openai: 'aiKeyOpenai', google: 'aiKeyGoogle' }[provider];
  const modelKey = { anthropic: 'aiModelAnthropic', openai: 'aiModelOpenai', google: 'aiModelGoogle' }[provider];
  return { provider, key: settings[keyKey] || '', model: (settings[modelKey] || '').trim() || PROVIDERS[provider].defaultModel, baseUrl: provider === 'openai' ? settings.aiBaseOpenai || '' : '' };
}

function renderAiSettings() {
  const { provider, key, model, baseUrl } = aiConfig();
  document.querySelectorAll('.ai-provider').forEach((el) => (el.hidden = el.dataset.provider !== provider));
  const label = PROVIDERS[provider].label;
  const note = key ? `${label} · ${model}${baseUrl ? ` · ${baseUrl.replace(/^https?:\/\//, '')}` : ''} · key ${maskKey(key)}` : `${label} · no API key yet`;
  setText('set-ai-note', note);
  setText('an-provider-note', note);
  const run = $('an-run');
  if (run) {
    run.textContent = `Review with ${label.replace(/ \(.*\)$/, '')}`;
    run.disabled = an.running || !an.ids.length || !key;
  }
}

$('set-ai-provider').addEventListener('input', renderAiSettings); // provider is a select → saves on change; keep the blocks in step while picking
document.querySelectorAll('button.reveal').forEach((b) =>
  b.addEventListener('click', () => {
    const input = $(b.dataset.reveal);
    input.type = input.type === 'password' ? 'text' : 'password';
    b.textContent = input.type === 'password' ? 'Show' : 'Hide';
  }),
);

/** The key/model typed right now (unsaved edits count), so Test and List work before Save. */
function aiConfigFromInputs() {
  const provider = $('set-ai-provider').value;
  const key = $(`set-ai-key-${provider}`).value.trim();
  const model = $(`set-ai-model-${provider}`).value.trim() || PROVIDERS[provider].defaultModel;
  const baseUrl = provider === 'openai' ? $('set-ai-base-openai').value.trim() : '';
  return { provider, key, model, baseUrl };
}

$('set-ai-models').addEventListener('click', async () => {
  const { provider, key, baseUrl } = aiConfigFromInputs();
  const out = $('set-ai-test-result');
  if (!key) return (out.textContent = 'Paste an API key first.');
  out.textContent = 'Asking for the model list…';
  try {
    const models = await listModels(provider, { key, baseUrl });
    const dl = $(`ai-models-${provider}`);
    dl.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    out.textContent = models.length ? `${models.length} models — start typing in the Model field to pick one${models[0] ? ` (newest: ${models[0].id})` : ''}.` : 'The key works but the list came back empty.';
    log.info('ai', `${provider}: ${models.length} models listed`);
  } catch (err) {
    out.textContent = err?.message || String(err);
    log.warn('ai', `list models failed: ${err?.message || err}`);
  }
});

$('set-ai-test').addEventListener('click', async () => {
  const { provider, key, model, baseUrl } = aiConfigFromInputs();
  const out = $('set-ai-test-result');
  if (!key) return (out.textContent = 'Paste an API key first.');
  out.textContent = `Testing ${model}…`;
  try {
    const t0 = performance.now();
    const reply = await testKey(provider, { key, model, baseUrl });
    out.textContent = `${PROVIDERS[provider].label} answered in ${((performance.now() - t0) / 1000).toFixed(1)} s with “${reply.slice(0, 40)}”.${dirtySettings().some((k) => k.startsWith('ai')) ? ' Press Save settings to keep the key.' : ''}`;
    log.info('ai', `${provider}/${model}: key test ok`);
  } catch (err) {
    out.textContent = err?.message || String(err);
    log.warn('ai', `key test failed: ${err?.message || err}`);
  }
});

/** Open the Analysis tab with these shots ticked. */
function openAnalysis(ids) {
  const valid = (ids || []).filter((id) => state.shots.some((s) => s.id === id && !s.inProgress)).slice(0, REVIEW_MAX);
  an.ids = valid;
  an.savedId = null;
  showView('analysis');
}

function shotLabel(s) {
  const c = s.context || {};
  return `${fmtDate(s.startedAt)} · ${c.beanName || 'unnamed coffee'} · ${s.profileName || 'no profile'}${c.doseG ? ` · ${fmt(Number(c.doseG), 1)} → ${fmt(beverageOf(s), 1)} g` : ''}`;
}

function renderAnalysis() {
  renderAnalysisList();
  renderAiSettings();
  renderAnalysisDigest();
  renderAnalysisSize();
}

function renderAnalysisList() {
  const ul = $('an-list');
  const q = an.search.trim().toLowerCase();
  const shots = state.shots.filter((s) => !s.inProgress).filter((s) => !q || histMatches({ ...s, context: s.context || {} }) || shotLabel(s).toLowerCase().includes(q));
  const shown = shots.slice(0, 60);
  ul.innerHTML = shown
    .map((s) => {
      const on = an.ids.includes(s.id);
      const c = s.context || {};
      const tags = [s.portal?.length ? `P ${s.portal.length}` : 'no Portal', s.machineShotId ? 'record' : 'live', c.grindSize ? `${esc(c.grindSize)}` : ''].filter(Boolean);
      return `<li class="${on ? 'on' : ''}"><label><input type="checkbox" data-id="${esc(s.id)}" ${on ? 'checked' : ''} /> <span class="when">${esc(fmtDate(s.startedAt))}</span> <span class="what">${esc(c.beanName || 'unnamed coffee')} <small>${esc(s.profileName || '')}</small></span> <span class="tags">${tags.map((t) => `<span class="tag">${t}</span>`).join('')}</span></label></li>`;
    })
    .join('');
  if (!shown.length) ul.innerHTML = `<li class="empty">${state.shots.length ? 'No shot matches.' : 'No shots recorded yet.'}</li>`;
  setText('an-sel-count', an.ids.length ? `(${an.ids.length})` : '');
  $('an-run').disabled = an.running || !an.ids.length || !aiConfig().key;
}

$('an-search').addEventListener('input', () => {
  an.search = $('an-search').value;
  renderAnalysisList();
});
$('an-list').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type=checkbox]');
  if (!cb) return;
  const id = cb.dataset.id;
  if (cb.checked) {
    if (an.ids.length >= REVIEW_MAX) {
      cb.checked = false;
      return toast(`Up to ${REVIEW_MAX} shots per review.`, 'error');
    }
    an.ids.push(id);
  } else an.ids = an.ids.filter((x) => x !== id);
  an.ids.sort((a, b) => (state.shots.find((s) => s.id === a)?.startedAt || 0) - (state.shots.find((s) => s.id === b)?.startedAt || 0));
  an.savedId = null;
  renderAnalysis();
});

/** Full analysis (not the cached summary) for the digest. */
function fullAnalysis(shot) {
  const lag = Number.isFinite(shot.lagSec) ? shot.lagSec : 0;
  return analyzeShot(shot.portal || [], (shot.machine || []).map((s) => ({ t: s.t, w: s.w })), { doseG: Number(shot.context?.doseG) || 0, lagSec: lag, stopTimeSec: shot.durationSec });
}

/** Digest + compact profile for every ticked shot, oldest first. */
function prepareReview() {
  const shots = an.ids.map((id) => state.shots.find((s) => s.id === id)).filter(Boolean).sort((a, b) => a.startedAt - b.startedAt);
  const items = shots.map((shot) => {
    const digest = buildShotDigest(shot, fullAnalysis(shot));
    const profile = compactProfile(shot.machineSource?.profile);
    return { shot, digest, profile };
  });
  an.shots = items.map((x) => x.shot);
  an.digests = items.map((x) => x.digest);
  return items;
}

function renderAnalysisSize() {
  const el = $('an-size');
  if (!an.ids.length) return (el.textContent = '');
  const items = prepareReview();
  const { system, user } = buildReviewMessages(items.map(({ digest, profile }) => ({ digest, profile })), reviewOptions());
  const tokens = approxTokens(system + user);
  const noPortal = items.filter((x) => !x.digest.hasPortal).length;
  el.textContent = `About ${tokens.toLocaleString()} tokens will be sent (${items.length} shot${items.length === 1 ? '' : 's'}${noPortal ? `, ${noPortal} without Portal data` : ''}).`;
}

function reviewOptions() {
  return { grindStepUm: settings.aiGrindStepUm || 5, drink: settings.aiDrink || 'espresso', standingNotes: settings.aiNotes || '', taste: $('an-taste').value.trim(), question: $('an-question').value.trim() };
}

function stageTable(d) {
  if (!d.stages.length) return '<p class="hint">No machine samples for this shot.</p>';
  const rows = d.stages
    .map(
      (st) =>
        `<tr><td>${esc(st.name)}</td><td class="num">${fmt(st.fromSec, 1)}–${fmt(st.toSec, 1)} s</td><td class="num">${st.waterInMl != null ? `${fmt(st.waterInMl, 0)} ml` : '–'}</td><td class="num">${fmt(st.cupStartG, 1)} → ${fmt(st.cupEndG, 1)} g</td><td class="num">${st.pressureMaxBar != null ? `${fmt(st.pressureMaxBar, 1)} bar` : '–'}${st.pressureEndBar != null ? ` <small>→ ${fmt(st.pressureEndBar, 1)}</small>` : ''}</td><td class="num">${st.flowMeanMlPerS != null ? `${fmt(st.flowMeanMlPerS, 2)} ml/s` : '–'}</td><td class="num">${st.tempStartC != null ? `${fmt(st.tempStartC, 1)} → ${fmt(st.tempEndC, 1)} °C` : '–'}</td><td class="num">${d.hasPortal ? `${st.ecStart != null ? fmt(st.ecStart, 1) : '–'} → ${st.ecEnd != null ? fmt(st.ecEnd, 1) : '–'}` : '<span class="muted">no Portal</span>'}</td></tr>`,
    )
    .join('');
  const t = d.timeline;
  const drips = t.pumpStopSec != null ? `<tr class="drips"><td>Drips</td><td class="num">${fmt(t.pumpStopSec, 1)}–${fmt(t.lastSampleSec, 1)} s</td><td class="num">–</td><td class="num">${fmt(t.cupAtPumpStopG, 1)} → ${fmt(t.cupAtEndG, 1)} g</td><td class="num">–</td><td class="num">–</td><td class="num">–</td><td class="num">${d.hasPortal && d.ec ? `${fmt(d.ec.finalEc, 1)} at the end` : ''}</td></tr>` : '';
  const shares = d.ec?.solublesShareByStageEnd?.length ? `<p class="hint">Share of ∫EC dm in the cup by stage end: ${d.ec.solublesShareByStageEnd.map((x) => `${esc(x.stage)} ${x.solublesPctByEnd ?? '–'}%`).join(' · ')}${Object.keys(d.ec.solublesShareAtCupMass || {}).length ? ` — by cup mass: ${Object.entries(d.ec.solublesShareAtCupMass).map(([k, v]) => `${k} ${v}%`).join(', ')}` : ''}.</p>` : d.hasPortal ? '' : '<p class="hint">No Portal data: concentration is unknown for this shot; the review uses pressure, flow, cup weight and temperature.</p>';
  return `<table class="stages"><thead><tr><th>Stage</th><th class="num">Time</th><th class="num">Water in</th><th class="num">Cup</th><th class="num">Pressure peak → end</th><th class="num">Flow</th><th class="num">Water temp</th><th class="num">EC start → end</th></tr></thead><tbody>${rows}${drips}</tbody></table>${shares}`;
}

function renderAnalysisDigest() {
  const panel = $('an-digest-panel');
  if (!an.ids.length) {
    panel.hidden = true;
    return;
  }
  const items = prepareReview();
  panel.hidden = false;
  $('an-digest').innerHTML = items
    .map(({ shot, digest }) => {
      const m = digest.meta;
      const head = `<h3>${esc(shotLabel(shot))}</h3><p class="hint">${[m.grindUm ? `${fmt(m.grindUm, 0)} µm` : 'no grind recorded', m.doseG ? `${fmt(m.doseG, 1)} g in` : 'no dose', `${fmt(m.beverageG, 1)} g out (${m.beverageSource === 'profile' ? 'profile target' : m.beverageSource === 'weighed' ? 'weighed' : 'scale'})`, m.ratio ? `1 : ${fmt(m.ratio, 2)}` : null, `${fmt(m.durationSec, 1)} s`, m.profileTargetG ? `target ${fmt(m.profileTargetG, 1)} g` : null, m.profileTemperatureC ? `setpoint ${fmt(m.profileTemperatureC, 0)} °C` : null, digest.ec ? `mean EC/g ${fmt(digest.ec.meanEcPerG, 3)}` : null].filter(Boolean).join(' · ')}</p>`;
      const gaps = digest.gaps.length ? `<ul class="gaps">${digest.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : '';
      return `<div class="an-shot">${head}${gaps}${stageTable(digest)}</div>`;
    })
    .join('');
  // chart picker
  const sel = $('an-chart-shot');
  sel.innerHTML = items.map(({ shot }) => `<option value="${esc(shot.id)}">${esc(shotLabel(shot))}</option>`).join('');
  if (!items.some((x) => x.shot.id === an.chartShotId)) an.chartShotId = items[items.length - 1].shot.id;
  sel.value = an.chartShotId;
  renderAnalysisChart();
}

function renderAnalysisChart() {
  const shot = an.shots.find((s) => s.id === an.chartShotId) || an.shots[an.shots.length - 1];
  if (!shot) return;
  if (!an.chart) an.chart = new TimeChart($('an-chart'));
  an.chart.u.setSize({ width: Math.max(320, $('an-chart').clientWidth), height: 300 });
  an.chart.setShot(shot.machine || [], (shot.portal || []).map((p) => ({ ...p, t: p.t + (Number.isFinite(shot.lagSec) ? shot.lagSec : 0) })));
}
$('an-chart-shot').addEventListener('change', () => {
  an.chartShotId = $('an-chart-shot').value;
  renderAnalysisChart();
});
$('an-taste').addEventListener('input', renderAnalysisSize);
$('an-question').addEventListener('input', renderAnalysisSize);

let reportRenderTimer = null;
function renderReport() {
  const panel = $('an-report-panel');
  panel.hidden = !an.markdown && !an.running;
  $('an-report').innerHTML = renderMarkdown(an.markdown) + (an.running ? '<p class="streaming">…</p>' : '');
  const m = an.meta;
  $('an-report-title').textContent = m?.title || 'Review';
  $('an-report-meta').textContent = m ? `${fmtDate(m.createdAt)} · ${PROVIDERS[m.provider]?.label || m.provider} · ${m.model}${m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(0)} s` : ''}${an.savedId ? ' · saved' : ''}` : '';
  const done = !!an.markdown && !an.running;
  $('an-save').disabled = !done || !!an.savedId || an.failed;
  $('an-save').textContent = an.savedId ? 'Saved' : 'Save review';
  $('an-download').disabled = !done;
  $('an-copy').disabled = !done;
}

async function runReview() {
  if (an.running) return;
  const { provider, key, model, baseUrl } = aiConfig();
  if (!key) return toast('Add an API key under Settings → AI review first.', 'error');
  if (!an.ids.length) return toast('Tick at least one shot.', 'error');
  const items = prepareReview();
  const options = reviewOptions();
  const { system, user } = buildReviewMessages(items.map(({ digest, profile }) => ({ digest, profile })), options);
  an.running = true;
  an.failed = false;
  an.markdown = '';
  an.savedId = null;
  an.meta = { createdAt: Date.now(), provider, model, title: reviewTitle(an.digests), shotIds: items.map((x) => x.shot.id), shotLabels: items.map((x) => shotLabel(x.shot)), taste: options.taste, question: options.question, durationMs: 0 };
  const ctrl = new AbortController();
  an.abort = ctrl;
  $('an-stop').hidden = false;
  $('an-run').disabled = true;
  const status = $('an-status');
  const t0 = performance.now();
  const tick = setInterval(() => (status.textContent = `${PROVIDERS[provider].label} is writing… ${((performance.now() - t0) / 1000).toFixed(0)} s`), 500);
  status.textContent = `Sending ${approxTokens(system + user).toLocaleString()} tokens to ${PROVIDERS[provider].label}…`;
  renderReport();
  log.info('ai', `review started: ${provider}/${model}, ${items.length} shot(s)`);
  try {
    await streamCompletion(
      provider,
      { key, model, baseUrl, system, user },
      {
        signal: ctrl.signal,
        onDelta: (d) => {
          an.markdown += d;
          if (!reportRenderTimer) reportRenderTimer = setTimeout(() => { reportRenderTimer = null; renderReport(); }, 150);
        },
      },
    );
    an.meta.durationMs = performance.now() - t0;
    status.textContent = `Done in ${(an.meta.durationMs / 1000).toFixed(0)} s.`;
    log.info('ai', `review finished: ${an.markdown.length} chars in ${(an.meta.durationMs / 1000).toFixed(1)} s`);
  } catch (err) {
    if (err?.name === 'AbortError') {
      status.textContent = 'Stopped.';
      an.markdown += '\n\n*Stopped before the end.*';
    } else {
      status.textContent = '';
      an.failed = !an.markdown; // a failure before any text arrived leaves nothing worth saving
      an.markdown += `\n\n**The request failed:** ${err?.message || err}`;
      toast(err?.message || String(err), 'error');
      log.warn('ai', `review failed: ${err?.message || err}`);
    }
  } finally {
    clearInterval(tick);
    an.running = false;
    an.abort = null;
    $('an-stop').hidden = true;
    renderAiSettings();
    renderReport();
  }
}
$('an-run').addEventListener('click', runReview);
$('an-stop').addEventListener('click', () => an.abort?.abort());

function reviewMarkdownFile(rev) {
  const head = [`# ${rev.title}`, '', `${new Date(rev.createdAt).toLocaleString()} · ${PROVIDERS[rev.provider]?.label || rev.provider} · ${rev.model}`, '', `Shots: ${rev.shotLabels.map((l) => `- ${l}`).join('\n')}`, rev.taste ? `\nTaste: ${rev.taste}` : '', rev.question ? `\nQuestion: ${rev.question}` : '', '', '---', ''].join('\n');
  return head + rev.markdown.trim() + '\n\n*Written by an AI model from the recorded samples; check numbers against the shot before acting on them.*\n';
}

async function saveReview() {
  if (!an.markdown || an.running) return;
  const rev = { id: `rev-${Date.now()}`, ...an.meta, markdown: an.markdown, digests: an.digests.map(({ series, ...rest }) => rest), app: $('about-version').textContent };
  await store.putReview(rev);
  an.savedId = rev.id;
  toast('Review saved.');
  log.info('ai', `review saved: ${rev.id}`);
  renderReport();
  await renderSavedReviews();
}
$('an-save').addEventListener('click', saveReview);
$('an-download').addEventListener('click', () => {
  const rev = { ...an.meta, markdown: an.markdown };
  const base = `review-${stamp(rev.createdAt)}-${(an.digests[an.digests.length - 1]?.meta?.coffee?.bean || 'shot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  deliver(`${base}.md`, reviewMarkdownFile(rev), 'text/markdown', 'reviews');
});
$('an-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(reviewMarkdownFile({ ...an.meta, markdown: an.markdown }));
    toast('Copied as Markdown.');
  } catch {
    toast('Could not copy (clipboard blocked).', 'error');
  }
});

async function renderSavedReviews() {
  const rows = await store.listReviews();
  setText('analysis-tab-count', rows.length ? `(${rows.length})` : '');
  setText('an-saved-count', rows.length ? `(${rows.length})` : '');
  $('an-saved-empty').hidden = rows.length > 0;
  $('an-saved').hidden = rows.length === 0;
  $('an-saved-rows').innerHTML = rows
    .map((r) => `<tr data-id="${esc(r.id)}"><td>${esc(fmtDate(r.createdAt))}</td><td>${esc(r.title)}</td><td>${r.shotIds?.length || 0}</td><td>${esc(PROVIDERS[r.provider]?.label || r.provider || '')} <small>${esc(r.model || '')}</small></td><td class="actions"><button class="btn small" data-act="open">Open</button><button class="btn small" data-act="download">.md</button><button class="btn small danger" data-act="delete">Delete</button></td></tr>`)
    .join('');
}

$('an-saved-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  const tr = e.target.closest('tr[data-id]');
  if (!btn || !tr) return;
  const rev = await store.getReview(tr.dataset.id);
  if (!rev) return;
  if (btn.dataset.act === 'open') {
    an.ids = rev.shotIds.filter((id) => state.shots.some((s) => s.id === id));
    an.markdown = rev.markdown;
    an.failed = false;
    an.meta = { createdAt: rev.createdAt, provider: rev.provider, model: rev.model, title: rev.title, shotIds: rev.shotIds, shotLabels: rev.shotLabels, taste: rev.taste, question: rev.question, durationMs: rev.durationMs };
    an.savedId = rev.id;
    $('an-taste').value = rev.taste || '';
    $('an-question').value = rev.question || '';
    renderAnalysis();
    renderReport();
    $('an-report-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (btn.dataset.act === 'download') {
    deliver(`review-${stamp(rev.createdAt)}.md`, reviewMarkdownFile(rev), 'text/markdown', 'reviews');
  } else if (btn.dataset.act === 'delete') {
    const ok = await confirmDialog({ title: 'Delete this review?', body: `“${rev.title}” from ${fmtDate(rev.createdAt)} will be removed. The shots stay.`, action: 'Delete review' });
    if (!ok) return;
    await store.deleteReview(rev.id);
    if (an.savedId === rev.id) an.savedId = null;
    renderReport();
    await renderSavedReviews();
    toast('Review deleted.');
  }
});

window.__pb = { state, store, portal, recorder, timeChart, massChart, calChart, compareChart, compare, machinePanel, settings, log, hist, an, openShotDialog, openCompare, openAnalysis, runReview, refreshShotList, recoverUnfinishedShots, backfillMachineRecords, autosaveShotFiles, refreshProfileTargets, get meticulous() { return meticulous; } };

init().catch((err) => {
  console.error(err);
  // The usual cause after an update is a stale script in the browser cache
  // (an old main.js running against a new index.html, or the reverse).
  toast(`Start-up problem: ${err.message || err}. If you just updated, reload with Shift held (⌘⇧R) to clear cached scripts.`, 'error', 15000);
});
