// main.js — wires the devices, the recorder, storage, charts and export together.

import { PortalBle, bluetoothSupported, environmentCheck, STEPS } from './portal-ble.js?v=0.19.0';
import { MeticulousClient, machineSamplesFromSavedShot, normalizeBaseUrl, machineBaseUrl, extractionEndSec, DEFAULT_HOST } from './meticulous.js?v=0.19.0';
import { MachinePanel } from './machine-panel.js?v=0.19.0';
import { ShotRecorder, finalizeCheckpoint } from './recorder.js?v=0.19.0';
import { Store, coffeeKey, deleteAllDatabases, LIST_KINDS } from './store.js?v=0.19.0';
import { TimeChart, MassChart, CalibrationChart, CompareChart, COMPARE_COLORS } from './charts.js?v=0.19.0';
import { analyzeShot, fitCalibration, fitForCoffee, estimateForShot, extractionYield, predictTds, beverageOf, beverageOverridden, beverageSource, beverageDefaultOf, profileTargetOf, profileFinalWeight, setBeveragePreference, grindMicrons, measuredEy, DEFAULTS } from './analysis.js?v=0.19.0';
import { buildShotDigest, buildReviewMessages, compactProfile, renderMarkdown, reviewTitle, approxTokens, reviewProfileOf, ratingOf, ratingMaxOf } from './review.js?v=0.19.0';
import { PROVIDERS, streamCompletion, listModels, testKey, maskKey, maxTokensFor, endpointRisk } from './ai.js?v=0.19.0';
import { buildEnvelope, encodeHandoff, encodeForQr } from './beanconqueror.js?v=0.19.0';
import { makeDemoShot } from './demo.js?v=0.19.0';
import { chartToJpeg, legendOf, shotReportPdf, shotSamplesCsv, summaryRow, SUMMARY_COLUMNS, rowsToCsv, buildZip, download, stamp, slug, loadJsPdf } from './export.js?v=0.19.0';
import { REVIEW_FORMATS, reviewFile, reviewMarkdownFile } from './review-export.js?v=0.19.0';
import { log, formatLine } from './log.js?v=0.19.0';
import { files, Files, FILE_KINDS, DEFAULT_ROOT, cleanDirName } from './files.js?v=0.19.0';
import { HeatMonitor, HEAT_RULES, HEAT_SENSORS, sensorTemp } from './heat.js?v=0.19.0';
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

