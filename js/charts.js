// charts.js — uPlot wrappers for the two views: everything-vs-time, and the
// hero EC-vs-cup-mass chart with its running integral.

import uPlot from '../vendor/uPlot.esm.js';

export const COLORS = {
  ec: '#2447B8',       // cobalt — the Portal trace is the point of this tool
  ecFill: 'rgba(36, 71, 184, 0.14)',
  pressure: '#8A1C2B', // oxblood
  flow: '#0E7C7B',     // teal
  weight: '#5B6470',   // graphite
  temp: '#C98A14',     // amber
  integral: '#7A8BC9',
  grid: '#D9E0E6',
  axis: '#5B6470',
  marker: '#1C2430',
};

const font = '12px "Avenir Next", Avenir, system-ui, -apple-system, sans-serif';

function axis(scale, side, label, color, extra = {}) {
  return {
    scale,
    side,
    label,
    labelFont: font,
    font,
    stroke: color ?? COLORS.axis,
    labelSize: 18,
    size: 44,
    gap: 4,
    grid: { stroke: COLORS.grid, width: 1 },
    ticks: { stroke: COLORS.grid, width: 1, size: 4 },
    ...extra,
  };
}

function baseOpts(title, width, height) {
  return {
    title,
    width,
    height,
    padding: [8, 8, 0, 0],
    cursor: { drag: { x: true, y: false }, points: { size: 6 } },
    legend: { live: true, font },
    focus: { alpha: 0.4 },
  };
}

export class TimeChart {
  constructor(el) {
    this.el = el;
    this.stages = []; // [{t, label}]
    const self = this;
    const { width, height } = size(el, 320);
    const opts = {
      ...baseOpts('', width, height),
      hooks: {
        draw: [
          (u) => {
            if (!self.stages.length) return;
            const ctx = u.ctx;
            ctx.save();
            ctx.font = `${11 * devicePixelRatio}px "Avenir Next", Avenir, system-ui, sans-serif`;
            ctx.fillStyle = COLORS.axis;
            ctx.strokeStyle = COLORS.grid;
            ctx.setLineDash([2 * devicePixelRatio, 3 * devicePixelRatio]);
            ctx.lineWidth = 1 * devicePixelRatio;
            for (const st of self.stages) {
              const x = u.valToPos(st.t, 'x', true);
              if (!Number.isFinite(x) || x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
              ctx.beginPath();
              ctx.moveTo(x, u.bbox.top);
              ctx.lineTo(x, u.bbox.top + u.bbox.height);
              ctx.stroke();
              ctx.fillText(st.label, x + 4 * devicePixelRatio, u.bbox.top + u.bbox.height - 6 * devicePixelRatio);
            }
            ctx.restore();
          },
        ],
      },
      scales: {
        x: { time: false },
        y: { range: (u, min, max) => [0, Math.max(12, Math.ceil((max ?? 10) + 0.5))] },
        g: { range: (u, min, max) => [0, Math.max(10, Math.ceil(((max ?? 0) + 2) / 5) * 5)] },
        ec: { range: (u, min, max) => [0, Math.max(1, roundUp((max ?? 1) * 1.1))] },
      },
      series: [
        { label: 'time', value: (u, v) => (v == null ? '–' : v.toFixed(1) + ' s') },
        { label: 'Pressure', scale: 'y', stroke: COLORS.pressure, width: 1.5, value: fmt(1, ' bar'), spanGaps: true },
        { label: 'Flow', scale: 'y', stroke: COLORS.flow, width: 1.5, value: fmt(2, ' ml/s'), spanGaps: true },
        { label: 'Weight', scale: 'g', stroke: COLORS.weight, width: 1.25, dash: [4, 3], value: fmt(1, ' g'), spanGaps: true },
        { label: 'Portal EC', scale: 'ec', stroke: COLORS.ec, width: 2.25, value: fmt(3, ' mS/cm'), spanGaps: true },
        { label: 'Outlet temp', scale: 'g', stroke: COLORS.temp, width: 1, value: fmt(1, ' °C'), spanGaps: true, show: false },
      ],
      axes: [
        axis('x', 2, 'seconds', COLORS.axis, { values: (u, vals) => vals.map((v) => v.toFixed(0)) }),
        axis('y', 3, 'bar · ml/s', COLORS.axis),
        axis('g', 1, 'g · °C', COLORS.weight, { grid: { show: false } }),
        axis('ec', 1, 'EC (mS/cm)', COLORS.ec, { grid: { show: false }, size: 56 }),
      ],
    };
    this.u = new uPlot(opts, [[], [], [], [], [], []], el);
    this._resize = () => {
      const s = size(el, 320);
      this.u.setSize(s);
    };
    window.addEventListener('resize', this._resize);
  }

  /** machine: [{t,p,f,w,temp,status}], portal: [{t,ec,tOut}] */
  setShot(machine, portal) {
    const m = machine.filter((s) => Number.isFinite(s.t));
    const p = portal.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.ec));
    // Stage boundaries from the machine's own status names.
    this.stages = [];
    let prev = null;
    for (const s of m) {
      const name = (s.status || '').trim();
      if (name && name !== prev && !/^(idle|click to start|starting)/i.test(name)) this.stages.push({ t: s.t, label: name });
      prev = name;
    }
    if (this.stages.length > 12) this.stages = [];
    const tables = [];
    if (m.length) tables.push([m.map((s) => s.t), m.map((s) => nn(s.p)), m.map((s) => nn(s.f)), m.map((s) => nn(s.w))]);
    else tables.push([[], [], [], []]);
    if (p.length) tables.push([p.map((s) => s.t), p.map((s) => s.ec), p.map((s) => nn(s.tOut))]);
    else tables.push([[], [], []]);
    const joined = uPlot.join(tables);
    this.u.setData(joined.length ? joined : [[], [], [], [], [], []]);
  }

  destroy() {
    window.removeEventListener('resize', this._resize);
    this.u.destroy();
  }
}

