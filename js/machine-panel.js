// machine-panel.js — the "Machine" view: what the Home Assistant add-on
// (nickwilsonr/meticulous-addon) exposes as sensors, shown in one page.
//
//   Machine status      live state, stage, shot timer, brewing flag, voltage
//   Temperatures        rolling chart of the socket "sensors" event
//   Profiles            /profile/list with images, targets and variables
//   Statistics          /history/stats by profile, mileage, last shot
//   Device info         /machine (firmware, serial, colour, image channel …)
//   Connectivity        /wifi/config status + health, socket round-trip
//   Settings            /settings, read-only

import uPlot from '../vendor/uPlot.esm.js';
import { COLORS } from './charts.js?v=0.15.0';
import { isEndStage } from './meticulous.js?v=0.15.0';

const $ = (id) => document.getElementById(id);
const font = '12px "Avenir Next", Avenir, system-ui, -apple-system, sans-serif';
const WINDOW_SEC = 300; // temperature history kept in memory

export class MachinePanel {
  constructor(root) {
    this.root = root;
    this.client = null;
    this.tempBuf = []; // [{t, ext1, ext2, barUp, barMid, barDown, tube, motor}]
    this.powerBuf = [];
    this.t0 = performance.now();
    this.lastStatus = null;
    this.lastSensorsAt = 0;
    this.lastStatusAt = 0;
    this.refreshTimer = null;
    this.chartDirty = false;
    this._buildCharts();
    setInterval(() => this._tick(), 500);
  }

  attach(client) {
    this.detach();
    this.client = client;
    this._onStatus = (e) => this._status(e.detail);
    this._onSensors = (e) => this._sensors(e.detail);
    this._onState = (e) => {
      if (e.detail.state === 'connected') this.refreshAll();
      this._renderConnectivity();
    };
    this._onNotification = (e) => this._note(e.detail);
    client.addEventListener('status', this._onStatus);
    client.addEventListener('sensors', this._onSensors);
    client.addEventListener('state', this._onState);
    client.addEventListener('notification', this._onNotification);
    if (client.connected) this.refreshAll();
    this.refreshTimer = setInterval(() => this.refreshSlow(), 5 * 60 * 1000);
  }

  detach() {
    if (!this.client) return;
    this.client.removeEventListener('status', this._onStatus);
    this.client.removeEventListener('sensors', this._onSensors);
    this.client.removeEventListener('state', this._onState);
    this.client.removeEventListener('notification', this._onNotification);
    this.client = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this._renderConnectivity();
  }

  // ------------------------------------------------------------ live data --

  _status(s) {
    this.lastStatus = s;
    this.lastStatusAt = performance.now();
    const brewing = s.extracting || (!!s.name && !isEndStage(s.name) && s.state && /brew|extract/i.test(s.state));
    set('ms-state', s.state || '–');
    set('ms-stage', s.name || '–');
    set('ms-brewing', brewing ? 'yes' : 'no');
    set('ms-timer', s.extracting && s.timeMs >= 0 ? (s.timeMs / 1000).toFixed(1) : '0.0');
    set('ms-profile', s.profile || s.loadedProfile || '–');
    set('ms-temp', fmt(s.temp, 1));
    set('ms-pressure', fmt(s.p, 1));
    set('ms-flow', fmt(s.f, 2));
    set('ms-weight', fmt(s.w, 1));
    const sp = s.setpoints;
    set('ms-setpoint', sp?.active ? `${sp.active} ${fmt(sp[sp.active], 1)}` : '–');
  }