const VIEWS = ['shots', 'history', 'analysis', 'beans', 'machine', 'settings'];

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
  else if (name === 'beans') renderBeans();
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
  stopped: false, // the Stop button was used; nothing runs any more
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
  machineVia: { def: 'auto', el: 'set-machine-via' },
  heatRule: { def: 'hold', el: 'set-heat-rule' },
  heatSensor: { def: 'status', el: 'set-heat-sensor' },
  heatToleranceC: { def: 1, el: 'set-heat-tol', num: true, min: 0.2, max: 5 },
  heatHoldSec: { def: 10, el: 'set-heat-hold', num: true, min: 0, max: 60 },
  heatSettleC: { def: 0.3, el: 'set-heat-settle', num: true, min: 0.1, max: 2 },
  autoRecord: { def: true, el: 'set-autorecord', bool: true },
  settleSec: { def: 6, el: 'settle-sec', num: true, min: 0, max: 60 },
  lagSec: { def: 0, el: 'lag-sec', num: true, min: -2, max: 3 },
  minShotSec: { def: 5, el: 'set-min-shot', num: true, min: 0, max: 60 },
  autoGraph: { def: true, el: 'portal-auto-graph', bool: true },
  beverageDefault: { def: 'profile', el: 'set-beverage-default' },
  ratings: { def: true, el: 'set-ratings', bool: true },
  ratingScale: { def: '5', el: 'set-rating-scale' },
  ratingWhen: { def: 'manual', el: 'set-rating-when' },
  fileDestination: { def: 'auto', el: 'set-file-destination' },
  fileRoot: { def: DEFAULT_ROOT, el: 'set-dir-root', dir: '' },
  dirShots: { def: FILE_KINDS.shots.def, el: 'set-dir-shots', dir: FILE_KINDS.shots.def },
  dirExports: { def: FILE_KINDS.exports.def, el: 'set-dir-exports', dir: FILE_KINDS.exports.def },
  dirReports: { def: FILE_KINDS.reports.def, el: 'set-dir-reports', dir: FILE_KINDS.reports.def },
  dirReviews: { def: FILE_KINDS.reviews.def, el: 'set-dir-reviews', dir: FILE_KINDS.reviews.def },
  dirBackups: { def: FILE_KINDS.backups.def, el: 'set-dir-backups', dir: FILE_KINDS.backups.def },
  dirLogs: { def: FILE_KINDS.logs.def, el: 'set-dir-logs', dir: FILE_KINDS.logs.def },
  shotFilesVia: { def: 'browser', el: 'set-shot-files-via' },
  exportsVia: { def: 'browser', el: 'set-exports-via' },
  autoSaveFiles: { def: true, el: 'set-autosave-files', bool: true },
  autoBackup: { def: true, el: 'set-auto-backup', bool: true },
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
  reviewFormat: { def: 'md', el: 'set-review-format' },
  logEnabled: { def: false, el: 'log-enabled', bool: true },
  logLevel: { def: 'info', el: 'log-level' },
  logPackets: { def: false, el: 'log-packets', bool: true },
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
  if ('dir' in spec) {
    v = cleanDirName(v, spec.dir);
    el.value = v;
  }
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
    case 'machineVia':
      $('meticulous-addr').textContent = settings.meticulousHost || DEFAULT_HOST;
      renderMachineVia();
      if (meticulous) {
        try {
          const url = machineBaseUrl(settings.meticulousHost || $('meticulous-host').value, { via: machineVia() });
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
    case 'fileDestination':
    case 'fileRoot':
    case 'dirShots':
    case 'dirExports':
    case 'dirReports':
    case 'dirReviews':
    case 'dirBackups':
    case 'dirLogs':
      applyFileSettings();
      break;
    case 'autoSaveFiles':
    case 'autoBackup':
    case 'shotFilesVia':
    case 'exportsVia':
      renderFiles();
      if (state.selected) renderShotFilesNote();
      break;
    case 'ratings':
    case 'ratingScale':
    case 'ratingWhen':
      applyRatingSettings();
      break;
    case 'heatRule':
    case 'heatSensor':
    case 'heatToleranceC':
    case 'heatHoldSec':
    case 'heatSettleC':
      applyHeatSettings();
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
    case 'reviewFormat':
      if ($('an-format')) $('an-format').value = v;
      renderSavedReviews();
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
  const held = []; // settings a file may not change on its own
  for (const [key, spec] of Object.entries(SETTINGS)) {
    if (!(key in doc.settings)) continue;
    if (spec.secret) continue; // keys are never read from a file either
    let v = doc.settings[key];
    // The OpenAI-compatible endpoint is where the stored API key is sent. A settings file from
    // someone else must not be able to repoint it, so a different endpoint is left for the user to type.
    if (key === 'aiBaseOpenai' && String(v ?? '').trim() !== String(settings.aiBaseOpenai ?? '').trim()) {
      if (String(v ?? '').trim()) held.push(String(v).trim().slice(0, 200));
      continue;
    }
    if (spec.bool) v = !!v;
    else if (spec.num) {
      v = Number(v);
      if (!Number.isFinite(v)) continue;
      v = Math.min(spec.max, Math.max(spec.min, v));
    } else v = String(v ?? spec.def);
    if ('dir' in spec) v = cleanDirName(v, spec.dir);
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
  importSettingsDocument.held = held;
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
  autoRecord: 'auto-record', machineVia: 'machine reached via', heatRule: 'ready-to-brew rule', heatSensor: 'temperature reading', heatToleranceC: 'temperature tolerance', heatHoldSec: 'hold time', heatSettleC: 'settled threshold', settleSec: 'settle window', lagSec: 'Portal lag', minShotSec: 'minimum shot length', autoGraph: 'Portal screen', autoSaveFiles: 'write shot files', beverageDefault: 'final weight', ratings: 'ratings', ratingScale: 'rating scale', ratingWhen: 'when to rate',
  minCalibrationShots: 'reference shots', estimatePool: 'estimate pool', logEnabled: 'logging', logLevel: 'log detail', logPackets: 'packet logging',
  logShowTail: 'live tail', fileDestination: 'where files go', fileRoot: 'root folder', dirShots: 'shot files folder', dirExports: 'exports folder', dirReports: 'reports folder',
  dirReviews: 'reviews folder', dirBackups: 'backups folder', dirLogs: 'logs folder', autoBackup: 'automatic backup',
  aiProvider: 'AI provider', aiKeyAnthropic: 'Anthropic key', aiModelAnthropic: 'Claude model', aiKeyOpenai: 'OpenAI key', aiModelOpenai: 'OpenAI model', aiBaseOpenai: 'OpenAI endpoint',
  aiKeyGoogle: 'Gemini key', aiModelGoogle: 'Gemini model', aiGrindStepUm: 'grinder step', aiDrink: 'usual drink', aiNotes: 'standing notes', reviewFormat: 'review file format',
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
  log.setWriter(files);
  await files.probeServer();
  await restoreFolder();
  applyFileSettings();
  document.body.classList.toggle('no-ratings', !ratingsOn());
  store.onChange = (kind) => scheduleAutoBackup(kind);
  applyHeatSettings();
  await probeAppServer().catch(() => {});
  renderMachineVia();
  renderLogStatus();
  $('about-version').textContent = 'v0.19.0';
  log.info('app', `portal-met-bridge v0.19.0 started · ${navigator.userAgent}`);

  const env = await environmentCheck();
  renderPortalSteps({ secure: env.secure, api: env.api, adapter: env.adapter });
  if (!env.secure) {
    $('portal-connect').disabled = true;
    renderInsecureHint();
  } else if (!env.api) {
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

/**
 * How the page reaches the machine: directly at its address, or through the
 * server's /machine/ proxy. 'auto' uses the proxy when this page is https (the
 * machine's plain-http API would be mixed content) and the server offers one.
 */
function machineVia() {
  const pref = settings.machineVia || 'auto';
  if (pref === 'server') return appServer?.machineProxy ? 'server' : 'direct';
  if (pref === 'direct') return 'direct';
  return location.protocol === 'https:' && appServer?.machineProxy ? 'server' : 'direct';
}

function renderMachineVia() {
  const el = $('machine-via-note');
  if (!el) return;
  const via = machineVia();
  const pref = settings.machineVia || 'auto';
  const host = settings.meticulousHost || DEFAULT_HOST;
  let text;
  if (via === 'server') text = `The page talks to the machine through the server that serves it (${location.host} → ${host}); the machine must be reachable from that server.`;
  else if (pref === 'server') text = "This page is not served by portal-met-bridge's own server (no proxy), so the machine is reached directly.";
  else if (location.protocol === 'https:') text = 'This page is https and the server offers no proxy: a plain-http machine cannot be reached from here (mixed content). Open the http address, or serve with serve.mjs.';
  else text = `The browser talks to the machine directly at http://${host}.`;
  el.textContent = text;
}

function connectMeticulous() {
  const host = settings.meticulousHost || $('meticulous-host').value;
  const via = machineVia();
  let url;
  try {
    url = machineBaseUrl(host, { via });
  } catch {
    toast('That address does not look right. Set it under Settings → Machine.', 'error');
    return;
  }
  if (meticulous) {
    machinePanel.detach();
    meticulous.disconnect();
  }
  log.info('machine', `connecting to ${url}${via === 'server' ? ' (through the server)' : ''}`);
  meticulous = new MeticulousClient(host, { via });
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
    if (d.state !== 'connected') {
      $('brew-state').textContent = '—';
      heat.reset();
      renderHeat(null);
    }
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
  const via = machineVia();
  if (via === 'server') url = machineBaseUrl($('meticulous-host').value, { via });
  out.textContent = `Trying ${url} …`;
  const probe = new MeticulousClient($('meticulous-host').value, { via });
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
  heat.setTarget(loadedProfileTemperature(s));
  heat.onStatus({ name: s.name, extracting: s.extracting, temp: sensorTemp(settings.heatSensor, s, meticulous?.lastSensors), at: performance.now() });
  renderBrewState(s);
  renderHeat(s);
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
      const byName = new Map(); // name → target, or NaN when two profiles share the name with different targets
      const byId = new Map();
      for (const p of Array.isArray(list) ? list : []) {
        const target = profileFinalWeight(p);
        if (p?.id && target > 0) byId.set(p.id, target);
        if (p?.name && target > 0) byName.set(p.name, byName.has(p.name) && byName.get(p.name) !== target ? NaN : target);
      }
      state.profileTargets = byName;
      state.profileTargetsById = byId;
      state.profileList = (Array.isArray(list) ? list : []).filter((p) => p?.id && p?.name).map((p) => ({ id: p.id, name: p.name, finalWeightG: profileFinalWeight(p), temperatureC: Number(p.temperature) || null }));
      renderBrewProfiles();
      const dup = [...byName.entries()].filter(([, t]) => Number.isNaN(t)).map(([n]) => n);
      log.info('machine', `profile list: ${byId.size} profiles with a target weight${dup.length ? `; same name, different targets: ${dup.join(', ')} (resolved by id or from the shot's record)` : ''}`);
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

/**
 * Stamp the profile's target output weight on a shot from the cached list: by
 * the loaded profile's id when the status stream gave one, else by name when
 * that name is unique. Two profiles with the same name and different targets
 * are left to the machine's record (attachMachineRecord), which knows which
 * one was brewed. Refreshes the list when the profile is unknown.
 */
function applyProfileTarget(shot) {
  if (!shot?.profileName && !shot?.profileId) return false;
  const byId = shot.profileId ? state.profileTargetsById?.get(shot.profileId) : null;
  const byName = shot.profileName ? state.profileTargets.get(shot.profileName) : null;
  if (Number.isNaN(byName) && !(byId > 0)) {
    if (!shot._targetAmbiguous) log.warn('recorder', `two profiles are named "${shot.profileName}" with different targets; the target will come from the machine's record`);
    shot._targetAmbiguous = true;
    return false;
  }
  const target = byId > 0 ? byId : byName;
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
  const askRating = settings.ratings && settings.ratingWhen === 'after';
  if (settings.beverageDefault === 'manual') {
    if (askRating) pendingRating = shot.id; // the rating dialog follows the weight dialog
    setTimeout(() => openWeightDialog(shot.id), 400); // the final weight is yours to type
  } else if (askRating) setTimeout(() => openRatingDialog(shot.id), 400);
  if (settings.autoSaveFiles) autosaveShotFiles(shot).catch(() => {});
  if (settings.autoAttach && meticulous?.connected && !shot.manual) setTimeout(() => refreshFromMachine(shot.id, true), settings.attachDelaySec * 1000);
});

/**
 * Write a shot's JSON and CSV into <save folder>/portal-met-bridge/shots/ and
 * remember where. Quiet when no folder is configured: the database copy is the
 * record of truth; files are a convenience for other tools.
 */
async function autosaveShotFiles(shot) {
  if (!files.ready) return false;
  const analysis = recomputeCache(shot);
  let estimate = null;
  try {
    estimate = estimateShot(shot, analysis).estimate;
  } catch {
    /* no calibration yet */
  }
  const base = fileBase(shot);
  const json = await files.write('shots', `${base}.json`, shotJson(shot, analysis, estimate), { type: 'application/json' });
  const csv = await files.write('shots', `${base}.csv`, shotSamplesCsv(shot), { type: 'text/csv' });
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
  $('history-tab-count').textContent = n ? `(${n})` : '';
  renderHistory();
  updateShotNav();
  if (!$('view-beans').hidden) renderBeans();
  else $('beans-tab-count').textContent = (() => { const k = new Set(); for (const x of state.beans || []) k.add(x.key); for (const x of state.shots) if (!x.inProgress && coffeeKey(x.context?.beanName)) k.add(coffeeKey(x.context.beanName)); return k.size ? `(${k.size})` : ''; })();
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

/** One line naming every weight known for a shot and what a blank field falls back to. */
function weightHint(shot) {
  const target = profileTargetOf(shot);
  const fallbackSrc = beverageSource({ ...shot, beverageG: undefined });
  const fallback = { profile: 'the profile target', scale: "the machine's scale" }[fallbackSrc];
  return [
    target > 0 ? `Profile target ${fmt(target, 1)} g${shot._targetAmbiguous ? ' (two profiles share this name)' : ''}` : 'No profile target known for this shot',
    Number.isFinite(shot.finalWeightG) && shot.finalWeightG > 0 ? `machine's scale ${fmt(shot.finalWeightG, 1)} g` : null,
    settings.beverageDefault === 'manual' ? 'blank = not entered (Settings → Recording → Final weight: typed after each brew)' : `blank uses ${fallback || 'nothing'} (Settings → Recording → Final weight)`,
  ].filter(Boolean).join(' · ');
}

/** The small "weigh the cup" dialog: the final weight of one shot, typed after the brew. */
async function openWeightDialog(id) {
  const shot = await store.getShot(id);
  if (!shot) return;
  const dlg = $('weight-dialog');
  dlg.dataset.id = id;
  $('w-title').textContent = `Final weight — ${fmtDate(shot.startedAt)}${shot.context?.beanName ? ` · ${shot.context.beanName}` : ''}`;
  $('w-bev').value = Number.isFinite(shot.beverageG) && shot.beverageG > 0 ? shot.beverageG : '';
  $('w-bev').placeholder = Number.isFinite(shot.finalWeightG) && shot.finalWeightG > 0 ? `scale saw ${fmt(shot.finalWeightG, 1)}` : '';
  $('w-hint').textContent = weightHint(shot);
  if (!dlg.open) dlg.showModal();
  $('w-bev').focus();
  $('w-bev').select();
}
async function saveWeightDialog() {
  const dlg = $('weight-dialog');
  const shot = await store.getShot(dlg.dataset.id);
  if (!shot) return dlg.close();
  const weighed = Number($('w-bev').value);
  if (weighed > 0 && weighed < 5000) shot.beverageG = Math.round(weighed * 10) / 10;
  else delete shot.beverageG;
  if (shot.refractometer?.tdsPct > 0) shot.refractometer = { ...shot.refractometer, eyPct: extractionYield(shot.refractometer.tdsPct, beverageOf(shot), Number(shot.context?.doseG) || 0) };
  await store.putShot(shot);
  if (shot.files && settings.autoSaveFiles) autosaveShotFiles(shot).catch(() => {});
  dlg.close();
  await refreshShotList();
  if (state.selected?.id === shot.id) await selectShot(shot.id);
  renderHistory();
  toast(shot.beverageG ? `Final weight ${fmt(shot.beverageG, 1)} g saved.` : 'Final weight cleared.');
  log.info('shots', `final weight for ${shot.id}: ${shot.beverageG ?? 'cleared'}`);
}
$('w-save').addEventListener('click', saveWeightDialog);
$('w-later').addEventListener('click', () => $('weight-dialog').close());
$('weight-dialog').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'w-bev') {
    e.preventDefault();
    saveWeightDialog();
  }
});
$('shot-weigh').addEventListener('click', () => state.selected && openWeightDialog(state.selected.id));
let pendingRating = null; // a shot whose rating dialog waits for the weight dialog to close
$('weight-dialog').addEventListener('close', () => {
  if (!pendingRating) return;
  const id = pendingRating;
  pendingRating = null;
  setTimeout(() => openRatingDialog(id), 150);
});

// ---- rating and comment: 1–5 stars and a few words on the cup, editable any time

const STAR_WORDS = ['', 'poor', 'meh', 'fine', 'good', 'great'];
/** A word for a rating on any scale: the five words spread over 1 … max. */
const starWord = (r, max = 5) => (r ? STAR_WORDS[Math.max(1, Math.min(5, Math.ceil((r / max) * 5)))] : '');
/** The scale new ratings use (Settings → Recording → Rating): 5 or 9. */
const ratingScale = () => (String(settings.ratingScale) === '9' ? 9 : 5);
/** Ratings are shown anywhere only while the feature is on. */
const ratingsOn = () => settings.ratings !== false;

/** Star buttons for one picker (1 … max); `max` follows the shot's scale when it has one, else the setting. */
function starPickerHtml(value = 0, max = ratingScale()) {
  const stars = Array.from({ length: max }, (_, i) => i + 1);
  return `<span class="stars${max > 5 ? ' nine' : ''}" role="radiogroup" aria-label="Rating" data-max="${max}" data-value="${value || 0}">${stars.map((n) => `<button type="button" class="star${n <= value ? ' on' : ''}" data-star="${n}" role="radio" aria-checked="${n === value}" title="${n} of ${max} — ${starWord(n, max)}" aria-label="${n} of ${max}">★</button>`).join('')}<button type="button" class="star-clear${value ? '' : ' hidden'}" data-star="0" title="Remove the rating">clear</button></span>`;
}
/** Rebuild a picker in place with the stars for `max`, so a dialog follows the chosen scale. */
function renderStarPicker(el, value = 0, max = ratingScale()) {
  const tmp = document.createElement('div');
  tmp.innerHTML = starPickerHtml(value, max);
  el.innerHTML = tmp.firstElementChild.innerHTML; // the group element (and its click listener) stays
  el.dataset.max = String(max);
  el.dataset.value = String(value || 0);
  el.classList.toggle('nine', max > 5);
  return el;
}
/** Read-only stars for lists; empty string when unrated. On a 5 scale "★4"; on 9, "★7/9". */
function starsHtml(shot, { compact = false } = {}) {
  const r = ratingOf(shot);
  if (!r) return '';
  const max = ratingMaxOf(shot);
  const t = `${r}/${max} — ${starWord(r, max)}${shot.comment ? `\n${shot.comment}` : ''}`;
  const text = compact ? (max === 5 ? `★${r}` : `★${r}/${max}`) : '★'.repeat(r) + '<span class="dim">' + '★'.repeat(max - r) + '</span>';
  return `<span class="stars ro${max > 5 ? ' nine' : ''}" title="${esc(t)}" aria-label="rated ${r} of ${max}">${text}</span>`;
}
/** Wire a star picker: clicking a star sets the value; data-value on the group holds it. */
function bindStarPicker(group, onChange) {
  group.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-star]');
    if (!b) return;
    ev.preventDefault();
    const v = Number(b.dataset.star);
    setStarPicker(group, v);
    onChange?.(v);
  });
}
function setStarPicker(group, v) {
  if (!group) return;
  group.dataset.value = String(v || 0);
  group.querySelectorAll('button.star').forEach((x) => {
    const n = Number(x.dataset.star);
    x.classList.toggle('on', n <= v && v > 0);
    x.setAttribute('aria-checked', String(n === v));
  });
  group.querySelector('.star-clear')?.classList.toggle('hidden', !v);
}
const starPickerValue = (group) => ratingOf({ rating: Number(group?.dataset.value), ratingMax: Number(group?.dataset.max) }) || 0;

async function openRatingDialog(id) {
  const shot = await store.getShot(id);
  if (!shot) return;
  const dlg = $('rating-dialog');
  dlg.dataset.id = id;
  $('r-title').textContent = `${ratingOf(shot) ? 'Your rating' : 'How was it?'} — ${fmtDate(shot.startedAt)}${shot.context?.beanName ? ` · ${shot.context.beanName}` : ''}`;
  $('r-sub').textContent = [shot.profileName, shot.context?.doseG ? `${shot.context.doseG} g → ${fmt(beverageOf(shot), 1)} g` : null, `${fmt(shot.durationSec, 1)} s`].filter(Boolean).join(' · ');
  // a shot already rated keeps its own scale; a new rating uses the one in Settings
  const max = ratingOf(shot) ? ratingMaxOf(shot) : ratingScale();
  renderStarPicker($('r-stars'), ratingOf(shot) || 0, max);
  $('r-keys').textContent = `press 1–${max}`;
  $('r-comment').value = shot.comment || '';
  if (!dlg.open) dlg.showModal();
  ($('r-stars').querySelector('button.star.on:last-of-type') || $('r-stars').querySelector('button.star')).focus();
}
async function saveRatingDialog() {
  const dlg = $('rating-dialog');
  const shot = await store.getShot(dlg.dataset.id);
  if (!shot) return dlg.close();
  await setShotRating(shot, starPickerValue($('r-stars')), $('r-comment').value, Number($('r-stars').dataset.max));
  dlg.close();
  toast(ratingOf(shot) ? `Rated ${ratingOf(shot)}/${ratingMaxOf(shot)}${shot.comment ? ' with a comment' : ''}.` : shot.comment ? 'Comment saved.' : 'Rating cleared.');
}
/** Store a rating (1 … max, 0 clears) with its scale, and the comment, then refresh every place that shows them. */
async function setShotRating(shot, rating, comment, max = ratingScale()) {
  const r = ratingOf({ rating, ratingMax: max });
  if (r) {
    shot.rating = r;
    shot.ratingMax = max === 9 ? 9 : 5;
  } else {
    delete shot.rating;
    delete shot.ratingMax;
  }
  const text = String(comment ?? '').trim();
  if (text) shot.comment = text.slice(0, 2000);
  else delete shot.comment;
  await store.putShot(shot);
  if (shot.files && settings.autoSaveFiles) autosaveShotFiles(shot).catch(() => {});
  await refreshShotList();
  if (state.selected?.id === shot.id) {
    state.selected = shot;
    renderShotRating(shot);
  }
  renderHistory();
  if (!$('view-analysis').hidden) renderAnalysis();
  log.info('shots', `rating for ${shot.id}: ${shot.rating ?? 'none'}${shot.comment ? ' + comment' : ''}`);
}
/** The stars and comment under the shot title: click a star to rate, the pencil to write. */
function renderShotRating(shot) {
  const box = $('shot-rating');
  if (!shot || !ratingsOn()) { box.innerHTML = ''; return; }
  const r = ratingOf(shot) || 0;
  const max = r ? ratingMaxOf(shot) : ratingScale();
  box.innerHTML = `${starPickerHtml(r, max)}<button type="button" class="linkish" id="shot-rate-edit" title="Rate this shot and write a comment">${shot.comment ? 'Edit comment' : r ? 'Add a comment' : 'Rate this shot'}</button>${shot.comment ? `<span class="comment">${esc(shot.comment)}</span>` : ''}`;
  const picker = box.querySelector('.stars');
  bindStarPicker(picker, (v) => setShotRating(shot, v, shot.comment, max));
  $('shot-rate-edit').addEventListener('click', () => openRatingDialog(shot.id));
}
$('r-save').addEventListener('click', saveRatingDialog);
$('r-later').addEventListener('click', () => $('rating-dialog').close());
bindStarPicker($('r-stars'));
bindStarPicker($('e-stars'));
$('rating-dialog').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id !== 'r-comment') { e.preventDefault(); saveRatingDialog(); }
  const max = Number($('r-stars').dataset.max) || 5;
  if (/^[1-9]$/.test(e.key) && Number(e.key) <= max && e.target.id !== 'r-comment') { e.preventDefault(); setStarPicker($('r-stars'), Number(e.key)); }
});
/** Ratings on/off and the scale change what every view shows. */
function applyRatingSettings() {
  document.body.classList.toggle('no-ratings', !ratingsOn());
  if (state.selected) renderShotRating(state.selected);
  renderHistory();
  if (!$('view-analysis').hidden) renderAnalysis();
  if (!$('view-beans').hidden) renderBeans();
}

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
    const hay = [c.beanName, c.roaster, c.origin, c.grinderName, c.grindSize, c.note, c.roastLevel, c.process, shot.profileName, fmtDate(shot.startedAt), shot.comment].join(' ').toLowerCase();
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
    case 'rating': return ratingOf(shot) ? ratingOf(shot) / ratingMaxOf(shot) : -1; // scales mixed: sort by the fraction
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
    const inOut = `${c.doseG ? fmt(Number(c.doseG), 1) : '–'} → ${Number.isFinite(bev) ? `${fmt(bev, 1)} g${beverageMarker(s)}` : `<button class="linkish weigh" data-act="weigh" title="Final weight not entered yet — type it">? g</button>`}`;
    const grind = grindMicrons(c);
    const data = [
      `<span class="tag ${s.portal?.length ? 'on' : 'off'}" title="Portal samples">P ${Number(s.portal?.length) || 0}</span>`,
      `<span class="tag ${s.machine?.length ? 'on' : 'off'}" title="machine samples">M ${Number(s.machine?.length) || 0}</span>`,
      s.inProgress ? '<span class="tag rec">● recording</span>' : `<span class="tag ${s.machineSource ? 'on' : 'off'}" title="${s.machineSource ? 'machine record attached' : 'machine record not attached'}">⌂</span>`,
      s.inProgress ? '' : `<span class="tag ${s.files?.json ? 'on' : 'off'}" title="${s.files?.json ? esc('JSON + CSV in the save folder: ' + s.files.json) : 'files not written to a folder'}">▤</span>`,
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
      `<td class="rating">${s.inProgress || !ratingsOn() ? '' : ratingOf(s) ? `<button class="linkish rate" data-act="rate" title="${esc(`${ratingOf(s)}/${ratingMaxOf(s)} — ${starWord(ratingOf(s), ratingMaxOf(s))}${s.comment ? `\n${s.comment}` : ''}`)}">${starsHtml(s, { compact: true })}${s.comment ? '<span class="has-comment" aria-label="has a comment">💬</span>' : ''}</button>` : `<button class="linkish rate unrated" data-act="rate" title="${s.comment ? esc(s.comment) + '\n' : ''}Not rated yet — rate it">${s.comment ? '💬' : '☆'}</button>`}</td>` +
      `<td class="data">${data}</td>` +
      `<td class="actions">${s.inProgress ? '' : '<button class="btn small" data-act="open">Open</button><button class="btn small" data-act="edit">Edit</button><button class="btn small danger" data-act="delete">Delete</button>'}</td>`;
    tbody.appendChild(tr);
  }
  $('hist-delete-selected').disabled = hist.checked.size === 0;
  $('hist-delete-selected').textContent = hist.checked.size ? `Delete selected (${hist.checked.size})` : 'Delete selected';
  $('hist-export').disabled = hist.checked.size === 0;
  $('hist-export').textContent = hist.checked.size ? `Export selected (${hist.checked.size})` : 'Export selected';
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
  if (act === 'weigh') return openWeightDialog(id);
  if (act === 'rate') return openRatingDialog(id);
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
      return `<tr data-id="${esc(shot.id)}" class="${note ? 'excluded' : ''}">` +
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
  renderStarPicker($('e-stars'), ratingOf(shot) || 0, ratingOf(shot) ? ratingMaxOf(shot) : ratingScale());
  $('e-rating-row').hidden = !ratingsOn();
  $('e-comment').value = shot.comment || '';
  $('e-tds').value = shot.refractometer?.tdsPct ?? '';
  // Beverage weighed is a field of the shot in its own right: editable with or without a reading.
  $('e-bev').value = Number.isFinite(shot.beverageG) && shot.beverageG > 0 ? shot.beverageG : '';
  const fallback = beverageDefaultOf(shot);
  const fallbackSrc = beverageSource({ ...shot, beverageG: undefined, refractometer: undefined });
  $('e-bev').placeholder = Number.isFinite(fallback) ? `${fmt(fallback, 1)} (${fallbackSrc === 'profile' ? 'profile target' : 'machine'})` : settings.beverageDefault === 'manual' ? 'not entered' : '';
  $('e-bev-hint').textContent = weightHint(shot);
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
  const rating = starPickerValue($('e-stars'));
  if (rating) {
    shot.rating = rating;
    shot.ratingMax = Number($('e-stars').dataset.max) === 9 ? 9 : 5;
  } else {
    delete shot.rating;
    delete shot.ratingMax;
  }
  const comment = $('e-comment').value.trim();
  if (comment) shot.comment = comment.slice(0, 2000);
  else delete shot.comment;
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
    Number.isFinite(beverageOf(shot)) ? `${fmt(beverageOf(shot), 1)} g out${beverageNote(shot)}` : 'final weight not entered',
    ratioOf(shot) ? fmtRatio(ratioOf(shot)) : null,
    `${fmt(shot.durationSec, 1)} s`,
    `${shot.machine.length} machine · ${shot.portal.length} Portal samples`,
    shot.machineSource ? 'machine record attached' : null,
    shot.recovered ? 'recovered from a checkpoint' : null,
    (() => { $('shot-weigh').hidden = !(settings.beverageDefault === 'manual' && !(shot.beverageG > 0)); return null; })(),
  ].filter(Boolean).join(' · ');
  renderShotRating(shot);
  renderShotFilesNote();
  $('shot-files-note').textContent = shot.files?.json ? `This shot's JSON and CSV were written to ${shot.files.json.replace(/[^/]+$/, '')} at ${new Date(shot.files.at).toLocaleTimeString()}.` : '';
  $('shot-delete').disabled = false;
  $('shot-edit').disabled = false;
  $('shot-refresh').disabled = !meticulous?.connected;
  for (const id of ['bc-copy', 'bc-open', 'bc-json', 'dl-csv', 'dl-json', 'dl-jpeg', 'dl-pdf', 'ref-save']) $(id).disabled = false;
  $('ref-clear').disabled = !shot.refractometer;
  $('ref-tds').value = shot.refractometer?.tdsPct ?? '';
  $('ref-bev').value = Number.isFinite(shot.beverageG) && shot.beverageG > 0 ? shot.beverageG : '';
  $('ref-bev').placeholder = Number.isFinite(beverageDefaultOf(shot)) ? `${fmt(beverageDefaultOf(shot), 1)} (${beverageSource({ ...shot, beverageG: undefined }) === 'profile' ? 'profile target' : 'machine'})` : settings.beverageDefault === 'manual' ? 'type the weight' : 'auto';

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
  if (!meticulous || state.stopped) return;
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
  const recordTarget = profileFinalWeight(saved.profile); // the record says what was actually brewed, whichever same-named profile it was
  if (recordTarget > 0) shot.profileTargetG = recordTarget;
  if (saved.profile?.id) shot.profileId = saved.profile.id;
  delete shot._targetAmbiguous;
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
  const env = buildEnvelope(shot, state.analysis, state.estimate, { ...(shot.context || {}), rating: ratingOf(shot) ? Math.round((ratingOf(shot) / ratingMaxOf(shot)) * 10) / 2 : undefined, comment: shot.comment || '' });
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
  deliver(`beanconqueror-${stamp(state.selected.startedAt)}.json`, JSON.stringify(env, null, 2), 'application/json', 'exports', shotFilesVia());
}

