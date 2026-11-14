// export.js — files out: chart images (JPEG), a one-page PDF report per shot,
// a summary CSV across shots, and a zip of everything. Pure browser; jsPDF is
// loaded lazily from vendor/ only when a PDF is asked for.

import { zipSync, strToU8 } from '../vendor/fflate.esm.js';
import { beverageOf, beverageSource, profileTargetOf, measuredEy } from './analysis.js?v=0.20.0';
import { pdfWriter } from './review-export.js?v=0.20.0';
import { ratingOf, ratingMaxOf } from './review.js?v=0.20.0';

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
    if (y + h > pageH - 32) { // the footer sits at pageH - 20
      doc.addPage();
      y = margin;
    }
  };

  const maxImgH = (pageH - margin * 2) * 0.24; // two charts, the tables and the notes fit one page for a normal shot
  for (const img of r.images || []) {
    let w = contentW;
    let h = (img.height / img.width) * w;
    if (h > maxImgH) {
      h = maxImgH;
      w = (img.width / img.height) * h;
    }
    ensure(h + 16);
    doc.addImage(img.dataUrl, 'JPEG', margin, y, w, h, undefined, 'FAST');
    y += h + 2;
    if (img.caption) {
      doc.setFontSize(9);
      doc.setTextColor(90);
      doc.text(pdfSafe(img.caption), margin, y + 8);
      doc.setTextColor(0);
      y += 12;
    }
    y += 6;
  }

  // Two columns of key/value pairs. Keys and values are wrapped to their own
  // cell widths (a long value used to run across into the right-hand column),
  // and a row is as tall as its tallest cell.
  const LINE = 12;
  const table = (title, rows) => {
    if (!rows?.length) return;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    const half = Math.ceil(rows.length / 2);
    const colW = contentW / 2;
    const gap = 12;
    const keyW = colW * 0.46 - gap;
    const valX = colW * 0.46;
    const valW = colW * 0.54 - gap;
    const cells = rows.map(([k, v]) => ({ k: doc.splitTextToSize(pdfSafe(String(k ?? '')), keyW), v: doc.splitTextToSize(pdfSafe(String(v ?? '')), valW) }));
    const rowH = (r) => {
      const a = cells[r];
      const b = cells[r + half];
      return LINE * Math.max(a.k.length, a.v.length, b?.k.length || 0, b?.v.length || 0) + 1;
    };
    ensure(16 + rowH(0) + (half > 1 ? rowH(1) : 0)); // keep the title with its first rows
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(pdfSafe(title), margin, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    for (let r = 0; r < half; r++) {
      const h = rowH(r);
      ensure(h);
      for (const col of [0, 1]) {
        const cell = cells[r + col * half];
        if (!cell) continue;
        const x = margin + col * colW;
        doc.setTextColor(90);
        cell.k.forEach((line, i) => doc.text(line, x, y + i * LINE));
        doc.setTextColor(0);
        cell.v.forEach((line, i) => doc.text(line, x + valX, y + i * LINE));
      }
      y += h;
    }
    y += 8;
  };
  table('Shot', r.metrics);
  table('Strength estimate', r.estimate);
  if (r.notes?.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    const first = doc.splitTextToSize('- ' + pdfSafe(r.notes[0]), contentW);
    ensure(14 + first.length * 12 + 2); // the heading stays with its first note
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
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
  // A saved AI review of this shot, when one exists: on its own page(s), laid out like the review PDF.
  if (r.review?.markdown) {
    doc.addPage();
    const writer = pdfWriter(doc, { margin, bottom: pageH - 32, y: margin });
    writer.review(r.review, { heading: r.reviewHeading || 'AI review of this shot' });
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

/**
 * One CSV field. Quotes delimiters and newlines, and neutralizes text that a
 * spreadsheet would run as a formula (CWE-1236): a string starting with = + - @
 * or a tab/CR gets a leading apostrophe, which Excel, Numbers and LibreOffice
 * read as "this is text" — so a note like "=HYPERLINK(...)" or "@SUM" from a
 * profile name, a coffee field or an imported shot stays inert. Numbers, and
 * strings that are plain numbers ("-1.5"), are left alone.
 */
export function csvEscape(v) {
  if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s.trim())) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
  'refractometer_tds_pct', 'refractometer_ey_pct', 'estimated_tds_pct', 'estimated_ey_pct', 'estimate_model', 'estimate_pool', 'estimate_flags', 'note', 'rating', 'rating_max', 'comment',
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
    shot.refractometer?.tdsPct ?? '', round(measuredEy(shot), 2), round(e.tdsPct, 2), round(e.eyPct, 2), e.model ?? '', e.pool ?? '', (e.flags || []).join(' | '), c.note ?? '', ratingOf(shot) ?? '', ratingOf(shot) ? ratingMaxOf(shot) : '', shot.comment ?? '',
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

// ---------------------------------------------------------- heating graph --
// The Machine tab's "Temperatures and power" graphs, saved with the brew they
// belong to (Settings → Heating → Save the heating graph and its data).

const HEAT_FONT = '"Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * Several uPlot charts stacked into one JPEG under a title and a few lines of
 * text (the brew information), each chart with its caption and legend.
 * @param {Array<{u: uPlot, caption: string}>} charts
 * @param {object} o { title, lines: string[], scale }
 */
export async function heatingJpeg(charts, o = {}) {
  const dpr = o.scale ?? 2;
  const pad = 16;
  const lines = (o.lines || []).filter(Boolean);
  const cssW = Math.max(...charts.map((c) => c.u.width));
  const legends = charts.map((c) => legendOf(c.u));
  const legendH = (lg) => (lg.length ? Math.ceil(lg.length / 4) * 18 + 8 : 0);
  const W = cssW + pad * 2;
  const H = pad * 2 + (o.title ? 26 : 0) + lines.length * 17 + (lines.length ? 6 : 0) + charts.reduce((h, c, i) => h + 20 + c.u.height + 8 + legendH(legends[i]) + 6, 0);
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  let y = pad;
  if (o.title) {
    ctx.fillStyle = '#1c2430';
    ctx.font = `600 16px ${HEAT_FONT}`;
    ctx.fillText(o.title, pad, y);
    y += 26;
  }
  ctx.font = `12px ${HEAT_FONT}`;
  ctx.fillStyle = '#5b6470';
  for (const line of lines) {
    ctx.fillText(fitText(ctx, line, cssW), pad, y);
    y += 17;
  }
  if (lines.length) y += 6;
  charts.forEach((c, i) => {
    ctx.font = `600 12px ${HEAT_FONT}`;
    ctx.fillStyle = '#1c2430';
    ctx.fillText(c.caption || '', pad, y);
    y += 20;
    const src = c.u.ctx.canvas;
    ctx.drawImage(src, 0, 0, src.width, src.height, pad, y, c.u.width, c.u.height);
    y += c.u.height + 8;
    ctx.font = `12px ${HEAT_FONT}`;
    const colW = cssW / 4;
    legends[i].forEach((it, k) => {
      const x = pad + (k % 4) * colW;
      const yy = y + Math.floor(k / 4) * 18;
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
    y += legendH(legends[i]) + 6;
  });
  ctx.font = `10px ${HEAT_FONT}`;
  ctx.fillStyle = '#7a8491';
  ctx.textAlign = 'right';
  ctx.fillText(APP, W - pad, H - pad + 4);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  return { blob, dataUrl: canvas.toDataURL('image/jpeg', 0.92), width: W, height: H };
}

/** `text` shortened with an ellipsis until it fits `width` on the canvas. */
function fitText(ctx, text, width) {
  let t = String(text);
  if (ctx.measureText(t).width <= width) return t;
  while (t.length > 4 && ctx.measureText(`${t}…`).width > width) t = t.slice(0, -4);
  return `${t}…`;
}

export const HEATING_COLUMNS = ['time_iso', 't_s', 'external_1_c', 'external_2_c', 'bar_up_c', 'bar_mid_c', 'bar_down_c', 'tube_c', 'motor_c', 'status_temp_c', 'target_c', 'ready', 'heater_power_pct', 'motor_power_pct', 'piston_position', 'state', 'stage', 'profile'];

/** The heating graph's samples as CSV: one row per reading, with the machine's state and the profile's target beside it. */
export function heatingCsv(rows) {
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : '');
  const out = [HEATING_COLUMNS];
  for (const x of rows || []) {
    out.push([Number.isFinite(x.wall) ? new Date(x.wall).toISOString() : '', Number.isFinite(x.t) ? Math.round(x.t * 10) / 10 : '', r1(x.ext1), r1(x.ext2), r1(x.barUp), r1(x.barMid), r1(x.barDown), r1(x.tube), r1(x.motor), r1(x.status), r1(x.target), x.ready === true ? 'yes' : x.ready === false ? 'no' : '', r1(x.heater), r1(x.motorPower), Number.isFinite(x.motorPos) ? Math.round(x.motorPos * 100) / 100 : '', x.state || '', x.stage || '', x.profile || '']);
  }
  return rowsToCsv(out);
}

/**
 * The heating graph as a one-page PDF: title, the brew information, the
 * picture from heatingJpeg(), then the readings and the stage changes.
 * @param {object} r { title, subtitle, image: {dataUrl,width,height}, info: [[k,v]], readings: [[k,v]], events: string[] }
 */
export async function heatingPdf(r) {
  const jsPDF = await loadJsPdf();
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentW = pageW - margin * 2;
  let y = margin;
  const ensure = (h) => {
    if (y + h > pageH - 32) {
      doc.addPage();
      y = margin;
    }
  };
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
  const table = (heading, rows) => {
    if (!rows?.length) return;
    ensure(30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(pdfSafe(heading), margin, y + 10);
    y += 18;
    doc.setFontSize(9.5);
    for (const [k, v] of rows) {
      const lines = doc.splitTextToSize(pdfSafe(v), contentW - 150);
      ensure(12 * lines.length + 2);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(90);
      doc.text(pdfSafe(k), margin, y + 9);
      doc.setTextColor(0);
      doc.text(lines, margin + 150, y + 9);
      y += 12 * lines.length + 2;
    }
    y += 6;
  };
  table('Brew', r.info);
  if (r.image?.dataUrl) {
    const scale = Math.min(contentW / r.image.width, 1);
    const w = r.image.width * scale;
    const h = r.image.height * scale;
    ensure(h + 8);
    doc.addImage(r.image.dataUrl, 'JPEG', margin, y, w, h);
    y += h + 10;
  }
  table('Readings when this was saved', r.readings);
  if (r.events?.length) table('Machine stages in the graph', r.events.map((e) => [e[0], e[1]]));
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(130);
    doc.text(pdfSafe(`${APP} · heating graph · page ${i} of ${pages}`), margin, pageH - 20);
  }
  return doc.output('blob');
}