  _sensors(d) {
    this.lastSensorsAt = performance.now();
    const t = (performance.now() - this.t0) / 1000;
    this.tempBuf.push({ t, ext1: n(d.t_ext_1), ext2: n(d.t_ext_2), barUp: n(d.t_bar_up), barMid: avg(n(d.t_bar_mu), n(d.t_bar_md)), barDown: n(d.t_bar_down), tube: n(d.t_tube), motor: n(d.motor_temp ?? d.t_motor_temp) });
    this.powerBuf.push({ t, heater: n(d.bh_pwr), motorPower: n(d.m_pwr), motorPos: n(d.m_pos) });
    const cutoff = t - WINDOW_SEC;
    while (this.tempBuf.length && this.tempBuf[0].t < cutoff) this.tempBuf.shift();
    while (this.powerBuf.length && this.powerBuf[0].t < cutoff) this.powerBuf.shift();
    this.chartDirty = true;
    set('ms-boiler', fmt(n(d.t_ext_1), 1));
    set('ms-head', fmt(n(d.t_ext_2), 1));
    set('ms-tube', fmt(n(d.t_tube), 1));
    set('ms-bar', fmt(avg(n(d.t_bar_up), n(d.t_bar_mu), n(d.t_bar_md), n(d.t_bar_down)), 1));
    set('ms-motor', fmt(n(d.motor_temp ?? d.t_motor_temp), 1));
    set('ms-heater', fmt(n(d.bh_pwr), 0));
    set('ms-water', d.w_stat === false ? 'low' : d.w_stat === true ? 'ok' : '–');
  }

  _note(nt) {
    const el = $('mc-notes');
    const li = document.createElement('li');
    li.textContent = `${new Date().toLocaleTimeString()} — ${typeof nt === 'string' ? nt : nt?.message || JSON.stringify(nt)}`;
    el.prepend(li);
    while (el.children.length > 8) el.lastChild.remove();
  }

  _tick() {
    if (this.chartDirty && this.root.offsetParent !== null) {
      this.chartDirty = false;
      const b = this.tempBuf;
      this.tempChart.setData([b.map((x) => x.t), b.map((x) => x.ext1), b.map((x) => x.ext2), b.map((x) => x.barUp), b.map((x) => x.barMid), b.map((x) => x.barDown), b.map((x) => x.tube), b.map((x) => x.motor)]);
      const p = this.powerBuf;
      this.powerChart.setData([p.map((x) => x.t), p.map((x) => x.heater), p.map((x) => x.motorPower), p.map((x) => x.motorPos)]);
    }
    const now = performance.now();
    const age = this.lastStatusAt ? (now - this.lastStatusAt) / 1000 : null;
    set('mc-status-age', age === null ? '–' : age < 2 ? 'live' : `${age.toFixed(0)} s ago`);
    const sage = this.lastSensorsAt ? (now - this.lastSensorsAt) / 1000 : null;
    set('mc-sensors-age', sage === null ? 'no sensors event yet' : sage < 2 ? 'live' : `${sage.toFixed(0)} s ago`);
  }

  // ---------------------------------------------------------------- REST --

  async refreshAll() {
    await Promise.allSettled([this.refreshSlow(), this.refreshProfiles(), this.refreshStats()]);
  }

  async refreshSlow() {
    if (!this.client) return;
    const [info, wifi, settings, notes] = await Promise.allSettled([this.client.machineInfo(), this.client.wifi(), this.client.settings(), this.client.notifications()]);
    if (info.status === 'fulfilled') this._renderDevice(info.value);
    else this._renderDeviceError(info.reason);
    this.wifi = wifi.status === 'fulfilled' ? wifi.value : null;
    this._renderConnectivity();
    if (settings.status === 'fulfilled') this._renderSettings(settings.value);
    if (notes.status === 'fulfilled' && Array.isArray(notes.value)) for (const x of notes.value.slice(0, 5)) this._note(x);
  }

  async refreshProfiles() {
    if (!this.client) return;
    try {
      const list = await this.client.profiles();
      this._renderProfiles(Array.isArray(list) ? list : []);
    } catch (e) {
      $('mc-profiles').innerHTML = `<p class="hint">Could not load profiles: ${esc(e.message)}</p>`;
    }
  }

  async refreshStats() {
    if (!this.client) return;
    try {
      const [stats, last] = await Promise.all([this.client.stats(), this.client.lastShot().catch(() => null)]);
      this._renderStats(stats, last);
    } catch (e) {
      $('mc-stats').innerHTML = `<p class="hint">Could not load statistics: ${esc(e.message)}</p>`;
    }
  }

  // ------------------------------------------------------------- renders --