// ---------------------------------------------------------- files out --

/**
 * Hand a file to the user. `via` 'folder' (the default) puts it into the file
 * destination (Settings → Files and folders) under the subfolder for its kind
 * when one is writable, else downloads it; 'browser' always downloads. The
 * per-shot files and the History exports follow their own settings
 * (shotFilesVia, exportsVia); reviews and logs follow the destination.
 */
async function deliver(name, data, type, kind = 'exports', { via = 'folder' } = {}) {
  if (via === 'folder' && !files.ready && files.blocker) toast(`${files.blocker} Downloading ${name} instead.`, 'warn');
  if (via === 'folder' && files.ready) {
    try {
      const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
      const path = await files.write(kind, name, blob);
      log.info('export', `saved ${path} (${blob.size} B)`);
      toast(`Saved ${path}`);
      renderFiles();
      return path;
    } catch (err) {
      log.warn('export', `save failed for ${name}: ${err?.message || err}; downloading instead`);
      renderFiles();
    }
  }
  log.info('export', `download ${name}`);
  download(name, data, type);
  return null;
}

const fileBase = (shot) => `shot-${stamp(shot.startedAt)}-${slug(shot.context?.beanName)}`;
/** Where the buttons under "Files for this shot" send their files (Settings → Files and folders). */
const shotFilesVia = () => ({ via: settings.shotFilesVia === 'folder' ? 'folder' : 'browser' });
/** Where the History exports (summary CSV, zips) go. */
const exportsVia = () => ({ via: settings.exportsVia === 'folder' ? 'folder' : 'browser' });
/** The note under the per-shot buttons: where they go right now, and how to change it. */
function renderShotFilesNote() {
  const el = $('shot-files-where');
  if (!el) return;
  el.textContent = settings.shotFilesVia === 'folder' ? (files.ready ? `These buttons write to ${files.describe()} (exports/ and reports/).` : `These buttons are set to write to a folder, but ${files.blocker.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())} — so they download.`) : 'These buttons download through the browser.';
}

function shotJson(shot, analysis, estimate) {
  return JSON.stringify({ app: 'portal-met-bridge', version: 2, shot, analysis, estimate }, null, 2);
}

function downloadShotJson() {
  const shot = state.selected;
  deliver(`${fileBase(shot)}.json`, shotJson(shot, state.analysis, state.estimate), 'application/json', 'exports', shotFilesVia());
}

function downloadCsv() {
  const shot = state.selected;
  deliver(`${fileBase(shot)}.csv`, shotSamplesCsv(shot), 'text/csv', 'exports', shotFilesVia());
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
  await deliver(`${fileBase(shot)}-time.jpg`, time.blob, 'image/jpeg', 'reports', shotFilesVia());
  if (mass) {
    await new Promise((r) => setTimeout(r, 300));
    await deliver(`${fileBase(shot)}-ec-vs-mass.jpg`, mass.blob, 'image/jpeg', 'reports', shotFilesVia());
  }
}

/**
 * The newest saved AI review that covers this shot (alone or as part of a
 * series), with the heading the PDF report gives it; null when none is saved.
 * `reviews` is store.listReviews()'s list, newest first.
 */
function reviewForShot(shotId, reviews) {
  const rev = (reviews || []).find((r) => Array.isArray(r.shotIds) && r.shotIds.includes(shotId) && r.markdown);
  if (!rev) return null;
  const n = rev.shotIds.length;
  const when = `${fmtDate(rev.createdAt)} · ${PROVIDERS[rev.provider]?.label || rev.provider || 'AI'} · ${rev.model || ''}`.replace(/ · $/, '');
  return { review: rev, heading: n > 1 ? `AI review of ${n} shots including this one (${when})` : `AI review of this shot (${when})` };
}

function reportFor(shot, analysis, estimate, fit, images, review = null) {
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
    ['Your rating', ratingOf(shot) ? `${'★'.repeat(ratingOf(shot))}${'☆'.repeat(ratingMaxOf(shot) - ratingOf(shot))} ${ratingOf(shot)}/${ratingMaxOf(shot)}` : 'not rated'],
    ['Analysis', a.status || '–'],
    ['AI review', review ? `${review.review.shotIds.length > 1 ? `${review.review.shotIds.length} shots` : 'this shot'} · ${fmtDate(review.review.createdAt)} (appended)` : 'none saved'],
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
  if (shot.comment) notes.push(`Your comment: ${shot.comment}`);
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
    review: review?.review || null,
    reviewHeading: review?.heading || null,
  };
}