export class MassChart {
  constructor(el) {
    this.el = el;
    this.markers = [];
    const { width, height } = size(el, 300);
    const self = this;
    const opts = {
      ...baseOpts('', width, height),
      scales: {
        x: { time: false, range: (u, min, max) => [0, Math.max(10, roundUp(max ?? 10))] },
        ec: { range: (u, min, max) => [0, Math.max(1, roundUp((max ?? 1) * 1.1))] },
        pct: { range: [0, 100] },
      },
      series: [
        { label: 'cup mass', value: (u, v) => (v == null ? '–' : v.toFixed(1) + ' g') },
        { label: 'Portal EC', scale: 'ec', stroke: COLORS.ec, fill: COLORS.ecFill, width: 2.25, value: fmt(3, ' mS/cm'), spanGaps: false },
        { label: 'Share of ∫EC dm', scale: 'pct', stroke: COLORS.integral, width: 1.25, dash: [6, 4], value: fmt(0, ' %'), spanGaps: true },
      ],
      axes: [
        axis('x', 2, 'cumulative cup mass (g)'),
        axis('ec', 3, 'EC (mS/cm)', COLORS.ec),
        axis('pct', 1, 'share of total (%)', COLORS.integral, { grid: { show: false } }),
      ],
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            ctx.save();
            ctx.font = `${11 * devicePixelRatio}px "Avenir Next", Avenir, system-ui, sans-serif`;
            ctx.fillStyle = COLORS.marker;
            ctx.strokeStyle = COLORS.marker;
            ctx.setLineDash([3 * devicePixelRatio, 3 * devicePixelRatio]);
            ctx.lineWidth = 1;
            for (const mk of self.markers) {
              const x = u.valToPos(mk.m, 'x', true);
              if (!Number.isFinite(x)) continue;
              ctx.beginPath();
              ctx.moveTo(x, u.bbox.top);
              ctx.lineTo(x, u.bbox.top + u.bbox.height);
              ctx.stroke();
              ctx.fillText(mk.label, x + 4 * devicePixelRatio, u.bbox.top + 12 * devicePixelRatio);
            }
            ctx.restore();
          },
        ],
      },
    };
    this.u = new uPlot(opts, [[], [], []], el);
    this._resize = () => this.u.setSize(size(el, 300));
    window.addEventListener('resize', this._resize);
  }

  /** curve: [{m, ec, I}] from analyzeShot(); total: integral total */
  setAnalysis(analysis) {
    if (!analysis || !analysis.curve?.length) {
      this.markers = [];
      this.u.setData([[], [], []]);
      return;
    }
    const c = analysis.curve;
    const total = analysis.integralEcG || 1;
    // Markers first: setData schedules its own commit, and a redraw() issued
    // right after it would re-queue the previous x range over the new one.
    this.markers = [];
    if (analysis.massAt90PctG > 0) this.markers.push({ m: analysis.massAt90PctG, label: '90% of ∫' });
    if (analysis.mainPeakMassG > 0) this.markers.push({ m: analysis.mainPeakMassG, label: 'peak' });
    this.u.setData([c.map((k) => k.m), c.map((k) => k.ec), c.map((k) => (100 * k.I) / total)]);
  }

  destroy() {
    window.removeEventListener('resize', this._resize);
    this.u.destroy();
  }
}