  _renderDevice(info) {
    this.info = info;
    const rows = [
      ['Name', info.name],
      ['Hostname', info.hostname],
      ['Serial', info.serial],
      ['Colour · batch', [info.color, info.batch_number].filter(Boolean).join(' · ')],
      ['Firmware (ESP)', info.firmware],
      ['Software', info.software_version],
      ['Image', [info.image_version, info.image_build_channel && `(${info.image_build_channel})`].filter(Boolean).join(' ')],
      ['Build date', info.build_date ? new Date(info.build_date).toLocaleDateString() : null],
      ['Mains voltage', Number.isFinite(info.mainVoltage) ? `${info.mainVoltage} V` : null],
      ['Disturbance resilience', info.disturbance_resilience_supported ? (info.disturbance_resilience ? 'on' : 'off') : 'not supported'],
      ['Tare behaviour setting', info.tare_behavior_supported ? 'supported' : 'not supported'],
      ['Pour-over profiles', info.pour_over_profiles_supported ? `yes (schema ${info.pour_over_profile_schema_version})` : 'no'],
    ];
    const repo = info.repository_info || {};
    const repoRows = ['backend', 'firmware', 'dial', 'web-app', 'plotter-ui', 'meticulous-machine'].filter((k) => repo[k]?.commit).map((k) => [k, `${repo[k].branch} · ${String(repo[k].commit).split(' - ')[0]}`]);
    $('mc-device').innerHTML = kv(rows) + (repoRows.length ? `<h3>Component versions</h3>${kv(repoRows)}` : '') + (Array.isArray(info.version_history) && info.version_history.length ? `<p class="hint">Recent images: ${esc(info.version_history.slice(-4).join(', '))}</p>` : '');
  }

  _renderDeviceError(err) {
    $('mc-device').innerHTML = `<p class="hint">Not reachable: ${esc(err?.message || err)}</p>`;
  }

  _renderConnectivity() {
    const c = this.client;
    const w = this.wifi;
    const rows = [
      ['Socket', c ? (c.connected ? 'connected' : 'reconnecting') : 'not connected'],
      ['Address', c ? c.baseUrl : '–'],
      ['Status stream', `<span id="mc-status-age">–</span>`],
      ['Sensors stream', `<span id="mc-sensors-age">–</span>`],
    ];
    if (w) {
      const st = w.status || {};
      const h = w.health || {};
      rows.push(
        ['Wi-Fi', st.connected ? `${st.connection_name || 'connected'}` : 'not connected'],
        ['Mode', w.config?.mode],
        ['IP', (st.ips || []).filter((ip) => ip.includes('.')).join(', ')],
        ['Gateway', st.gateway],
        ['DNS', (st.dns || []).join(', ')],
        ['MAC', st.mac],
        ['Link / IPv4', `${yn(h.link_connected)} / ${yn(h.has_ipv4)}`],
        ['Gateway reachable', yn(h.gateway_reachable)],
        ['DNS resolves', yn(h.dns_resolves)],
        ['Internet reachable', yn(h.internet_reachable)],
        ['Degraded', yn(h.degraded)],
      );
      if (h.message) rows.push(['Note', h.message]);
    }
    $('mc-conn').innerHTML = kv(rows, true);
  }

  _renderSettings(s) {
    const pick = ['update_channel', 'heat_on_boot', 'heating_timeout', 'auto_start_shot', 'auto_purge_after_shot', 'tare_behavior', 'disturbance_resilience', 'partial_retraction', 'enable_sounds', 'idle_screen', 'time_zone', 'clock_format_24_hour', 'shot_data_sharing', 'ssh_enabled', 'usb_mode', 'debug_shot_data_retention_days', 'allow_stage_skipping'];
    const rows = pick.filter((k) => k in s).map((k) => [k.replace(/_/g, ' '), typeof s[k] === 'boolean' ? yn(s[k]) : String(s[k])]);
    $('mc-settings').innerHTML = kv(rows);
  }