async function downloadPdf() {
  const shot = state.selected;
  if ($('view-shots').hidden) showView('shots');
  toast('Building the PDF…');
  try {
    const images = await chartImages(shot, state.analysis);
    const review = reviewForShot(shot.id, await store.listReviews({ limit: 100000 }));
    const blob = await shotReportPdf(reportFor(shot, state.analysis, state.estimate, state.fit, images, review));
    deliver(`${fileBase(shot)}-report.pdf`, blob, 'application/pdf', 'reports', shotFilesVia());
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
  deliver(`portal-met-bridge-shots-${stamp(Date.now())}.csv`, rowsToCsv(rows), 'text/csv', 'exports', exportsVia());
}

/** A zip of every shot's files (no ids) or of the given shots only (History → Export selected). */
async function downloadZip(ids = null) {
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const all = (await analyseAll()).filter(({ shot }) => !wanted || wanted.has(shot.id));
  if (!all.length) {
    toast(wanted ? 'None of the selected shots is still here.' : 'No shots to export yet.');
    return;
  }
  if ($('view-shots').hidden) showView('shots');
  const prog = $('dl-progress');
  const files = {};
  files['shots-summary.csv'] = rowsToCsv([SUMMARY_COLUMNS, ...all.map(({ shot, analysis, estimate }) => summaryRow(shot, analysis, estimate))]);
  if (!wanted) files['backup.json'] = JSON.stringify(await store.exportAll());
  files['README.txt'] = `portal-met-bridge export — ${new Date().toString()}${wanted ? ` — ${all.length} selected shot${all.length === 1 ? '' : 's'}` : ''}\n\nshots-summary.csv   one row per shot (EC metrics, refractometer reading, estimate, rating)\n${wanted ? '' : 'backup.json         full backup; restore it with the Restore button\n'}shots/<shot>/       samples.csv, shot.json, time.jpg, ec-vs-mass.jpg, report.pdf per shot (the report ends with the newest saved AI review that covers the shot, when there is one)\n\nEC is a conductivity proxy; TDS/EY are estimates from refractometer calibration unless a refractometer reading is present.\n`;
  const selectedId = state.selected?.id;
  const reviews = await store.listReviews({ limit: 100000 });
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
      files[`${dir}/report.pdf`] = await shotReportPdf(reportFor(shot, analysis, estimate, fit, images, reviewForShot(shot.id, reviews)));
    } catch (err) {
      files[`${dir}/ERROR.txt`] = String(err?.message || err);
    }
  }
  prog.textContent = 'Zipping…';
  try {
    const blob = await buildZip(files);
    deliver(wanted ? `portal-met-bridge-export-${all.length}-shots-${stamp(Date.now())}.zip` : `portal-met-bridge-export-${stamp(Date.now())}.zip`, blob, 'application/zip', 'exports', exportsVia());
    prog.textContent = `${all.length} shot${all.length === 1 ? '' : 's'} exported.`;
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
  renderBeanLink();
  state.lists = {};
  for (const kind of LIST_KINDS) {
    const values = await store.listValues(kind);
    state.lists[kind] = values;
    $(`${kind}-list`).innerHTML = values.map((v) => `<option value="${esc(v.value)}">${esc(`used ${v.uses}× · ${new Date(v.lastUsed).toLocaleDateString()}`)}</option>`).join('');
  }
  renderPickListChips();
  renderBeans();
}

// ------------------------------------------------------------------ beans --

/** A safe http(s) URL for a link, or '' — anything else (javascript:, data:) is dropped. */
function safeUrl(u) {
  const t = String(u || '').trim();
  if (!t) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
/** The "info ↗" link beside the Bean field, when the picked coffee has a page. */
function renderBeanLink() {
  const a = $('ctx-bean-link');
  if (!a) return;
  const b = (state.beans || []).find((x) => x.key === coffeeKey($('ctx-bean').value));
  const url = safeUrl(b?.url);
  a.hidden = !url;
  if (url) a.href = url;
}

const beansView = { search: '', sort: 'lastUsed', dir: 'desc' };

/**
 * Every coffee, from the bean library and from the shots themselves (a coffee
 * that only exists in old shots still appears): [{ key, name, roaster, origin,
 * process, roastLevel, url, notes, shots, rated, avg5, lastUsed, firstUsed, lastDoseG, lastGrind, inLibrary }].
 */
function collectBeans() {
  const byKey = new Map();
  for (const b of state.beans || []) byKey.set(b.key, { ...b, shots: 0, rated: 0, ratingSum5: 0, lastUsed: b.lastUsed || 0, firstUsed: b.createdAt || 0, inLibrary: true });
  for (const shot of state.shots || []) {
    if (shot.inProgress) continue;
    const c = shot.context || {};
    const key = coffeeKey(c.beanName);
    if (!key) continue;
    let b = byKey.get(key);
    if (!b) {
      b = { key, name: c.beanName.trim(), roaster: c.roaster || '', origin: c.origin || '', process: c.process || '', roastLevel: c.roastLevel || '', url: '', notes: '', shots: 0, rated: 0, ratingSum5: 0, lastUsed: 0, firstUsed: 0, lastDoseG: Number(c.doseG) || 0, lastGrind: c.grindSize || '', inLibrary: false };
      byKey.set(key, b);
    }
    b.shots++;
    if (shot.startedAt > (b.lastBrewed || 0)) {
      b.lastBrewed = shot.startedAt;
      if (!b.inLibrary) { b.lastDoseG = Number(c.doseG) || b.lastDoseG; b.lastGrind = c.grindSize || b.lastGrind; }
    }
    if (!b.firstBrewed || shot.startedAt < b.firstBrewed) b.firstBrewed = shot.startedAt;
    const r = ratingOf(shot);
    if (r) { b.rated++; b.ratingSum5 += (r / ratingMaxOf(shot)) * 5; }
  }
  return [...byKey.values()].map((b) => ({ ...b, lastUsed: Math.max(b.lastUsed || 0, b.lastBrewed || 0), avg5: b.rated ? b.ratingSum5 / b.rated : null }));
}

function renderBeans() {
  const tbody = $('beans-rows');
  if (!tbody) return;
  const all = collectBeans();
  const q = beansView.search.trim().toLowerCase();
  const rows = all.filter((b) => !q || [b.name, b.roaster, b.origin, b.process, b.roastLevel, b.notes].join(' ').toLowerCase().includes(q));
  const val = (b) => {
    switch (beansView.sort) {
      case 'name': return (b.name || '').toLowerCase();
      case 'roaster': return (b.roaster || '').toLowerCase();
      case 'shots': return b.shots;
      case 'rating': return b.avg5 ?? -1;
      default: return b.lastUsed || 0;
    }
  };
  rows.sort((a, b) => { const x = val(a), y = val(b); const c = x < y ? -1 : x > y ? 1 : 0; return beansView.dir === 'asc' ? c : -c; });
  $('beans-table').querySelectorAll('th[data-sort]').forEach((th) => th.setAttribute('aria-sort', th.dataset.sort === beansView.sort ? (beansView.dir === 'asc' ? 'ascending' : 'descending') : 'none'));
  const n = all.length;
  $('beans-count').textContent = n ? `(${n})` : '';
  $('beans-tab-count').textContent = n ? `(${n})` : '';
  $('beans-empty').hidden = n > 0;
  const grind = (b) => [b.lastDoseG ? `${b.lastDoseG} g` : '', b.lastGrind ? String(b.lastGrind) : ''].filter(Boolean).join(' · ');
  tbody.innerHTML = rows
    .map((b) => {
      const url = safeUrl(b.url);
      return `<tr data-key="${esc(b.key)}">` +
        `<td class="name"><button class="linkish" data-act="shots" title="Show this coffee's shots in History">${esc(b.name)}</button>${url ? ` <a class="bean-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(url)}">info ↗</a>` : ''}${b.notes ? `<small title="${esc(b.notes)}">${esc(b.notes.length > 70 ? b.notes.slice(0, 68) + '…' : b.notes)}</small>` : ''}</td>` +
        `<td class="roaster">${esc(b.roaster || '')}${grind(b) ? `<small>${esc(grind(b))}</small>` : ''}</td><td>${esc(b.origin || '')}</td><td>${esc(b.process || '')}</td><td>${esc(b.roastLevel || '')}</td>` +
        `<td class="num">${b.shots ? `<button class="linkish" data-act="shots">${b.shots}</button>` : '<span class="muted">0</span>'}</td>` +
        `<td class="num rating">${b.avg5 != null ? `<span class="stars ro" title="${b.rated} rated shot${b.rated === 1 ? '' : 's'}">★${b.avg5.toFixed(1)}</span>` : '<span class="muted">–</span>'}</td>` +
        `<td class="num">${b.lastBrewed ? esc(fmtDate(b.lastBrewed)) : '<span class="muted">never</span>'}</td>` +
        `<td class="actions"><button class="btn small" data-act="use" title="Fill This coffee on the Shots tab with it">Use</button> <button class="btn small" data-act="edit">Edit</button></td>` +
        `</tr>`;
    })
    .join('');
}

let beanEditing = null; // { key, name, shots } while the dialog is open; null for a new coffee
function openBeanDialog(bean) {
  const dlg = $('bean-dialog');
  beanEditing = bean ? { key: bean.key, name: bean.name, shots: bean.shots || 0 } : null;
  $('b-title').textContent = bean ? bean.name : 'Add a coffee';
  $('b-sub').textContent = bean ? `${bean.shots || 0} shot${bean.shots === 1 ? '' : 's'}${bean.lastBrewed ? ` · last ${fmtDate(bean.lastBrewed)}` : ''}${bean.inLibrary ? '' : ' · from the shots only (saved to the library when you press Save)'}` : 'A coffee you want ready in the Bean pick-list before its first shot.';
  $('b-name').value = bean?.name || '';
  $('b-roaster').value = bean?.roaster || '';
  $('b-origin').value = bean?.origin || '';
  $('b-process').value = bean?.process || '';
  $('b-roast').value = bean?.roastLevel || '';
  $('b-url').value = bean?.url || '';
  $('b-notes').value = bean?.notes || '';
  $('b-apply-row').hidden = !(bean && bean.shots);
  $('b-apply').checked = true;
  $('b-apply-label').textContent = `Also update this coffee's ${bean?.shots || 0} shot${bean?.shots === 1 ? '' : 's'} (name, roaster, origin, process, roast level)`;
  $('b-delete').hidden = !(bean && bean.inLibrary && !bean.shots);
  $('b-error').textContent = '';
  dlg.showModal();
  $('b-name').focus();
}
async function saveBeanDialog() {
  const name = $('b-name').value.trim();
  const err = $('b-error');
  if (!name) { err.textContent = 'The coffee needs a name.'; return; }
  const rawUrl = $('b-url').value.trim();
  const url = safeUrl(rawUrl);
  if (rawUrl && !url) { err.textContent = 'The web page must be an http(s) address.'; return; }
  const key = coffeeKey(name);
  const prevKey = beanEditing?.key || null;
  const existing = (state.beans || []).find((b) => b.key === key);
  if (existing && key !== prevKey) { err.textContent = `"${existing.name}" is already in the library — edit that one, or pick another name.`; return; }
  const rec = { name, roaster: $('b-roaster').value.trim(), origin: $('b-origin').value.trim(), process: $('b-process').value, roastLevel: $('b-roast').value, url, notes: $('b-notes').value.trim().slice(0, 2000) };
  const saved = await store.putBean(rec);
  if (prevKey && prevKey !== key) await store.deleteBean(beanEditing.name); // renamed: drop the old record
  let touched = 0;
  if (prevKey && beanEditing.shots && $('b-apply').checked) {
    for (const shot of await store.listShots({ limit: 100000 })) {
      if (coffeeKey(shot.context?.beanName) !== prevKey) continue;
      shot.context = { ...(shot.context || {}), beanName: name, roaster: rec.roaster, origin: rec.origin, process: rec.process, roastLevel: rec.roastLevel };
      await store.putShot(shot);
      touched++;
    }
  }
  for (const [kind, value] of [['roaster', rec.roaster], ['origin', rec.origin]]) if (value) await store.rememberValue(kind, value).catch(() => {});
  $('bean-dialog').close();
  log.info('beans', `saved ${saved.key}${touched ? `, ${touched} shots updated` : ''}`);
  await refreshBeanLists();
  if (touched) {
    await refreshShotList();
    if (state.selected && coffeeKey(state.selected.context?.beanName) === key) selectShot(state.selected.id);
    if (coffeeKey($('ctx-bean').value) === prevKey) { $('ctx-bean').value = name; await contextChanged({ target: $('ctx-bean') }); }
  }
  toast(`Saved ${name}${touched ? ` and updated ${touched} shot${touched === 1 ? '' : 's'}` : ''}.`);
}
async function beansAction(ev) {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  const key = b.closest('tr')?.dataset.key;
  const bean = collectBeans().find((x) => x.key === key);
  if (!bean) return;
  if (b.dataset.act === 'edit') return openBeanDialog(bean);
  if (b.dataset.act === 'use') {
    writeContext({ ...readContext(), beanName: bean.name, roaster: bean.roaster || '', origin: bean.origin || '', process: bean.process || '', roastLevel: bean.roastLevel || '', doseG: bean.lastDoseG || readContext().doseG, grindSize: bean.lastGrind || readContext().grindSize });
    await contextChanged({ target: $('ctx-bean') });
    showView('shots');
    toast(`This coffee: ${bean.name}.`);
    return;
  }
  if (b.dataset.act === 'shots') {
    hist.search = bean.name;
    $('hist-search').value = bean.name;
    hist.filter = 'all';
    $('hist-filter').value = 'all';
    showView('history');
  }
}
$('beans-rows').addEventListener('click', beansAction);
$('beans-search').addEventListener('input', () => { beansView.search = $('beans-search').value; renderBeans(); });
$('beans-add').addEventListener('click', () => openBeanDialog(null));
$('beans-table').querySelector('thead').addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  if (beansView.sort === key) beansView.dir = beansView.dir === 'asc' ? 'desc' : 'asc';
  else { beansView.sort = key; beansView.dir = key === 'name' || key === 'roaster' ? 'asc' : 'desc'; }
  renderBeans();
});
$('b-save').addEventListener('click', () => saveBeanDialog().catch((err) => ($('b-error').textContent = err?.message || String(err))));
$('b-cancel').addEventListener('click', () => $('bean-dialog').close());
$('b-delete').addEventListener('click', async () => {
  if (!beanEditing) return;
  await store.deleteBean(beanEditing.name);
  $('bean-dialog').close();
  await refreshBeanLists();
  toast(`Removed ${beanEditing.name} from the library.`);
});
$('bean-form').addEventListener('submit', (e) => { e.preventDefault(); saveBeanDialog().catch((err) => ($('b-error').textContent = err?.message || String(err))); });

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
  renderBeanLink();
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

