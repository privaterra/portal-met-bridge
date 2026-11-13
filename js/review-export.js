// Saved AI reviews as files: Markdown (the model's own text with a header),
// Word (.docx built from scratch: a zip of the few XML parts Word needs) and
// PDF (jsPDF, with a small rich-text layout). All three are written from the
// same block structure that parseMarkdown() produces, so they agree.

import { parseMarkdown } from './review.js?v=0.19.1';
import { zipSync, strToU8 } from '../vendor/fflate.esm.js';

export const REVIEW_FORMATS = {
  md: { label: 'Markdown (.md)', ext: 'md', mime: 'text/markdown' },
  docx: { label: 'Word (.docx)', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pdf: { label: 'PDF (.pdf)', ext: 'pdf', mime: 'application/pdf' },
};

const PROVIDER_LABEL = { anthropic: 'Claude (Anthropic)', openai: 'OpenAI', google: 'Gemini (Google)' };
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slug = (s) => String(s || 'shot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "review-2026-11-10T16-55-02-supernova.docx" */
export function reviewFileName(rev, fmt = 'md') {
  const bean = rev.digests?.[rev.digests.length - 1]?.meta?.coffee?.bean || rev.shotLabels?.[0]?.split(' · ')[1] || 'shot';
  return `review-${stamp(rev.createdAt)}-${slug(bean)}.${REVIEW_FORMATS[fmt]?.ext || 'md'}`;
}

/** The header lines every format starts with. */
export function reviewHeader(rev) {
  return {
    title: rev.title || 'Shot review',
    meta: `${new Date(rev.createdAt).toLocaleString()} · ${PROVIDER_LABEL[rev.provider] || rev.provider || ''} · ${rev.model || ''}${rev.durationMs ? ` · ${(rev.durationMs / 1000).toFixed(0)} s` : ''}`,
    shots: rev.shotLabels || [],
    taste: rev.taste || '',
    question: rev.question || '',
    footer: 'Written by an AI model from the recorded samples; check numbers against the shot before acting on them.',
  };
}

// ------------------------------------------------------------- markdown --

export function reviewMarkdownFile(rev) {
  const h = reviewHeader(rev);
  const head = [`# ${h.title}`, '', h.meta, '', `Shots:\n${h.shots.map((l) => `- ${l}`).join('\n')}`, h.taste ? `\nTaste: ${h.taste}` : '', h.question ? `\nQuestion: ${h.question}` : '', '', '---', ''].join('\n');
  return `${head}${String(rev.markdown || '').trim()}\n\n*${h.footer}*\n`;
}

// ----------------------------------------------------------------- docx --

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function docxRuns(runs, extra = {}) {
  return runs
    .map((r) => {
      const props = [];
      if (r.bold || extra.bold) props.push('<w:b/>');
      if (r.italic || extra.italic) props.push('<w:i/>');
      if (r.code) props.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="19"/>');
      if (extra.color) props.push(`<w:color w:val="${extra.color}"/>`);
      if (extra.size) props.push(`<w:sz w:val="${extra.size}"/>`);
      const text = r.href ? `${r.text} (${r.href})` : r.text;
      return `<w:r>${props.length ? `<w:rPr>${props.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
    })
    .join('');
}

function docxPara(runs, { style, indentLeft, hanging, extra, spacingAfter } = {}) {
  const pPr = [];
  if (style) pPr.push(`<w:pStyle w:val="${style}"/>`);
  if (indentLeft) pPr.push(`<w:ind w:left="${indentLeft}"${hanging ? ` w:hanging="${hanging}"` : ''}/>`);
  if (spacingAfter != null) pPr.push(`<w:spacing w:after="${spacingAfter}"/>`);
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${docxRuns(runs, extra)}</w:p>`;
}

function docxBlocks(blocks, depth = 0) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        out.push(docxPara(b.inlines, { style: `Heading${Math.min(3, Math.max(1, b.level - 1))}` }));
        break;
      case 'paragraph':
        out.push(docxPara(b.inlines, { indentLeft: depth ? 720 * depth : 0 }));
        break;
      case 'code':
        for (const line of b.text.split('\n')) out.push(docxPara([{ text: line || ' ', code: true }], { style: 'Code', spacingAfter: 0 }));
        break;
      case 'quote':
        out.push(...docxBlocks(b.blocks, depth + 1).map((p) => p.replace('<w:p>', '<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>')));
        break;
      case 'hr':
        out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>');
        break;
      case 'list':
        b.items.forEach((it, n) => {
          const marker = b.ordered ? `${n + 1}.` : '•';
          out.push(docxPara([{ text: `${marker}\t` }, ...it.inlines], { indentLeft: 720 * (depth + 1), hanging: 360, spacingAfter: 60 }));
          if (it.blocks.length) out.push(...docxBlocks(it.blocks, depth + 1));
        });
        break;
      case 'table': {
        const cols = b.head.length;
        const total = 9360; // 6.5 in at 1440 twips per inch
        const weights = b.head.map((h, c) => Math.max(6, ...[h, ...b.rows.map((r) => r[c] || [])].map((cell) => cell.map((r) => r.text).join('').length)));
        const sum = weights.reduce((a, w) => a + Math.min(w, 60), 0);
        const widths = weights.map((w) => Math.max(900, Math.round((total * Math.min(w, 60)) / sum)));
        const cell = (runs, w, head) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' : ''}</w:tcPr>${docxPara(runs.length ? runs : [{ text: ' ' }], { spacingAfter: 40, extra: head ? { bold: true } : {} })}</w:tc>`;
        const row = (cells, head) => `<w:tr>${head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${widths.map((w, c) => cell(cells[c] || [], w, head)).join('')}</w:tr>`;
        out.push(
          `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((e) => `<w:${e} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`).join('')}</w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${row(b.head, true)}${b.rows.map((r) => row(r, false)).join('')}</w:tbl>`,
        );
        out.push('<w:p><w:pPr><w:spacing w:after="60"/></w:pPr></w:p>');
        void cols;
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-CA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1C2430"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="20"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="100"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="BBBBBB"/></w:pBdr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1C2430"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BBBBBB"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/><w:sz w:val="19"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="Footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240"/></w:pPr><w:rPr><w:i/><w:color w:val="6B7280"/><w:sz w:val="18"/></w:rPr></w:style>
</w:styles>`;

/** The review as a Word document (Uint8Array of the .docx zip). */
export function reviewToDocx(rev) {
  const h = reviewHeader(rev);
  const body = [
    docxPara([{ text: h.title }], { style: 'Title' }),
    docxPara([{ text: h.meta }], { style: 'Subtitle' }),
    docxPara([{ text: 'Shots', bold: true }], { spacingAfter: 40 }),
    ...h.shots.map((l) => docxPara([{ text: `•\t${l}` }], { indentLeft: 720, hanging: 360, spacingAfter: 40 })),
    ...(h.taste ? [docxPara([{ text: 'Taste: ', bold: true }, { text: h.taste }])] : []),
    ...(h.question ? [docxPara([{ text: 'Question: ', bold: true }, { text: h.question }])] : []),
    ...docxBlocks(parseMarkdown(rev.markdown)),
    docxPara([{ text: h.footer }], { style: 'Footer' }),
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>',
  ].join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`;
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'word/document.xml': document,
    'word/styles.xml': DOCX_STYLES,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(h.title)}</dc:title><dc:creator>portal-met-bridge</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date(rev.createdAt).toISOString()}</dcterms:created></cp:coreProperties>`,
  };
  const entries = {};
  for (const [name, text] of Object.entries(files)) entries[name] = strToU8(text);
  return zipSync(entries, { level: 6 });
}

// ------------------------------------------------------------------ pdf --

/**
 * The review as a PDF. `jsPDF` is the constructor from vendor/jspdf.umd.min.js
 * (loaded on demand by export.js). Letter, 1-inch margins, Helvetica; inline
 * bold/italic/code are kept, tables are drawn with wrapped cells, long reports
 * run over several pages with page numbers.
 */
/**
 * jsPDF's built-in Helvetica covers WinAnsi only; the symbols a review uses are
 * mapped to readable stand-ins rather than printed as stray glyphs.
 */
const PDF_CHARS = { '→': '->', '←': '<-', '↑': 'up', '↓': 'down', '∫': 'integral ', 'μ': 'u', 'µ': 'u', '≥': '>=', '≤': '<=', '≈': '~', '−': '-', '∞': 'inf', '✓': 'yes', '✗': 'no', '◎': '(target)', '⚖': '(weighed)', '′': "'", '″': '"', '\u2009': ' ', '\u202f': ' ', '\u00a0': ' ' };
export function pdfSafe(text) {
  return String(text ?? '')
    .replace(/[→←↑↓∫μµ≥≤≈−∞✓✗◎⚖′″\u2009\u202f\u00a0]/g, (c) => PDF_CHARS[c] ?? c) // jsPDF's Helvetica draws neither mu
    .replace(/[^\u0000-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/g, '?');
}

/**
 * A small rich-text layout engine on a jsPDF document: wrapped runs with their
 * own fonts, headings, lists, tables, quotes, code — everything parseMarkdown
 * produces. Shared by the review PDF and the shot report (which appends a
 * saved review). `y` is the writer's cursor; `bottom` the lowest baseline.
 */
export function pdfWriter(doc, { margin = 64, bottom = null, y = margin, footer = null } = {}) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW = pageW - margin * 2;
  const limit = bottom ?? pageH - margin;
  const BODY = 10.5;
  const LINE = 1.38;
  const w = { y };

  const font = (r = {}, size = BODY) => {
    doc.setFont(r.code ? 'courier' : 'helvetica', r.bold && r.italic ? 'bolditalic' : r.bold ? 'bold' : r.italic ? 'italic' : 'normal');
    doc.setFontSize(r.code ? size - 1 : size);
  };
  const ensure = (need) => {
    if (w.y + need > limit) {
      doc.addPage();
      w.y = margin;
      footer?.();
    }
  };
  /** Lay out inline runs word by word with their own fonts; returns the height used. */
  const richText = (runs, x, width, size = BODY, color = [28, 36, 48]) => {
    const lineH = size * LINE;
    const words = [];
    for (const r of runs) {
      const text = pdfSafe(r.href ? `${r.text} (${r.href})` : r.text);
      const parts = text.split(/(\s+)/);
      for (const p of parts) if (p) words.push({ text: p, style: r, space: /^\s+$/.test(p) });
    }
    const lines = [[]];
    let lw = 0;
    for (const word of words) {
      font(word.style, size);
      const ww = doc.getTextWidth(word.text);
      if (lw + ww > width && lines[lines.length - 1].length && !word.space) {
        lines.push([]);
        lw = 0;
      }
      if (word.space && lw === 0) continue; // no leading spaces on a wrapped line
      lines[lines.length - 1].push({ ...word, w: ww });
      lw += ww;
    }
    doc.setTextColor(...color);
    for (const line of lines) {
      ensure(lineH);
      let cx = x;
      for (const word of line) {
        font(word.style, size);
        doc.text(word.text, cx, w.y + size);
        cx += word.w;
      }
      w.y += lineH;
    }
    return lines.length * lineH;
  };
  const plain = (text, x, width, size = BODY, style = {}, color) => richText([{ text, ...style }], x, width, size, color);
  const gap = (pt) => {
    w.y += pt;
  };

  const blocks = (list, indent = 0) => {
    for (const b of list) {
      switch (b.type) {
        case 'heading': {
          const size = b.level <= 2 ? 14 : b.level === 3 ? 12 : 11;
          gap(b.level <= 2 ? 14 : 8);
          ensure(size * 3);
          richText(b.inlines.map((r) => ({ ...r, bold: true })), margin + indent, maxW - indent, size);
          if (b.level <= 2) {
            doc.setDrawColor(187);
            doc.line(margin, w.y - 2, pageW - margin, w.y - 2);
          }
          gap(4);
          break;
        }
        case 'paragraph':
          richText(b.inlines, margin + indent, maxW - indent);
          gap(5);
          break;
        case 'code':
          for (const line of b.text.split('\n')) plain(line || ' ', margin + indent, maxW - indent, BODY, { code: true });
          gap(5);
          break;
        case 'quote':
          doc.setDrawColor(187);
          {
            const y0 = w.y;
            blocks(b.blocks, indent + 14);
            doc.line(margin + indent + 4, y0 + 2, margin + indent + 4, w.y - 4);
          }
          break;
        case 'hr':
          gap(4);
          doc.setDrawColor(187);
          doc.line(margin, w.y, pageW - margin, w.y);
          gap(8);
          break;
        case 'list':
          b.items.forEach((it, n) => {
            const marker = b.ordered ? `${n + 1}.` : '•';
            ensure(BODY * LINE);
            const yStart = w.y;
            richText(it.inlines, margin + indent + 18, maxW - indent - 18);
            font({}, BODY);
            doc.setTextColor(28, 36, 48);
            doc.text(marker, margin + indent + (b.ordered ? 2 : 6), yStart + BODY);
            gap(2);
            if (it.blocks.length) blocks(it.blocks, indent + 18);
          });
          gap(4);
          break;
        case 'table': {
          const cols = b.head.length;
          const text = (runs) => pdfSafe(runs.map((r) => r.text).join(''));
          const weights = b.head.map((hd, c) => Math.max(5, ...[hd, ...b.rows.map((r) => r[c] || [])].map((cell) => Math.min(60, text(cell).length))));
          const sum = weights.reduce((a, x) => a + x, 0);
          const widths = weights.map((x) => Math.max(48, ((maxW - indent) * x) / sum));
          const scale = (maxW - indent) / widths.reduce((a, x) => a + x, 0);
          for (let c = 0; c < cols; c++) widths[c] *= scale;
          const pad = 4;
          const size = 9.5;
          const lineH = size * 1.3;
          const drawRow = (cells, head) => {
            font({ bold: head }, size);
            const wrapped = widths.map((cw, c) => doc.splitTextToSize(text(cells[c] || []), cw - pad * 2));
            const rowH = Math.max(...wrapped.map((ls) => ls.length)) * lineH + pad * 2;
            ensure(rowH);
            let x = margin + indent;
            doc.setDrawColor(187);
            for (let c = 0; c < cols; c++) {
              if (head) {
                doc.setFillColor(238, 238, 238);
                doc.rect(x, w.y, widths[c], rowH, 'FD');
              } else doc.rect(x, w.y, widths[c], rowH);
              doc.setTextColor(28, 36, 48);
              wrapped[c].forEach((ln, i) => doc.text(ln, x + pad, w.y + pad + size + i * lineH - 1));
              x += widths[c];
            }
            w.y += rowH;
          };
          gap(2);
          drawRow(b.head, true);
          for (const r of b.rows) drawRow(r, false);
          gap(8);
          break;
        }
        default:
          break;
      }
    }
  };

  return {
    get y() {
      return w.y;
    },
    set y(v) {
      w.y = v;
    },
    margin,
    maxW,
    pageW,
    pageH,
    BODY,
    font,
    ensure,
    richText,
    plain,
    gap,
    blocks,
    /** The review's header lines and body, from the cursor on. */
    review(rev, { heading = null } = {}) {
      const h = reviewHeader(rev);
      if (heading) {
        plain(heading, margin, maxW, 14, { bold: true });
        gap(2);
      }
      plain(h.title, margin, maxW, heading ? 12 : 18, { bold: true });
      gap(2);
      plain(h.meta, margin, maxW, 9.5, {}, [107, 114, 128]);
      gap(6);
      plain('Shots', margin, maxW, BODY, { bold: true });
      for (const l of h.shots) plain(`•  ${l}`, margin + 6, maxW - 6, BODY);
      if (h.taste) richText([{ text: 'Taste: ', bold: true }, { text: h.taste }], margin, maxW);
      if (h.question) richText([{ text: 'Question: ', bold: true }, { text: h.question }], margin, maxW);
      gap(6);
      blocks(parseMarkdown(rev.markdown || ''));
      gap(10);
      plain(h.footer, margin, maxW, 9, { italic: true }, [107, 114, 128]);
    },
  };
}

export function reviewToPdf(rev, jsPDF) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const h = reviewHeader(rev);
  const writer = pdfWriter(doc, { margin: 64 });
  writer.review(rev);
  // page numbers
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    writer.font({}, 8.5);
    doc.setTextColor(150);
    doc.text(`portal-met-bridge · ${h.title}`, writer.margin, writer.pageH - 28);
    doc.text(`${p} / ${n}`, writer.pageW - writer.margin, writer.pageH - 28, { align: 'right' });
  }
  return doc.output('arraybuffer');
}

/** Bytes + mime for a review in the chosen format; pdf needs the jsPDF constructor. */
export function reviewFile(rev, fmt, { jsPDF } = {}) {
  const f = REVIEW_FORMATS[fmt] || REVIEW_FORMATS.md;
  if (f.ext === 'docx') return { name: reviewFileName(rev, 'docx'), data: reviewToDocx(rev), mime: f.mime };
  if (f.ext === 'pdf') {
    if (!jsPDF) throw new Error('jsPDF is not loaded');
    return { name: reviewFileName(rev, 'pdf'), data: reviewToPdf(rev, jsPDF), mime: f.mime };
  }
  return { name: reviewFileName(rev, 'md'), data: reviewMarkdownFile(rev), mime: f.mime };
}