export class CalibrationChart {
  constructor(el) {
    this.el = el;
    const { width, height } = size(el, 220);
    const opts = {
      ...baseOpts('', width, height),
      scales: { x: { time: false, range: (u, min, max) => [0, roundUp((max ?? 1) * 1.15)] }, y: { range: (u, min, max) => [0, roundUp((max ?? 1) * 1.15)] } },
      series: [
        { label: 'mean EC/g', value: fmt(3, '') },
        { label: 'Refractometer TDS', scale: 'y', stroke: COLORS.ec, width: 0, points: { show: true, size: 8, fill: COLORS.ec }, value: fmt(2, ' %') },
        { label: 'Fit', scale: 'y', stroke: COLORS.integral, width: 1.5, dash: [5, 4], value: fmt(2, ' %'), points: { show: false } },
      ],
      axes: [axis('x', 2, 'mean EC per g (mS/cm)'), axis('y', 3, 'TDS (%)', COLORS.ec)],
    };
    this.u = new uPlot(opts, [[], [], []], el);
    this._resize = () => this.u.setSize(size(el, 220));
    window.addEventListener('resize', this._resize);
  }

  setFit(points, fit, predict) {
    const pts = points.slice().sort((a, b) => a.meanEcPerG - b.meanEcPerG);
    const xs = pts.map((p) => p.meanEcPerG);
    const ys = pts.map((p) => p.tdsPct);
    let line = [[], []];
    if (fit?.calibrated) {
      const hi = Math.max(...xs, 0.1) * 1.15;
      const n = 20;
      line = [Array.from({ length: n }, (_, i) => (hi * i) / (n - 1)), []];
      line[1] = line[0].map((x) => predict(fit, x));
    }
    const joined = uPlot.join([
      [xs, ys],
      [line[0], line[1]],
    ]);
    this.u.setData(joined.length ? joined : [[], [], []]);
  }

  destroy() {
    window.removeEventListener('resize', this._resize);
    this.u.destroy();
  }
}

function size(el, h) {
  return { width: Math.max(320, el.clientWidth || 640), height: h };
}
const nn = (x) => (Number.isFinite(x) ? x : null);
const fmt = (d, unit) => (u, v) => (v == null ? '–' : v.toFixed(d) + unit);
function roundUp(x) {
  if (!Number.isFinite(x) || x <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  return Math.ceil(x / p) * p;
}