// ------------------------------------------------------------------ files --

const FOLDER_KEY = 'logFolderHandle'; // the picked folder's handle (name kept since v0.5)
const KIND_SETTING = { shots: 'dirShots', exports: 'dirExports', reports: 'dirReports', reviews: 'dirReviews', backups: 'dirBackups', logs: 'dirLogs' };

/** Push the destination and folder names from the settings into files.js. */
function applyFileSettings() {
  const layout = { root: settings.fileRoot };
  for (const [kind, key] of Object.entries(KIND_SETTING)) layout[kind] = settings[key];
  files.configure({ destination: settings.fileDestination, layout });
  renderFiles();
}

async function restoreFolder() {
  try {
    const handle = await store.getSetting(FOLDER_KEY, null);
    if (handle && typeof handle.queryPermission === 'function') await files.useFolder(handle);
  } catch (err) {
    log.warn('files', `could not restore the save folder: ${err?.message || err}`);
  }
  renderFiles();
}

async function pickFolder() {
  try {
    const handle = await files.pickFolder();
    try {
      await store.setSetting(FOLDER_KEY, handle); // Chrome can persist the handle
    } catch (err) {
      log.warn('files', `folder handle could not be saved for next time: ${err?.message || err}`);
    }
    if (settings.fileDestination !== 'folder' && settings.fileDestination !== 'auto') {
      settings.fileDestination = 'folder';
      await store.setSetting('fileDestination', 'folder');
      $('set-file-destination').value = 'folder';
      files.configure({ destination: 'folder' });
    }
    log.info('files', `save folder: ${handle.name}`);
    renderFiles();
    toast(`Files go to ${files.describe()}`);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    toast(err.message || String(err), 'error');
  }
}

async function reallowFolder() {
  if (!files.folder) return;
  await files.useFolder(files.folder, { request: true });
  renderFiles();
}

async function forgetFolder() {
  await log.flush().catch(() => {});
  files.forgetFolder();
  await store.setSetting(FOLDER_KEY, null);
  renderFiles();
}

/** Settings → Files and folders, the Logging status line, and every note that says where files land. */
function renderFiles() {
  const sel = $('set-file-destination');
  const serverOpt = sel.querySelector('option[value="server"]');
  serverOpt.disabled = !files.server;
  serverOpt.textContent = files.server ? `the data folder of the server that serves this page — ${files.server.dataDir}${files.server.host ? ` on ${files.server.host}` : ''}` : 'the data folder of the server (not offered: it was started without DATA_DIR)';
  sel.querySelector('option[value="folder"]').disabled = !Files.canPickFolder && !files.folder;
  sel.querySelector('option[value="auto"]').textContent = `whatever is available — ${files.folder ? 'the chosen folder' : files.server ? "the server's data folder" : 'downloads'} right now`;
  const eff = files.effective;
  $('files-folder-row').hidden = !(eff === 'folder' || settings.fileDestination === 'auto' || Files.canPickFolder);
  $('files-reallow-folder').hidden = files.folderState !== 'prompt';
  $('files-forget-folder').hidden = !files.folder;
  $('files-pick-folder').textContent = files.folder ? 'Choose another folder…' : 'Choose folder…';
  const where = $('files-folder');
  if (!files.folder) where.textContent = Files.canPickFolder ? 'No folder chosen.' : 'Folder picking needs Chrome or Edge.';
  else if (files.folderState === 'granted') where.textContent = `${files.folder.name}/ — writable`;
  else if (files.folderState === 'prompt') where.textContent = `${files.folder.name}/ — Chrome needs you to re-allow it`;
  else where.textContent = `${files.folder.name}/ — not writable (${files.folderState}${files.lastError ? ': ' + files.lastError : ''})`;
  const status = $('files-status');
  if (files.ready) {
    status.textContent = `Files are written to ${files.describe()}${files.filesWritten ? ` · ${files.filesWritten} file${files.filesWritten === 1 ? '' : 's'}, ${(files.bytesWritten / 1024).toFixed(1)} kB this session` : ''}${files.lastError ? ` · last error: ${files.lastError}` : ''}`;
    status.dataset.level = 'ok';
  } else {
    status.textContent = files.blocker;
    status.dataset.level = eff === 'downloads' && settings.fileDestination === 'downloads' ? 'ok' : 'warn';
  }
  const base = files.describe();
  $('files-layout').innerHTML = Object.entries(FILE_KINDS)
    .map(([kind, spec]) => `<tr><td>${esc(spec.label)}</td><td><code>${esc(files.ready ? base + (files.layout[kind] ? files.layout[kind] + '/' : '') : 'download folder')}</code></td><td>${esc(spec.what)}</td></tr>`)
    .join('');
  $('autosave-note').textContent = files.ready ? `Shot files land in ${files.whereOf('shots')}.` : 'Nothing is written until a folder (or the server\'s data folder) is chosen above; the database copy in this browser is kept regardless.';
  $('backup-note-where').textContent = files.ready ? `The automatic backup (${settings.autoBackup ? 'on' : 'off'}) and Write a backup now use ${files.whereOf('backups')}; the buttons above download through the browser.` : "The buttons above download through the browser; the automatic backup needs a folder or the server's data folder (Files and folders).";
  $('log-folder').textContent = files.ready ? `The log is appended to ${files.whereOf('logs')}<date>.log as it happens.` : 'The log stays in this page (last 5,000 lines); choose a destination under Files and folders to have it written as a file.';
  renderLogStatus();
}
files.addEventListener('change', () => {
  if (document.readyState !== 'loading' && $('files-status')) renderFiles();
});

// ---------------------------------------------------------- auto backup --

let backupTimer = null;
let backupBusy = false;
/**
 * Keep a current copy of the whole database at the destination:
 * <backups>/portal-met-bridge-latest.json after every change (debounced), and a
 * dated copy the first time each day. Never downloads anything on its own.
 */
function scheduleAutoBackup(reason = 'change') {
  if (!settings.autoBackup || !files.ready) return;
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    runAutoBackup(reason).catch((err) => log.warn('backup', `automatic backup failed: ${err?.message || err}`));
  }, 12000);
}

async function runAutoBackup(reason, { force = false } = {}) {
  if (backupBusy || (!force && !settings.autoBackup) || !files.ready) return false;
  backupBusy = true;
  try {
    const doc = await backupDocument();
    const text = JSON.stringify(doc);
    const path = await files.write('backups', 'portal-met-bridge-latest.json', text, { type: 'application/json' });
    const today = new Date().toISOString().slice(0, 10);
    const lastDaily = await store.getSetting('lastDailyBackup', '');
    if (lastDaily !== today) {
      await files.write('backups', `portal-met-bridge-${today}.json`, text, { type: 'application/json' });
      await store.setSetting('lastDailyBackup', today);
    }
    log.info('backup', `automatic backup (${reason}): ${path} · ${doc.shots.length} shots, ${(text.length / 1024).toFixed(0)} kB`);
    return true;
  } finally {
    backupBusy = false;
  }
}

function renderLogStatus() {
  const bits = [];
  bits.push(log.enabled ? `on · ${settings.logLevel}${settings.logPackets ? ' + packets' : ''}` : 'off');
  bits.push(`${log.ring.length} lines in memory${log.dropped ? ` (${log.dropped} dropped)` : ''}`);
  if (log.writing) bits.push(`writing to ${files.describe()}${files.layout.logs ? files.layout.logs + '/' : ''}`);
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
const tailTimer = setInterval(renderLogTail, 700);
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

// ------------------------------------------------------------------- stop --
// The Stop button in the top bar: one confirmation, then everything this page
// runs is stopped — a recording is finished and saved first, connections are
// closed, timers cleared, pending files written — and, when the server was
// started on this computer and allows it (GET api/server → quit: true), the
// local server too (POST api/quit), so start.command / the macOS app exit.

let appServer = null; // GET api/server: { version, pid, platform, dataDir, quit, quitStopsApp, local, tls, machineProxy } or null (python's http.server, a plain host)

/**
 * The page is not a secure context (a LAN address over plain http, or a file),
 * so Chrome hides Web Bluetooth: say exactly how to get one — the server's
 * https address when it has one, else the chrome://flags exception — with this
 * page's own origin filled in, since that is the string Chrome wants.
 */
function renderInsecureHint() {
  const el = $('portal-hint');
  const origin = location.origin;
  if (location.protocol === 'file:') {
    el.textContent = 'This page was opened as a file. Serve it (start.command, node serve.mjs, or the macOS app) and open http://localhost:8787 — Web Bluetooth needs a secure page.';
    return;
  }
  const parts = [`<b>Bluetooth is off because this page (${esc(origin)}) is not a secure context</b> — Chrome only offers Web Bluetooth on https or on localhost. The machine still works. Two ways to fix it:`];
  if (appServer?.tls?.port) {
    const secure = `https://${location.hostname}:${appServer.tls.port}${location.pathname}`;
    parts.push(`<b>1.</b> Open the secure address <a href="${esc(secure)}">${esc(secure)}</a>.${appServer.tls.selfSigned ? ` Its certificate is self-signed, so the first time: <a href="api/cert" download="portal-met-bridge.pem">download the certificate</a>, double-click it to add it to Keychain Access (login), open it there → Trust → <i>Always Trust</i>, then quit and reopen Chrome. After that the https page is secure and Bluetooth works.` : ''}`);
    parts.push(`<b>2.</b> Or keep this address and allow it in Chrome: open <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, paste <code>${esc(origin)}</code>, set it to <i>Enabled</i>, press <i>Relaunch</i>.`);
  } else {
    parts.push(`<b>1.</b> Allow this address in Chrome: open <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, paste <code>${esc(origin)}</code>, set it to <i>Enabled</i>, press <i>Relaunch</i>.`);
    parts.push(`<b>2.</b> Or open the app at <code>http://localhost:8787</code> on the computer that runs it${appServer ? '' : ', or serve it with serve.mjs (which can also offer an https address — see docs/PACKAGING.md)'}.`);
  }
  el.innerHTML = parts.join(' ');
}
async function probeAppServer() {
  try {
    const res = await fetch('api/server', { cache: 'no-store' });
    appServer = res.ok ? await res.json() : null;
  } catch {
    appServer = null;
  }
  return appServer;
}

function stopItems() {
  const items = [];
  if (recorder.isRecording) items.push('the recording in progress — it is finished and saved first');
  if (portal.device || portal.connected) items.push(`the Bluetooth link to ${portal.device?.name || 'the Portal'}`);
  if (meticulous) items.push(`the connection to the machine${meticulous.connected ? '' : ' (reconnecting)'}`);
  if (an.running) items.push('the AI review being written');
  if (state.liveTimer || replayTimer) items.push('the live chart updates');
  items.push(`timers and background work (automatic backup, log writing, machine-record attach)${files.ready ? ' — pending files are written before stopping' : ''}`);
  return items;
}

function openStopDialog() {
  if (state.stopped) return;
  $('stop-list').innerHTML = stopItems().map((t) => `<li>${esc(t)}</li>`).join('');
  const brewing = !!meticulous?.lastStatus?.extracting;
  $('stop-brew-row').hidden = !brewing;
  $('stop-brew').checked = false;
  const canQuit = !!appServer?.quit;
  $('stop-server-row').hidden = !canQuit;
  $('stop-server').checked = false;
  const ha = appServer?.platform === 'home-assistant';
  if (canQuit) $('stop-server-label').textContent = ha
    ? `Also stop the Portal Met Bridge app in Home Assistant (${appServer.host}${appServer.dataDir ? `, files in ${appServer.dataDir}` : ''}) — it shows as stopped there until you start it again`
    : `Also stop the local server (serve.mjs, pid ${appServer.pid}${appServer.dataDir ? `, files in ${appServer.dataDir}` : ''}) — start.command or the app will exit`;
  $('stop-server').checked = ha; // in Home Assistant, stopping the app is what Stop is for
  $('stop-note').textContent = canQuit
    ? ha
      ? 'Without the last box only this page stops and the app keeps serving it; with it, Home Assistant shows the app stopped and its Start button brings it back.'
      : 'Without the last box the server keeps serving the page; Start again reloads it. With it, start the app again before reloading.'
    : appServer
      ? 'This server is not on this computer (or was started with ALLOW_QUIT=0), so it keeps running; only this page stops.'
      : 'Only this page stops; the server that serves it is not one this page can stop.';
  $('stop-dialog').showModal();
}

async function stopEverything({ quitServer = false, abortBrew = false } = {}) {
  if (state.stopped) return;
  state.stopped = true;
  const report = [];
  const dlg = $('stop-dialog');
  if (dlg.open) dlg.close();
  $('app-stop').disabled = true;
  log.info('app', `stop requested${quitServer ? ' (and the server)' : ''}${abortBrew ? ' (and the brew)' : ''}`);
  // 1. The brew on the machine, if asked.
  if (abortBrew && meticulous?.connected) {
    try {
      await meticulous.action('abort');
      report.push('brew stopped on the machine');
    } catch (err) {
      report.push(`brew: the machine did not accept abort (${err?.message || err})`);
    }
  }
  // 2. A recording in progress: finish and save it (the 'shot' handler persists it).
  if (recorder.isRecording) {
    const saved = new Promise((r) => {
      const done = () => r(true);
      recorder.addEventListener('shot', done, { once: true });
      setTimeout(() => r(false), 4000);
    });
    recorder.stopManual();
    report.push((await saved) ? 'recording finished and saved' : 'recording stopped');
  }
  // 3. The AI review, the live loops, the connections.
  if (an.abort) {
    an.abort.abort();
    report.push('AI review cancelled');
  }
  stopLiveLoop();
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
  try {
    if (portal.device || portal.connected) {
      await portal.disconnect();
      report.push('Portal disconnected');
    }
  } catch (err) {
    report.push(`Portal: ${err?.message || err}`);
  }
  if (meticulous) {
    try {
      machinePanel.detach();
      meticulous.disconnect();
    } catch {
      /* ignore */
    }
    meticulous = null;
    heat.reset();
    report.push('machine disconnected');
  }
  // 4. Timers and pending work: settings, the backup, the log.
  clearInterval(tailTimer);
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
    try {
      if (await runAutoBackup('stop')) report.push('automatic backup written');
    } catch (err) {
      report.push(`backup: ${err?.message || err}`);
    }
  }
  try {
    await saveAllSettings({ quiet: true });
  } catch {
    /* nothing pending */
  }
  await log.flush().catch(() => {});
  report.push('timers cleared, log flushed');
  // 5. The server.
  let serverStopped = false;
  if (quitServer && appServer?.quit) {
    try {
      const res = await fetch('api/quit', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.stopping) {
        serverStopped = true;
        report.push(body.app ? 'the Portal Met Bridge app in Home Assistant is stopping' : `server stopped (pid ${body.pid})`);
      } else report.push(`server: ${body.error || res.status}`);
    } catch (err) {
      report.push(`server: ${err?.message || err}`);
    }
  }
  // 6. Show it.
  $('stopped-list').innerHTML = report.map((t) => `<li>${esc(t)}</li>`).join('');
  $('stopped-note').textContent = serverStopped
    ? appServer?.platform === 'home-assistant'
      ? 'The app has been stopped in Home Assistant (Settings → Apps → Portal Met Bridge shows it stopped). Press Start there to bring it back, then reload this page.'
      : 'The server that served this page has exited. Start it again (start.command, the app, or node serve.mjs) and then open http://localhost:8787 — this page can no longer reload itself.'
    : 'Nothing saved was touched. Start again reloads the page; the machine and the Portal reconnect when you ask them to.';
  $('stopped-again').disabled = serverStopped;
  $('stopped').hidden = false;
  document.title = 'portal-met-bridge — stopped';
  return report;
}