  _renderProfiles(list) {
    const el = $('mc-profiles');
    if (!list.length) {
      el.innerHTML = '<p class="hint">No profiles on the machine.</p>';
      return;
    }
    const active = this.lastStatus?.profile || this.lastStatus?.loadedProfile;
    el.innerHTML = list
      .map((p) => {
        const img = this.client?.imageUrl(p.display?.image);
        const vars = (p.variables || []).map((v) => `<span class="var">${esc(v.name)} <b>${esc(String(v.value))}</b></span>`).join('');
        const isActive = active && p.name === active;
        return `<article class="profile${isActive ? ' active' : ''}" style="--accent:${esc(p.display?.accentColor || '#2447B8')}">
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy" />` : '<div class="noimg"></div>'}
          <div class="profile-body">
            <h4>${esc(p.name)}${isActive ? ' <small>loaded</small>' : ''}</h4>
            <p class="targets">${fmt(p.temperature, 0)} °C · ${fmt(p.final_weight, 0)} g out${p.author ? ' · ' + esc(p.author) : ''}</p>
            ${p.display?.shortDescription ? `<p class="desc">${esc(p.display.shortDescription)}</p>` : ''}
            ${p.display?.description ? `<p class="desc small">${esc(p.display.description)}</p>` : ''}
            <div class="vars">${vars}</div>
            <p class="hint">changed ${p.last_changed ? new Date(p.last_changed * 1000).toLocaleDateString() : '–'} · ${esc(String(p.id).slice(0, 8))}</p>
          </div>
        </article>`;
      })
      .join('');
  }

  _renderStats(stats, last) {
    const by = (stats?.byProfile || []).slice().sort((a, b) => b.count - a.count);
    const total = stats?.totalSavedShots ?? by.reduce((n, p) => n + p.count, 0);
    const max = Math.max(1, ...by.map((p) => p.count));
    const bars = by
      .map((p) => `<div class="bar-row"><span class="bar-label">${esc(p.name || 'unnamed')}</span><span class="bar"><i style="width:${(100 * p.count) / max}%"></i></span><span class="bar-n">${p.count}${p.profileVersions > 1 ? ` <small>· ${p.profileVersions} versions</small>` : ''}</span></div>`)
      .join('');
    let lastHtml = '';
    if (last) {
      const data = last.data || [];
      const maxW = Math.max(0, ...data.map((d) => d.shot?.weight ?? 0));
      const dur = data.length ? data[data.length - 1].time / 1000 : 0;
      lastHtml = `<h3>Last saved shot</h3>${kv([
        ['When', last.time ? new Date(last.time * 1000).toLocaleString() : '–'],
        ['Profile', last.name || last.profile_name],
        ['Weight', `${maxW.toFixed(1)} g`],
        ['Recorded', `${dur.toFixed(1)} s · ${data.length} samples`],
        ['Stages', [...new Set(data.map((d) => d.status).filter(Boolean))].join(' → ')],
      ])}`;
    }
    $('mc-stats').innerHTML = `<div class="stat-tiles">
        <div class="metric"><div class="v">${total}</div><div class="k">saved shots</div></div>
        <div class="metric"><div class="v">${stats?.mileage ?? '–'}</div><div class="k">lifetime shots (ESP counter)</div></div>
        <div class="metric"><div class="v">${by.length}</div><div class="k">profiles with history</div></div>
      </div>
      <h3>Shots by profile</h3><div class="bars">${bars || '<p class="hint">No shots saved yet.</p>'}</div>${lastHtml}`;
  }

  // -------------------------------------------------------------- charts --

  _buildCharts() {
    const el = $('chart-temps');
    const w = () => Math.max(320, el.clientWidth || 640);
    const ax = (scale, side, label, color, extra = {}) => ({ scale, side, label, labelFont: font, font, stroke: color, labelSize: 18, size: 44, gap: 4, grid: { stroke: COLORS.grid, width: 1 }, ticks: { stroke: COLORS.grid, width: 1, size: 4 }, ...extra });
    this.tempChart = new uPlot(
      {
        width: w(),
        height: 260,
        padding: [8, 8, 0, 0],
        cursor: { drag: { x: true, y: false } },
        legend: { live: true, font },
        scales: { x: { time: false }, y: { range: (u, mn, mx) => [Math.floor(((mn ?? 20) - 2) / 5) * 5, Math.ceil(((mx ?? 100) + 2) / 5) * 5] } },
        series: [
          { label: 'time', value: (u, v) => (v == null ? '–' : `${(v % 3600 / 60).toFixed(0).padStart(2, '0')}:${(v % 60).toFixed(0).padStart(2, '0')}`) },
          { label: 'External 1', stroke: COLORS.oxblood ?? '#8A1C2B', width: 1.75, value: fmtv(1, ' °C'), spanGaps: true, points: { show: false } },
          { label: 'External 2', stroke: '#C2552F', width: 1.5, value: fmtv(1, ' °C'), spanGaps: true, points: { show: false } },
          { label: 'Bar up', stroke: '#C98A14', width: 1.25, value: fmtv(1, ' °C'), spanGaps: true, points: { show: false } },
          { label: 'Bar mid', stroke: '#9C7A2E', width: 1.25, value: fmtv(1, ' °C'), spanGaps: true, show: false, points: { show: false } },
          { label: 'Bar down', stroke: '#6B5A1E', width: 1.25, value: fmtv(1, ' °C'), spanGaps: true, show: false, points: { show: false } },
          { label: 'Tube', stroke: COLORS.teal ?? '#0E7C7B', width: 1.25, value: fmtv(1, ' °C'), spanGaps: true, points: { show: false } },
          { label: 'Motor', stroke: COLORS.weight ?? '#5B6470', width: 1, dash: [4, 3], value: fmtv(1, ' °C'), spanGaps: true, points: { show: false } },
        ],
        axes: [ax('x', 2, 'seconds since the page opened', COLORS.axis, { incrs: [1, 2, 5, 10, 15, 30, 60, 120, 300], values: (u, vals) => vals.map((v) => v.toFixed(0)) }), ax('y', 3, '°C', COLORS.axis)],
      },
      [[], [], [], [], [], [], [], []],
      el,
    );
    const el2 = $('chart-power');
    this.powerChart = new uPlot(
      {
        width: w(),
        height: 160,
        padding: [8, 8, 0, 0],
        cursor: { drag: { x: true, y: false } },
        legend: { live: true, font },
        scales: { x: { time: false }, y: { range: [0, 100] }, pos: { range: (u, mn, mx) => [0, Math.max(10, Math.ceil(((mx ?? 10) + 1) / 10) * 10)] } },
        series: [
          { label: 'time', value: (u, v) => (v == null ? '–' : v.toFixed(0) + ' s') },
          { label: 'Heater power', scale: 'y', stroke: '#C98A14', fill: 'rgba(201,138,20,0.12)', width: 1.25, value: fmtv(0, ' %'), spanGaps: true, points: { show: false } },
          { label: 'Motor power', scale: 'y', stroke: COLORS.ec, width: 1.25, value: fmtv(0, ' %'), spanGaps: true, points: { show: false } },
          { label: 'Piston position', scale: 'pos', stroke: COLORS.weight ?? '#5B6470', width: 1, dash: [4, 3], value: fmtv(1, ''), spanGaps: true, points: { show: false } },
        ],
        axes: [ax('x', 2, '', COLORS.axis, { incrs: [1, 2, 5, 10, 15, 30, 60, 120, 300], values: (u, vals) => vals.map((v) => v.toFixed(0)) }), ax('y', 3, '%', COLORS.axis), ax('pos', 1, 'position', COLORS.weight ?? '#5B6470', { grid: { show: false } })],
      },
      [[], [], [], []],
      el2,
    );
    window.addEventListener('resize', () => {
      this.tempChart.setSize({ width: w(), height: 260 });
      this.powerChart.setSize({ width: w(), height: 160 });
    });
  }

  /** Charts drawn while hidden have zero width; call when the tab is shown. */
  onShown() {
    const el = $('chart-temps');
    const w = Math.max(320, el.clientWidth || 640);
    this.tempChart.setSize({ width: w, height: 260 });
    this.powerChart.setSize({ width: w, height: 160 });
    this.chartDirty = true;
  }
}

// ------------------------------------------------------------------ utils --

function set(id, v) {
  const el = $(id);
  if (el) el.textContent = v;
}
const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const fmtv = (d, unit) => (u, v) => (v == null ? '–' : v.toFixed(d) + unit);
const yn = (b) => (b === true ? 'yes' : b === false ? 'no' : '–');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function avg(...xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function kv(rows, html = false) {
  return `<dl class="kv">${rows
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${html ? v : esc(String(v))}</dd>`)
    .join('')}</dl>`;
}
