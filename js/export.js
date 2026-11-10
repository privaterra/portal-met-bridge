// export.js — files out: chart images (JPEG), a one-page PDF report per shot,
// a summary CSV across shots, and a zip of everything. Pure browser; jsPDF is
// loaded lazily from vendor/ only when a PDF is asked for.

import { zipSync, strToU8 } from '../vendor/fflate.esm.js';
import { beverageOf, beverageSource, profileTargetOf, measuredEy } from './analysis.js?v=0.12.0';

const APP = 'portal-met-bridge';

// ------------------------------------------------------------- chart image --

/**
 * Render a uPlot chart to a JPEG blob with a title line and a legend, because
 * uPlot keeps the legend in HTML and the canvas alone has no series names.
 * @param {uPlot} u
 * @param {object} o { title, subtitle, legend: [{label, color, dash}], scale }
 */
export async function chartToJpeg(u, o = {}) {
  const src = u.ctx.canvas;
  const dpr = o.scale ?? 2;
  const cssW = u.width;
  const cssH = u.height;
  const pad = 16;
  const titleH = o.title ? 26 : 0;
  const subH = o.subtitle ? 18 : 0;
  const legend = o.legend || [];
  const legendRows = legend.length ? Math.ceil(legend.length / 4) : 0;
  const legendH = legendRows * 18 + (legendRows ? 8 : 0);
  const W = cssW + pad * 2;
  const H = titleH + subH + cssH + legendH + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1c2430';
  ctx.textBaseline = 'top';
  let y = pad;
  if (o.title) {
    ctx.font = '600 16px "Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillText(o.title, pad, y);
    y += titleH;
  }
  if (o.subtitle) {
    ctx.font = '12px "Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.fillStyle = '#5b6470';
    ctx.fillText(o.subtitle, pad, y);
    y += subH;
    ctx.fillStyle = '#1c2430';
  }
  // The uPlot canvas is already at devicePixelRatio; draw it scaled to CSS size.
  ctx.drawImage(src, 0, 0, src.width, src.height, pad, y, cssW, cssH);
  y += cssH + 8;
  if (legend.length) {
    ctx.font = '12px "Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif';
    const colW = cssW / 4;
    legend.forEach((it, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const x = pad + col * colW;
      const yy = y + row * 18;
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(it.dash || []);
      ctx.beginPath();
      ctx.moveTo(x, yy + 8);
      ctx.lineTo(x + 18, yy + 8);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#1c2430';
      ctx.fillText(it.label, x + 24, yy + 1);
    });
  }
  ctx.font = '10px "Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.fillStyle = '#7a8491';
  ctx.textAlign = 'right';
  ctx.fillText(APP, W - pad, H - pad + 4);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  return { blob, dataUrl: canvas.toDataURL('image/jpeg', 0.92), width: W, height: H };
}

/** Legend entries for a uPlot instance's visible series. */
export function legendOf(u) {
  return u.series
    .slice(1)
    .filter((s) => s.show !== false)
    .map((s) => ({ label: s.label, color: typeof s.stroke === 'function' ? s.stroke(u) : s.stroke, dash: s.dash }));
}

// ------------------------------------------------------------------- PDF --

let jspdfLoading = null;
export function loadJsPdf() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (!jspdfLoading) {
    jspdfLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/jspdf.umd.min.js';
      s.onload = () => resolve(window.jspdf.jsPDF);
      s.onerror = () => reject(new Error('Could not load vendor/jspdf.umd.min.js'));
      document.head.appendChild(s);
    });
  }
  return jspdfLoading;
}

/**
 * One-page (or two) letter-size report for a shot.
 * @param {object} r { title, subtitle, images: [{dataUrl,width,height,caption}], metrics: [[k,v]], estimate: [[k,v]], notes: string[] }
 */
/** jsPDF's built-in fonts cover WinAnsi only; swap the few symbols we use. */
export function pdfSafe(text) {
  return String(text ?? '')
    .replace(/\u222b/g, 'integral ')
    .replace(/\u2192/g, '->')
    .replace(/\u00b7/g, '-')
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00d7/g, 'x')
    .replace(/\u2265/g, '>=')
    .replace(/\u00b5/g, 'u')
    .replace(/\u2248/g, '~');
}