$('app-stop').addEventListener('click', openStopDialog);
$('stop-cancel').addEventListener('click', () => $('stop-dialog').close());
$('stop-go').addEventListener('click', () => stopEverything({ quitServer: !$('stop-server-row').hidden && $('stop-server').checked, abortBrew: !$('stop-brew-row').hidden && $('stop-brew').checked }));
$('stopped-again').addEventListener('click', () => location.reload());

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
  const hasFolder = files.effective !== 'downloads' && (files.folder || files.server);
  $('reset-folder-row').hidden = !hasFolder;
  if (hasFolder) {
    const what = files.rootInUse ? `${files.describe()}` : `the ${Object.keys(FILE_KINDS).map((k) => files.layout[k]).filter(Boolean).join(', ')} folders in ${files.describe()}`;
    $('reset-folder-label').textContent = `Also delete the files this app wrote in ${what} (shot files, exports, reports, reviews, backups, logs)${!files.ready ? ' — the folder must be writable first' : ''}`;
    $('reset-folder').checked = files.ready;
    $('reset-folder').disabled = !files.ready;
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

    // 2. Files at the destination (only our own folders), then stop writing there.
    log.dropPending(); // never recreate logs after the wipe
    if (backupTimer) clearTimeout(backupTimer);
    backupTimer = null;
    if (wipeFolder) {
      say('Deleting the files this app wrote…');
      try {
        const where = files.describe();
        const removed = await files.eraseAll();
        report.push(removed.length ? `deleted ${where}${removed.length > 1 ? ` (${removed.join(', ')})` : ''}` : 'no app files found at the destination');
      } catch (err) {
        report.push(`files: ${err?.message || err}`);
      }
    }
    files.forgetFolder();
    files.configure({ destination: 'downloads' });

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
  if (erasing || state.stopped) return;
  if (recorder.isRecording) checkpointLiveShot(true); // best effort; the periodic checkpoint is the real guarantee
  if ((!$('view-settings').hidden && dirtySettings().length) || recorder.isRecording) {
    e.preventDefault();
    e.returnValue = '';
  }
});
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));
$('meticulous-test').addEventListener('click', testMeticulous);
$('settings-export').addEventListener('click', () => deliver(`portal-met-bridge-settings-${stamp(Date.now())}.json`, JSON.stringify(settingsDocument(), null, 2), 'application/json', 'backups', { via: 'browser' }));
$('settings-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const n = await importSettingsDocument(JSON.parse(await file.text()));
    const held = importSettingsDocument.held || [];
    toast(held.length ? `Imported ${n} settings. The OpenAI-compatible endpoint in the file (${held[0]}) was not applied — your API key is sent there, so type it under AI review yourself if you trust it.` : `Imported ${n} settings.`, held.length ? 'warn' : undefined);
    log.info('settings', `imported ${n} settings from ${file.name}${held.length ? '; endpoint left unchanged' : ''}`);
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
  e.target.value = '';
});
$('settings-reset').addEventListener('click', async () => {
  if (!confirm('Reset every setting to its default? Shots, beans and the chosen folder are kept.')) return;
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
$('files-pick-folder').addEventListener('click', pickFolder);
$('files-reallow-folder').addEventListener('click', reallowFolder);
$('files-forget-folder').addEventListener('click', forgetFolder);
$('files-backup-now').addEventListener('click', async () => {
  const how = await chooseDialog({
    title: 'Write a backup now',
    text: 'The whole database: shots with their samples, readings, beans, saved reviews.',
    choices: [
      { id: 'folder', label: files.ready ? `Save to ${files.whereOf('backups')}` : 'Save to the backups folder', hint: files.ready ? 'portal-met-bridge-latest.json, plus a dated copy the first time each day' : files.blocker, disabled: !files.ready },
      { id: 'browser', label: 'Download through the browser', hint: 'portal-met-bridge-backup-<date>.json in your download folder' },
    ],
  });
  if (!how) return;
  try {
    if (how === 'browser') {
      const doc = await backupDocument();
      download(`portal-met-bridge-backup-${stamp(Date.now())}.json`, JSON.stringify(doc), 'application/json');
      toast(`Backup downloaded (${doc.shots.length} shots).`);
      return;
    }
    const ok = await runAutoBackup('button', { force: true });
    toast(ok ? `Backup written to ${files.whereOf('backups')}` : 'A backup is already being written.');
  } catch (err) {
    toast(`Backup failed: ${err?.message || err}`, 'error');
  }
});
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
  else { hist.sort = key; hist.dir = key === 'startedAt' || key === 'meanEc' || key === 'tds' || key === 'finalWeightG' || key === 'durationSec' || key === 'rating' ? 'desc' : 'asc'; }
  renderHistory();
}));
$('hist-select-all').addEventListener('change', () => {
  const rows = state.shots.filter((x) => histMatches(x) && !x.inProgress);
  if ($('hist-select-all').checked) rows.forEach((x) => hist.checked.add(x.id));
  else rows.forEach((x) => hist.checked.delete(x.id));
  renderHistory();
});
$('hist-delete-selected').addEventListener('click', () => deleteShots([...hist.checked]));
$('hist-export').addEventListener('click', () => downloadZip([...hist.checked]));
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
$('dl-zip').addEventListener('click', () => downloadZip());
$('demo-load').addEventListener('click', addDemoShot);
$('demo-replay').addEventListener('click', replayDemoLive);
async function backupDocument() {
  return store.exportAll();
}
$('backup-export').addEventListener('click', async () => {
  const doc = await backupDocument();
  await deliver(`portal-met-bridge-backup-${stamp(Date.now())}.json`, JSON.stringify(doc), 'application/json', 'backups', { via: 'browser' });
  $('backup-note').textContent = `${doc.shots.length} shots, ${doc.beans.length} beans — downloaded.`;
});

/**
 * A small "which way?" dialog: resolves to the chosen id, or null when dismissed.
 * choices: [{ id, label, hint, disabled }].
 */
function chooseDialog({ title, text = '', choices }) {
  return new Promise((resolve) => {
    const dlg = $('choice-dialog');
    $('choice-title').textContent = title;
    $('choice-text').textContent = text;
    $('choice-text').hidden = !text;
    $('choice-list').innerHTML = choices.map((c) => `<button type="button" class="choice" data-id="${esc(c.id)}" ${c.disabled ? 'disabled' : ''}><b>${esc(c.label)}</b>${c.hint ? `<small>${esc(c.hint)}</small>` : ''}</button>`).join('');
    // resolve from the close event (it fires asynchronously after close()), so a dialog
    // opened right after this one cannot be closed by this one's late event
    let result = null;
    $('choice-list').onclick = (ev) => { const b = ev.target.closest('button.choice'); if (b && !b.disabled) { result = b.dataset.id; dlg.close(); } };
    $('choice-cancel').onclick = () => { result = null; dlg.close(); };
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
    dlg.querySelector('button.choice:not([disabled])')?.focus();
  });
}

/** Restore from a backup: a file you upload, or one of the backups saved in the backups folder. */
async function restoreBackup(json, label) {
  const n = await store.importAll(json);
  await refreshBeanLists();
  await refreshShotList();
  renderBeans();
  await renderSavedReviews(); // a backup carries reviews too; without this they appeared only after a reload
  toast(`Restored ${n} shots from ${label}.`);
  $('backup-note').textContent = `Restored ${n} shots from ${label}.`;
}
$('backup-restore').addEventListener('click', async () => {
  const saved = files.ready ? await files.list('backups').catch(() => []) : [];
  const jsons = saved.filter((f) => /\.json$/i.test(f.name));
  const how = await chooseDialog({
    title: 'Restore from a backup',
    text: 'Restoring merges by shot id — nothing already here is deleted.',
    choices: [
      { id: 'upload', label: 'Upload a backup file', hint: 'choose a portal-met-bridge-backup-….json (or -latest.json) with the browser' },
      { id: 'saved', label: `Pick one of the saved backups`, hint: files.ready ? (jsons.length ? `${jsons.length} in ${files.whereOf('backups')}` : `none yet in ${files.whereOf('backups')}`) : 'needs a folder or the server\'s data folder under Files and folders', disabled: !jsons.length },
    ],
  });
  if (how === 'upload') return $('backup-import').click();
  if (how !== 'saved') return;
  const which = await chooseDialog({
    title: `Saved backups in ${files.whereOf('backups')}`,
    text: 'Newest first.',
    choices: jsons.slice(0, 30).map((f) => ({ id: f.name, label: f.name, hint: `${fmtDate(f.mtime)} · ${(f.size / 1024).toFixed(0)} kB` })),
  });
  if (!which) return;
  try {
    await restoreBackup(JSON.parse(await files.read('backups', which)), which);
  } catch (err) {
    toast(`Restore failed: ${err?.message || err}`, 'error');
  }
});
$('backup-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await restoreBackup(JSON.parse(await file.text()), file.name);
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

// ------------------------------------------------------------ ready to brew --
// heat.js watches the water temperature against the loaded profile's target with
// the rule from Settings → Machine; Start brew is green while it says "ready".
const heat = new HeatMonitor();

function applyHeatSettings() {
  heat.configure({ rule: settings.heatRule, sensor: settings.heatSensor, toleranceC: settings.heatToleranceC, holdSec: settings.heatHoldSec, settleC: settings.heatSettleC });
  renderHeat(meticulous?.lastStatus || null);
}

/** The brew temperature of the profile the machine has loaded (by id, else by a unique name). */
function loadedProfileTemperature(s) {
  const list = state.profileList || [];
  const byId = s?.profileId && list.find((p) => p.id === s.profileId);
  if (byId?.temperatureC) return byId.temperatureC;
  const full = s?.profileId && state.profileFull?.get?.(s.profileId);
  if (Number(full?.temperature) > 0) return Number(full.temperature);
  const named = s?.profile ? list.filter((p) => p.name === s.profile) : [];
  return named.length === 1 ? named[0].temperatureC : null;
}

let heatText = '';
let heatLiveText = '';
function renderHeat(s) {
  const line = $('brew-heat');
  const btn = $('brew-start');
  if (!s || $('brew-controls').hidden) {
    line.hidden = true;
    btn.classList.remove('ready');
    heatText = '';
  } else {
    const ready = heat.ready && !s.extracting;
    btn.classList.toggle('ready', ready);
    const text = heat.describe();
    if (text !== heatText) {
      heatText = text;
      line.textContent = text;
      line.dataset.ready = String(ready);
      line.hidden = false;
    }
  }
  // Settings → Machine: the live readings, so the sensor choice can be made with eyes open.
  if (!$('view-settings').hidden) {
    const sens = meticulous?.lastSensors;
    const live = s
      ? `Now: status ${fmt(s.temp, 1)} °C · probe 1 ${fmt(sensorTemp('ext1', s, sens), 1)} · probe 2 ${fmt(sensorTemp('ext2', s, sens), 1)} · tube ${fmt(sensorTemp('tube', s, sens), 1)} · bar ${fmt(sensorTemp('bar', s, sens), 1)} — target ${heat.targetC !== null ? `${fmt(heat.targetC, 1)} °C (${s.profile || 'loaded profile'})` : 'unknown (the loaded profile has no temperature)'} — ${heat.describe()}`
      : 'Connect the machine to see the readings here.';
    if (live !== heatLiveText) {
      heatLiveText = live;
      $('heat-live').textContent = live;
    }
  }
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
const an = { ids: [], search: '', running: false, failed: false, abort: null, markdown: '', digests: [], shots: [], meta: null, savedId: null, chartShotId: null, chart: null, confirmed: new Set(), pending: new Map(), request: null, cutOff: false, continued: 0 };

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
  renderEndpointNote();
  const run = $('an-run');
  if (run) {
    run.textContent = `Review with ${label.replace(/ \(.*\)$/, '')}`;
    run.disabled = an.running || !an.ids.length || !key || !allConfirmed();
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

/** Says, under the custom endpoint, where the key will go and warns when that is an unencrypted address on the internet. */
function renderEndpointNote() {
  const el = $('set-ai-base-note');
  if (!el) return;
  const v = $('set-ai-base-openai').value.trim();
  const risk = endpointRisk(v);
  el.dataset.level = risk ? 'bad' : '';
  el.textContent = !v ? '' : risk === 'invalid' ? 'Not a web address — it must start with https:// (or http:// for a server on this computer or your network).' : risk === 'insecure' ? 'This address is plain http on the internet: the API key and your shot data would travel unencrypted. Use https.' : `Your API key and each review request are sent to ${new URL(v).host}.`;
}
$('set-ai-base-openai').addEventListener('input', renderEndpointNote);

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
  an.confirmed = new Set();
  an.pending = new Map();
  showView('analysis');
}
const allConfirmed = () => an.ids.length > 0 && an.ids.every((id) => an.confirmed.has(id));

function shotLabel(s) {
  const c = s.context || {};
  return `${fmtDate(s.startedAt)} · ${c.beanName || 'unnamed coffee'} · ${s.profileName || 'no profile'}${c.doseG ? ` · ${fmt(Number(c.doseG), 1)} → ${fmt(beverageOf(s), 1)} g` : ''}`;
}

function renderAnalysis() {
  renderAnalysisList();
  renderPreflight();
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
      const tags = [s.portal?.length ? `P ${Number(s.portal.length) || 0}` : 'no Portal', s.machineShotId ? 'record' : 'live', c.grindSize ? `${esc(c.grindSize)}` : ''].filter(Boolean);
      return `<li class="${on ? 'on' : ''}"><label><input type="checkbox" data-id="${esc(s.id)}" ${on ? 'checked' : ''} /> <span class="when">${esc(fmtDate(s.startedAt))}</span> <span class="what">${esc(c.beanName || 'unnamed coffee')} <small>${esc(s.profileName || '')}</small></span> <span class="tags">${ratingsOn() ? starsHtml(s, { compact: true }) : ''}${tags.map((t) => `<span class="tag">${t}</span>`).join('')}</span></label></li>`;
    })
    .join('');
  if (!shown.length) ul.innerHTML = `<li class="empty">${state.shots.length ? 'No shot matches.' : 'No shots recorded yet.'}</li>`;
  setText('an-sel-count', an.ids.length ? `(${an.ids.length})` : '');
  $('an-run').disabled = an.running || !an.ids.length || !aiConfig().key || !allConfirmed();
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
  } else {
    an.ids = an.ids.filter((x) => x !== id);
    an.confirmed.delete(id);
    an.pending.delete(id);
  }
  an.ids.sort((a, b) => (state.shots.find((s) => s.id === a)?.startedAt || 0) - (state.shots.find((s) => s.id === b)?.startedAt || 0));
  an.savedId = null;
  renderAnalysis();
});

// ------------------------------------------------- before the review --
// Each ticked shot is confirmed before the model sees it: which profile the
// review should read (the one the machine recorded, or another profile on the
// machine) and what the final weight is (the hand-weighed value, the profile's
// target, the scale, or a number typed now). Confirming writes the choice to
// the shot, so History, exports and later reviews agree with it.

const WEIGHT_CHOICES = { weighed: 'weighed by hand', profile: "the profile's target", scale: "the machine's scale", manual: 'typed now' };

function pendingFor(shot) {
  if (!an.pending.has(shot.id)) {
    const src = beverageSource(shot);
    an.pending.set(shot.id, { profileSel: 'recorded', weight: src || 'manual', manual: '' });
  }
  return an.pending.get(shot.id);
}

/** The profile the pending choice points at: the record (or the shot's earlier choice) or a machine profile fetched in full. */
function pendingProfile(shot, pend) {
  if (pend.profileSel === 'recorded') return reviewProfileOf(shot);
  return state.profileFull?.get(pend.profileSel) || null;
}

function profileLine(profile, { shotTarget } = {}) {
  if (!profile) return 'no profile details — the shot carries a name only';
  const target = profileFinalWeight(profile) ?? shotTarget;
  const vars = (profile.variables || []).filter((v) => v && v.key).map((v) => `${v.name || v.key} ${v.value}${v.type === 'time' ? ' s' : v.type === 'flow' ? ' ml/s' : v.type === 'pressure' ? ' bar' : v.type === 'weight' ? ' g' : v.type === 'temperature' ? ' °C' : ''}`);
  return [
    `final weight ${target > 0 ? `${fmt(target, 1)} g` : 'not set'}`,
    Number(profile.temperature) > 0 ? `${fmt(Number(profile.temperature), 0)} °C` : null,
    ...vars,
    Array.isArray(profile.stages) && profile.stages.length ? `${profile.stages.length} stages: ${profile.stages.map((s) => s?.name).filter(Boolean).join(' → ')}` : 'stages not included',
  ].filter(Boolean).join(' · ');
}