export async function shotReportPdf(r) {
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentW = pageW - margin * 2;
  let y = margin;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(pdfSafe(r.title), margin, y);
  y += 18;
  if (r.subtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(90);
    const lines = doc.splitTextToSize(pdfSafe(r.subtitle), contentW);
    doc.text(lines, margin, y);
    y += 12 * lines.length + 6;
    doc.setTextColor(0);
  }

  const ensure = (h) => {
    if (y + h > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const maxImgH = (pageH - margin * 2) * 0.3;
  for (const img of r.images || []) {
    let w = contentW;
    let h = (img.height / img.width) * w;
    if (h > maxImgH) {
      h = maxImgH;
      w = (img.width / img.height) * h;
    }
    ensure(h + 16);
    doc.addImage(img.dataUrl, 'JPEG', margin, y, w, h, undefined, 'FAST');
    y += h + 4;
    if (img.caption) {
      doc.setFontSize(9);
      doc.setTextColor(90);
      doc.text(pdfSafe(img.caption), margin, y + 8);
      doc.setTextColor(0);
      y += 14;
    }
    y += 6;
  }

  const table = (title, rows) => {
    if (!rows?.length) return;
    ensure(20 + Math.ceil(rows.length / 2) * 13);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(pdfSafe(title), margin, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    const half = Math.ceil(rows.length / 2);
    const colW = contentW / 2;
    rows.forEach(([k, v], i) => {
      const col = i < half ? 0 : 1;
      const row = i < half ? i : i - half;
      const x = margin + col * colW;
      const yy = y + row * 13;
      doc.setTextColor(90);
      doc.text(pdfSafe(k), x, yy);
      doc.setTextColor(0);
      doc.text(pdfSafe(v), x + colW * 0.52, yy);
    });
    y += half * 13 + 8;
  };
  table('Shot', r.metrics);
  table('Strength estimate', r.estimate);
  if (r.notes?.length) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    ensure(30);
    doc.text('Notes', margin, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    for (const n of r.notes) {
      const lines = doc.splitTextToSize('- ' + pdfSafe(n), contentW);
      ensure(lines.length * 12);
      doc.text(lines, margin, y);
      y += lines.length * 12 + 2;
    }
  }
  const pages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(`${APP} · ${new Date().toLocaleString()} · page ${p}/${pages}`, margin, pageH - 20);
    doc.setTextColor(0);
  }
  return doc.output('blob');
}

// ------------------------------------------------------------------- CSV --

export function csvEscape(v) {
  if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows) {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}

/** Per-sample CSV for one shot (machine + Portal rows merged by time). */
export function shotSamplesCsv(shot) {
  const rows = [['t_s', 'source', 'stage', 'pressure_bar', 'flow_mls', 'weight_g', 'grav_flow_gs', 'machine_temp_c', 'setpoint', 'portal_ec_mscm', 'portal_out_temp_c', 'portal_int_temp_c', 'portal_status', 'ext1_c', 'ext2_c', 'bar_up_c', 'tube_c', 'motor_c']];
  for (const s of shot.machine || []) rows.push([s.t, 'machine', s.status ?? '', s.p, s.f, s.w, s.g, s.temp, s.setpoint, '', '', '', '', s.ext?.tExt1, s.ext?.tExt2, s.ext?.tBarUp, s.ext?.tTube, s.ext?.motorTemp]);
  for (const s of shot.portal || []) rows.push([s.t, 'portal', '', '', '', '', '', '', '', s.ec, s.tOut, s.tInt, s.status, '', '', '', '', '']);
  const head = rows.shift();
  rows.sort((a, b) => a[0] - b[0]);
  return rowsToCsv([head, ...rows]);
}

export const SUMMARY_COLUMNS = [
  'id', 'started_iso', 'source', 'profile', 'bean', 'roaster', 'roast_level', 'process', 'origin', 'dose_g', 'grind', 'grinder',
  'beverage_g', 'beverage_source', 'profile_target_g', 'machine_weight_g', 'ratio', 'extraction_s', 'machine_samples', 'portal_samples', 'analysis_status', 'mean_ec_per_g', 'integral_ec_g', 'peak_ec', 'peak_at_g',
  'last5g_mean_ec', 'last5g_slope', 'mass_at_90pct_g', 'coverage', 'first_drop_s', 'portal_mean_temp_c',
  'refractometer_tds_pct', 'refractometer_ey_pct', 'estimated_tds_pct', 'estimated_ey_pct', 'estimate_model', 'estimate_pool', 'estimate_flags', 'note',
];

/** One row per shot; `extra` is { analysis, estimate } computed by the caller. */
export function summaryRow(shot, analysis, estimate) {
  const c = shot.context || {};
  const a = analysis || {};
  const e = estimate || {};
  return [
    shot.id, new Date(shot.startedAt).toISOString(), shot.source, shot.profileName ?? '', c.beanName ?? '', c.roaster ?? '', c.roastLevel ?? '', c.process ?? '', c.origin ?? '', c.doseG || '', c.grindSize ?? '', c.grinderName ?? '',
    round(beverageOf(shot), 1), beverageSource(shot) ?? '', round(profileTargetOf(shot), 1), round(shot.finalWeightG, 1), Number(c.doseG) > 0 && beverageOf(shot) > 0 ? round(beverageOf(shot) / Number(c.doseG), 2) : '', round(shot.durationSec, 1), shot.machine?.length ?? 0, shot.portal?.length ?? 0, a.status ?? '', round(a.meanEcPerG, 4), round(a.integralEcG, 2), round(a.mainPeakEc, 4), round(a.mainPeakMassG, 1),
    round(a.tail?.last5g?.mean, 4), round(a.tail?.last5g?.slopePerG, 4), round(a.massAt90PctG, 1), round(a.coverageRatio, 3), round(a.firstDropTimeSec, 2), round(a.meanTempC, 1),
    shot.refractometer?.tdsPct ?? '', round(measuredEy(shot), 2), round(e.tdsPct, 2), round(e.eyPct, 2), e.model ?? '', e.pool ?? '', (e.flags || []).join(' | '), c.note ?? '',
  ];
}

// ------------------------------------------------------------------- ZIP --

/** files: { 'path/name.ext': Uint8Array | string | Blob } */
export async function buildZip(files) {
  const entries = {};
  for (const [name, v] of Object.entries(files)) {
    if (v instanceof Blob) entries[name] = new Uint8Array(await v.arrayBuffer());
    else if (typeof v === 'string') entries[name] = strToU8(v);
    else entries[name] = v;
  }
  const out = zipSync(entries, { level: 6 });
  return new Blob([out], { type: 'application/zip' });
}

// --------------------------------------------------------------- helpers --

export function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);
export const slug = (s) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shot';
const round = (x, d) => (Number.isFinite(x) ? Number(x.toFixed(d)) : '');