function renderPreflight() {
  const panel = $('an-preflight');
  if (!an.ids.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const shots = an.ids.map((id) => state.shots.find((s) => s.id === id)).filter(Boolean).sort((a, b) => a.startedAt - b.startedAt);
  const machineProfiles = state.profileList || [];
  $('an-preflight-rows').innerHTML = shots
    .map((shot) => {
      const pend = pendingFor(shot);
      const recorded = reviewProfileOf(shot);
      const profile = pendingProfile(shot, pend);
      const target = profile ? profileFinalWeight(profile) ?? profileTargetOf(shot) : profileTargetOf(shot);
      const done = an.confirmed.has(shot.id);
      const recLabel = shot.reviewProfile ? `Chosen earlier — ${esc(shot.reviewProfile.name || '?')}` : recorded ? `As recorded — ${esc(recorded.name || shot.profileName || '?')}` : `Name only — ${esc(shot.profileName || 'unknown profile')}`;
      const options = [`<option value="recorded" ${pend.profileSel === 'recorded' ? 'selected' : ''}>${recLabel}${target > 0 ? ` · ${fmt(target, 0)} g` : ''}</option>`]
        .concat(machineProfiles.map((p) => `<option value="${esc(p.id)}" ${pend.profileSel === p.id ? 'selected' : ''}>On the machine — ${esc(p.name)}${p.finalWeightG ? ` · ${fmt(p.finalWeightG, 0)} g` : ''}${p.temperatureC ? ` · ${fmt(p.temperatureC, 0)} °C` : ''}</option>`))
        .join('');
      const w = (value, label, enabled = true) => `<label class="${enabled ? '' : 'off'}"><input type="radio" name="pfw-${esc(shot.id)}" value="${value}" ${pend.weight === value ? 'checked' : ''} ${enabled ? '' : 'disabled'} /> ${label}</label>`;
      return `<div class="pf-row ${done ? 'done' : ''}" data-id="${esc(shot.id)}">
        <h3>${esc(shotLabel(shot))} ${done ? '<span class="pf-state">✓ confirmed</span>' : '<span class="pf-state todo">to confirm</span>'}</h3>
        <div class="pf-grid">
          <label class="field"><span>Brew profile the review should read</span>
            <select class="pf-profile">${options}</select>
          </label>
          <p class="pf-vars">${esc(profileLine(profile, { shotTarget: profileTargetOf(shot) }))}${!machineProfiles.length ? ' · <em>connect the machine to choose another profile</em>' : ''}</p>
          <fieldset class="pf-weight"><legend>Final weight of this brew</legend>
            ${w('weighed', `weighed by hand: <b>${Number(shot.beverageG) > 0 ? `${fmt(shot.beverageG, 1)} g` : 'none'}</b>`, Number(shot.beverageG) > 0)}
            ${w('profile', `the profile's target: <b>${target > 0 ? `${fmt(target, 1)} g` : 'unknown'}</b>`, target > 0)}
            ${w('scale', `the machine's scale: <b>${Number(shot.finalWeightG) > 0 ? `${fmt(shot.finalWeightG, 1)} g` : 'none'}</b>`, Number(shot.finalWeightG) > 0)}
            ${w('manual', `other: <input type="number" class="pf-manual" step="0.1" min="0" inputmode="decimal" value="${esc(pend.manual)}" placeholder="g" /> g`)}
          </fieldset>
          <div class="row"><button class="btn small primary pf-confirm">${done ? 'Confirm again' : 'Confirm'}</button></div>
        </div>
      </div>`;
    })
    .join('');
  $('an-confirm-all').disabled = false;
  $('an-run-hint').textContent = runHint();
}

const runHint = () => (allConfirmed() ? '' : `Confirm the profile and final weight of ${an.ids.length === 1 ? 'the shot' : `all ${an.ids.length} shots`} above before the review can start.`);

/** A choice changed after confirming: take the tick away without redrawing the row (the typed field keeps focus). */
function markUnconfirmed(id) {
  an.confirmed.delete(id);
  const row = $('an-preflight-rows').querySelector(`.pf-row[data-id="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.remove('done');
    const st = row.querySelector('.pf-state');
    if (st) {
      st.textContent = 'to confirm';
      st.classList.add('todo');
    }
    const b = row.querySelector('.pf-confirm');
    if (b) b.textContent = 'Confirm';
  }
  $('an-run').disabled = true;
  $('an-run-hint').textContent = runHint();
}

$('an-preflight-rows').addEventListener('change', async (e) => {
  const row = e.target.closest('.pf-row');
  if (!row) return;
  const shot = state.shots.find((s) => s.id === row.dataset.id);
  if (!shot) return;
  const pend = pendingFor(shot);
  if (e.target.classList.contains('pf-profile')) {
    pend.profileSel = e.target.value;
    if (pend.profileSel !== 'recorded' && !state.profileFull?.get(pend.profileSel)) {
      try {
        const full = await meticulous.profile(pend.profileSel);
        if (!state.profileFull) state.profileFull = new Map();
        state.profileFull.set(pend.profileSel, full);
        log.info('ai', `profile ${full?.name || pend.profileSel} fetched for the review`);
      } catch (err) {
        toast(`Could not fetch that profile from the machine: ${err?.message || err}`, 'error');
        pend.profileSel = 'recorded';
      }
    }
    an.confirmed.delete(shot.id);
    renderPreflight();
    renderAnalysisSize();
  } else if (e.target.type === 'radio') {
    pend.weight = e.target.value;
    markUnconfirmed(shot.id);
  }
  // the typed field is handled on input, below
});
$('an-preflight-rows').addEventListener('input', (e) => {
  if (e.target.classList.contains('pf-manual')) {
    const row = e.target.closest('.pf-row');
    const pend = an.pending.get(row?.dataset.id);
    if (pend) {
      pend.manual = e.target.value;
      pend.weight = 'manual';
      row.querySelector('input[type=radio][value="manual"]').checked = true;
      markUnconfirmed(row.dataset.id);
    }
  }
});

/** Write the pending choices for one shot to the store and mark it confirmed. */
async function confirmShot(id) {
  const shot = await store.getShot(id);
  if (!shot) return false;
  const pend = pendingFor(shot);
  // profile
  if (pend.profileSel !== 'recorded') {
    const full = state.profileFull?.get(pend.profileSel);
    if (!full) return toast('That profile has not been fetched from the machine yet.', 'error') && false;
    shot.reviewProfile = compactProfile(full);
    shot.reviewProfile.id = full.id || pend.profileSel;
    shot.profileName = full.name || shot.profileName;
    shot.profileId = full.id || pend.profileSel;
    const t = profileFinalWeight(full);
    if (t > 0) shot.profileTargetG = t;
    if (Number(full.temperature) > 0) shot.profileTemperatureC = Number(full.temperature);
  } else if (shot.reviewProfile && pend.profileSel === 'recorded' && shot.machineSource?.profile) {
    // back to what the machine recorded
    delete shot.reviewProfile;
    shot.profileName = shot.machineSource.profile.name || shot.profileName;
    shot.profileId = shot.machineSource.profile.id || shot.profileId;
    const t = profileFinalWeight(shot.machineSource.profile);
    if (t > 0) shot.profileTargetG = t;
  }
  // final weight
  if (pend.weight === 'manual') {
    const v = Number(pend.manual);
    if (!(v > 0 && v < 5000)) return toast('Type the final weight in grams, or pick one of the other sources.', 'error') && false;
    shot.beverageG = Math.round(v * 10) / 10;
    delete shot.beveragePrefer;
  } else if (pend.weight === 'weighed') {
    if (!(Number(shot.beverageG) > 0)) return toast('There is no hand-weighed value for this shot.', 'error') && false;
    delete shot.beveragePrefer;
  } else {
    delete shot.beverageG;
    shot.beveragePrefer = pend.weight; // 'profile' | 'scale', pinned for this shot whatever Settings says
  }
  if (shot.refractometer?.tdsPct > 0) shot.refractometer = { ...shot.refractometer, eyPct: extractionYield(shot.refractometer.tdsPct, beverageOf(shot), Number(shot.context?.doseG) || 0) };
  delete shot.analysisCache;
  recomputeCache(shot);
  await store.putShot(shot);
  if (shot.files && settings.autoSaveFiles) autosaveShotFiles(shot).catch(() => {});
  an.confirmed.add(id);
  log.info('ai', `confirmed for review: ${id} → profile ${shot.profileName}${shot.reviewProfile ? ' (chosen)' : ''}, final weight ${fmt(beverageOf(shot), 1)} g (${beverageSource(shot) || 'unknown'})`);
  return true;
}

$('an-preflight-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('.pf-confirm');
  if (!btn) return;
  const id = e.target.closest('.pf-row')?.dataset.id;
  if (!id) return;
  btn.disabled = true;
  const ok = await confirmShot(id);
  await refreshShotList();
  if (state.selected?.id === id) await selectShot(id);
  renderAnalysis();
  if (ok) toast('Confirmed.');
});
$('an-confirm-all').addEventListener('click', async () => {
  let n = 0;
  for (const id of an.ids) if (await confirmShot(id)) n++;
  await refreshShotList();
  renderAnalysis();
  toast(n === an.ids.length ? `Confirmed ${n} shot${n === 1 ? '' : 's'}.` : `Confirmed ${n} of ${an.ids.length}; the rest need a final weight.`);
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
    const profile = compactProfile(reviewProfileOf(shot));
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
      const head = `<h3>${esc(shotLabel(shot))}</h3><p class="hint">${[m.profile ? `${esc(m.profile)}${shot.reviewProfile ? ' (profile chosen for this review)' : m.recordedProfile === undefined && !shot.machineSource?.profile ? ' (name only)' : ''}` : 'profile unknown', m.grindUm ? `${fmt(m.grindUm, 0)} µm` : 'no grind recorded', m.doseG ? `${fmt(m.doseG, 1)} g in` : 'no dose', `${fmt(m.beverageG, 1)} g out (${m.beverageSource === 'profile' ? 'profile target' : m.beverageSource === 'weighed' ? 'weighed' : 'scale'})`, m.ratio ? `1 : ${fmt(m.ratio, 2)}` : null, `${fmt(m.durationSec, 1)} s`, m.profileTargetG ? `target ${fmt(m.profileTargetG, 1)} g` : null, m.profileTemperatureC ? `setpoint ${fmt(m.profileTemperatureC, 0)} °C` : null, digest.ec ? `mean EC/g ${fmt(digest.ec.meanEcPerG, 3)}` : null, m.rating ? `rated ${Number(m.rating) || 0}/${Number(m.ratingMax) || 5}` : 'not rated'].filter(Boolean).join(' · ')}${m.comment ? `<br><em>“${esc(m.comment)}”</em>` : ''}</p>`;
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
  $('an-continue').hidden = !(done && an.cutOff && an.request);
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
  if (!allConfirmed()) return toast('Confirm the brew profile and final weight of every ticked shot first.', 'error');
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
  const tick = setInterval(() => (status.textContent = `${PROVIDERS[provider].label} is ${an.continued ? `continuing after the length limit (part ${an.continued + 1})` : 'writing'}… ${((performance.now() - t0) / 1000).toFixed(0)} s`), 500);
  status.textContent = `Sending ${approxTokens(system + user).toLocaleString()} tokens to ${PROVIDERS[provider].label}…`;
  renderReport();
  const maxTokens = maxTokensFor(items.length);
  an.request = { provider, key, model, baseUrl, system, user, maxTokens };
  an.cutOff = false;
  an.continued = 0;
  log.info('ai', `review started: ${provider}/${model}, ${items.length} shot(s), up to ${maxTokens} output tokens`);
  try {
    let finish = await streamReviewPart(an.request, ctrl.signal);
    // A series review can run past the model's output limit; ask for the rest, picking up where it stopped.
    while (finish === 'length' && an.continued < 2) {
      an.continued++;
      log.info('ai', `review cut off at ${an.markdown.length} chars; continuing (${an.continued})`);
      finish = await streamReviewPart(an.request, ctrl.signal, an.markdown);
    }
    an.cutOff = finish === 'length';
    an.meta.durationMs = performance.now() - t0;
    status.textContent = an.cutOff ? `Stopped at the model's length limit after ${(an.meta.durationMs / 1000).toFixed(0)} s — the report is cut off; press Continue for the rest.` : `Done in ${(an.meta.durationMs / 1000).toFixed(0)} s${an.continued ? ` (in ${an.continued + 1} parts)` : ''}.`;
    log.info('ai', `review finished: ${an.markdown.length} chars in ${(an.meta.durationMs / 1000).toFixed(1)} s${an.cutOff ? ' (cut off)' : ''}`);
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

/**
 * One streamed answer appended to an.markdown. With `sofar` the request
 * continues the conversation: the text so far as the assistant's turn, then
 * "continue where you stopped". Returns the finish reason ('stop' | 'length').
 */
async function streamReviewPart(req, signal, sofar = '') {
  let finish = 'stop';
  const history = sofar ? [{ role: 'assistant', content: sofar }, { role: 'user', content: 'Your report was cut off by the output limit. Continue it exactly where it stopped — do not repeat anything already written, do not restart a section or add a preamble, begin mid-sentence if that is where it stopped, and keep the same section outline through to Sources.' }] : [];
  await streamCompletion(
    req.provider,
    { key: req.key, model: req.model, baseUrl: req.baseUrl, system: req.system, user: req.user, history, maxTokens: req.maxTokens },
    {
      signal,
      onRetry: (err) => log.warn('ai', `${req.model} refused a sampling parameter (${err.detail || err.message}); retrying without it`),
      onFinish: (f) => (finish = f || 'stop'),
      onDelta: (d) => {
        an.markdown += d;
        if (!reportRenderTimer) reportRenderTimer = setTimeout(() => { reportRenderTimer = null; renderReport(); }, 150);
      },
    },
  );
  return finish;
}

/** Continue a report the model cut off (manual, after the automatic attempts). */
async function continueReview() {
  if (an.running || !an.cutOff || !an.request) return;
  an.running = true;
  const ctrl = new AbortController();
  an.abort = ctrl;
  $('an-stop').hidden = false;
  $('an-continue').hidden = true;
  const status = $('an-status');
  const t0 = performance.now();
  status.textContent = `${PROVIDERS[an.request.provider].label} is continuing…`;
  try {
    an.continued++;
    const finish = await streamReviewPart(an.request, ctrl.signal, an.markdown);
    an.cutOff = finish === 'length';
    an.meta.durationMs += performance.now() - t0;
    status.textContent = an.cutOff ? 'Still cut off at the length limit — press Continue again.' : `Done (in ${an.continued + 1} parts).`;
  } catch (err) {
    if (err?.name === 'AbortError') status.textContent = 'Stopped.';
    else {
      status.textContent = '';
      toast(err?.message || String(err), 'error');
    }
  } finally {
    an.running = false;
    an.abort = null;
    $('an-stop').hidden = true;
    renderAiSettings();
    renderReport();
  }
}
$('an-continue').addEventListener('click', continueReview);

/** Write a review in the chosen format (md / docx / pdf) to the save folder or the downloads. */
async function downloadReview(rev, fmt = settings.reviewFormat || 'md') {
  try {
    const jsPDF = fmt === 'pdf' ? await loadJsPdf() : undefined;
    const { name, data, mime } = reviewFile(rev, fmt, { jsPDF });
    log.info('ai', `review ${rev.id || '(current)'} → ${name}`);
    return deliver(name, data, mime, 'reviews');
  } catch (err) {
    toast(`Could not write the ${REVIEW_FORMATS[fmt]?.label || fmt}: ${err?.message || err}`, 'error');
    log.warn('ai', `review export failed: ${err?.message || err}`);
    return null;
  }
}
const formatOptions = (sel) => Object.entries(REVIEW_FORMATS).map(([k, f]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${f.ext === 'md' ? '.md' : `.${f.ext}`}</option>`).join('');

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
$('an-download').addEventListener('click', () => downloadReview({ ...an.meta, markdown: an.markdown, digests: an.digests }, $('an-format').value));
$('an-format').innerHTML = formatOptions(settings.reviewFormat || 'md');
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
    .map((r) => `<tr data-id="${esc(r.id)}"><td>${esc(fmtDate(r.createdAt))}</td><td>${esc(r.title)}</td><td>${r.shotIds?.length || 0}</td><td>${esc(PROVIDERS[r.provider]?.label || r.provider || '')} <small>${esc(r.model || '')}</small></td><td class="actions"><button class="btn small" data-act="open">Open</button><select class="fmt" aria-label="File format">${formatOptions(settings.reviewFormat || 'md')}</select><button class="btn small" data-act="download">Download</button><button class="btn small danger" data-act="delete">Delete</button></td></tr>`)
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
    an.confirmed = new Set(an.ids); // they were confirmed when this review was made
    an.pending = new Map();
    an.markdown = rev.markdown;
    an.failed = false;
    an.request = null;
    an.cutOff = false;
    an.continued = 0;
    an.meta = { createdAt: rev.createdAt, provider: rev.provider, model: rev.model, title: rev.title, shotIds: rev.shotIds, shotLabels: rev.shotLabels, taste: rev.taste, question: rev.question, durationMs: rev.durationMs };
    an.savedId = rev.id;
    $('an-taste').value = rev.taste || '';
    $('an-question').value = rev.question || '';
    renderAnalysis();
    renderReport();
    $('an-report-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (btn.dataset.act === 'download') {
    downloadReview(rev, tr.querySelector('select.fmt')?.value || settings.reviewFormat || 'md');
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

window.__pb = { state, store, portal, recorder, timeChart, massChart, calChart, compareChart, compare, machinePanel, settings, log, files, heat, hist, an, runAutoBackup, stopEverything, openStopDialog, openShotDialog, openWeightDialog, openRatingDialog, openCompare, openAnalysis, runReview, refreshShotList, recoverUnfinishedShots, backfillMachineRecords, autosaveShotFiles, refreshProfileTargets, get meticulous() { return meticulous; } };

init().catch((err) => {
  console.error(err);
  // The usual cause after an update is a stale script in the browser cache
  // (an old main.js running against a new index.html, or the reverse).
  toast(`Start-up problem: ${err.message || err}. If you just updated, reload with Shift held (⌘⇧R) to clear cached scripts.`, 'error', 15000);
});
