// Builds a Word (.docx) study guide from an extracted page. Pure WordprocessingML
// written by hand and packed with zip.js; no third-party libraries.

import { ZipWriter } from './zip.js';
import { plainText } from './markdown.js';

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const EMU_PER_PX = 9525;
const MAX_IMAGE_WIDTH_EMU = 6 * 914400; // 6 inches
const MAX_IMAGE_HEIGHT_EMU = 8 * 914400;

const xml = (s) => String(s ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Fetches an image and returns PNG/JPEG/GIF bytes plus pixel size (converting WebP/AVIF/SVG). */
export async function fetchImageForDoc(url, { timeoutMs = 15000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > maxBytes || blob.size === 0) return null;
    const type = (blob.type || '').toLowerCase();
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      return null; // SVG and broken images cannot be decoded off-DOM; skip them
    }
    const { width, height } = bitmap;
    let ext = type.includes('png') ? 'png' : type.includes('jpeg') || type.includes('jpg') ? 'jpeg' : type.includes('gif') ? 'gif' : '';
    let bytes;
    if (ext) {
      bytes = new Uint8Array(await blob.arrayBuffer());
    } else {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      ext = 'png';
    }
    bitmap.close();
    return { bytes, ext, width, height };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

class DocxBuilder {
  constructor() {
    this.body = [];
    this.rels = [];
    this.media = [];
    this.relCounter = 10; // rId1..9 reserved for styles/numbering/settings
    this.linkRels = new Map();
    this.drawingId = 1;
    this.orderedNums = []; // numIds for ordered lists (each restarts numbering)
  }

  linkRel(href) {
    if (this.linkRels.has(href)) return this.linkRels.get(href);
    const id = `rId${this.relCounter++}`;
    this.linkRels.set(href, id);
    this.rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(href)}" TargetMode="External"/>`);
    return id;
  }

  run(text, fmt = {}) {
    const props = [];
    if (fmt.style) props.push(`<w:rStyle w:val="${fmt.style}"/>`);
    if (fmt.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>');
    if (fmt.bold) props.push('<w:b/>');
    if (fmt.italic) props.push('<w:i/>');
    if (fmt.strike) props.push('<w:strike/>');
    if (fmt.color) props.push(`<w:color w:val="${fmt.color}"/>`);
    if (fmt.size) props.push(`<w:sz w:val="${fmt.size}"/>`);
    const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
    const pieces = String(text).split('\n');
    const content = pieces.map((p, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(p)}</w:t>`).join('');
    return `<w:r>${rPr}${content}</w:r>`;
  }

  runs(inlines = [], base = {}) {
    let out = '';
    for (const r of inlines) {
      if (r.br) {
        out += '<w:r><w:br/></w:r>';
        continue;
      }
      const fmt = { ...base, bold: base.bold || r.bold, italic: base.italic || r.italic, code: r.code, strike: r.strike };
      if (r.href && /^https?:|^mailto:/i.test(r.href)) {
        out += `<w:hyperlink r:id="${this.linkRel(r.href)}" w:history="1">${this.run(r.text, { ...fmt, style: 'Hyperlink' })}</w:hyperlink>`;
      } else {
        out += this.run(r.text, fmt);
      }
    }
    return out;
  }

  para(content, { style, numId, level = 0, align, keepNext, spacingAfter } = {}) {
    const pPr = [];
    if (style) pPr.push(`<w:pStyle w:val="${style}"/>`);
    if (keepNext) pPr.push('<w:keepNext/>');
    if (numId) pPr.push(`<w:numPr><w:ilvl w:val="${Math.min(level, 8)}"/><w:numId w:val="${numId}"/></w:numPr>`);
    if (spacingAfter !== undefined) pPr.push(`<w:spacing w:after="${spacingAfter}"/>`);
    if (align) pPr.push(`<w:jc w:val="${align}"/>`);
    return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${content}</w:p>`;
  }

  add(xmlString) {
    this.body.push(xmlString);
  }

  heading(text, level, inlines) {
    this.add(this.para(inlines ? this.runs(inlines) : this.run(text), { style: `Heading${Math.min(6, Math.max(1, level))}`, keepNext: true }));
  }

  paragraph(inlines, opts = {}) {
    const content = this.runs(inlines, opts.fmt);
    if (content) this.add(this.para(content, opts));
  }

  text(text, opts = {}) {
    this.add(this.para(this.run(text, opts.fmt || {}), opts));
  }

  pageBreak() {
    this.add('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  }

  bulletList(items, level = 0) {
    for (const item of items) this.add(this.para(typeof item === 'string' ? this.run(item) : this.runs(item), { style: 'ListParagraph', numId: 1, level }));
  }

  newOrderedNum() {
    const numId = 2 + this.orderedNums.length;
    this.orderedNums.push(numId);
    return numId;
  }

  image(img, data) {
    let cx = data.width * EMU_PER_PX;
    let cy = data.height * EMU_PER_PX;
    const scale = Math.min(1, MAX_IMAGE_WIDTH_EMU / cx, MAX_IMAGE_HEIGHT_EMU / cy);
    cx = Math.round(cx * scale);
    cy = Math.round(cy * scale);
    const relId = `rId${this.relCounter++}`;
    const name = `image${this.media.length + 1}.${data.ext}`;
    this.media.push({ name, bytes: data.bytes, ext: data.ext });
    this.rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
    const id = this.drawingId++;
    const descr = xml(img.alt || img.caption || '');
    this.add(this.para(
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
      { align: 'center', keepNext: !!(img.caption || img.alt) },
    ));
  }

  table(rows, { headerRow = true, widths } = {}) {
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const total = 9360; // 6.5in in twips
    const w = widths || Array.from({ length: cols }, () => Math.floor(total / cols));
    const grid = w.map((x) => `<w:gridCol w:w="${x}"/>`).join('');
    const trs = rows.map((cells, ri) => {
      const isHeader = headerRow && ri === 0;
      const tcs = Array.from({ length: cols }, (_, ci) => {
        const c = cells[ci];
        const content = c == null ? '' : typeof c === 'string' ? this.run(c, { bold: isHeader }) : this.runs(c, { bold: isHeader });
        const shade = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF7"/>' : '';
        return `<w:tc><w:tcPr><w:tcW w:w="${w[ci]}" w:type="dxa"/>${shade}</w:tcPr>${this.para(content, { spacingAfter: 0 })}</w:tc>`;
      }).join('');
      return `<w:tr>${isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tcs}</w:tr>`;
    }).join('');
    this.add(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${total}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl>`);
    this.add(this.para('', { spacingAfter: 120 }));
  }

  toc() {
    this.add(`<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${this.run('Right-click here and choose "Update Field" to build the table of contents.', { italic: true, color: '666666' })}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
  }

  documentXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${this.body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  }

  numberingXml() {
    const bulletLevels = Array.from({ length: 9 }, (_, i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${['•', '◦', '▪'][i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
    const decimalLevels = Array.from({ length: 9 }, (_, i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][i % 3]}"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
    const nums = [`<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`]
      .concat(this.orderedNums.map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`));
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bulletLevels}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${decimalLevels}</w:abstractNum>${nums.join('')}</w:numbering>`;
  }
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:color w:val="1F3864"/><w:sz w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="5A5A5A"/><w:sz w:val="26"/></w:rPr></w:style>
${[1, 2, 3, 4, 5, 6].map((l) => `<w:style w:type="paragraph" w:styleId="Heading${l}"><w:name w:val="heading ${l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${[360, 280, 240, 200, 160, 160][l - 1]}" w:after="${l < 3 ? 120 : 80}"/><w:outlineLvl w:val="${l - 1}"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:b/><w:color w:val="${['1F3864', '2F5496', '2F5496', '404040', '404040', '595959'][l - 1]}"/><w:sz w:val="${[36, 30, 26, 24, 22, 22][l - 1]}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="8EAADB"/></w:pBdr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F4F4"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="284"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Callout"><w:name w:val="Callout"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="EEF3FB"/><w:ind w:left="284" w:right="284"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="NoteLine"><w:name w:val="Note Line"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="BFBFBF"/></w:pBdr><w:spacing w:after="320"/></w:pPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

// ---------------------------------------------------------------------------
// Study aids (heuristic, derived only from the page itself)
// ---------------------------------------------------------------------------

const firstSentence = (text) => {
  const m = text.match(/^[\s\S]{20,400}?[.!?。！？](?=\s|$)/);
  return (m ? m[0] : text.slice(0, 300)).trim();
};

function sectionsOf(blocks) {
  const sections = [];
  let current = { heading: null, paragraphs: [] };
  for (const b of blocks) {
    if (b.type === 'heading' && !b.isTitle) {
      if (current.heading || current.paragraphs.length) sections.push(current);
      current = { heading: b, paragraphs: [] };
    } else if (b.type === 'paragraph') {
      current.paragraphs.push(plainText(b.inlines));
    }
  }
  sections.push(current);
  return sections;
}

function keyTerms(blocks) {
  const terms = new Map();
  const visit = (inlines) => {
    if (!inlines) return;
    const full = plainText(inlines);
    for (const r of inlines) {
      if (!r.bold || r.href) continue;
      const term = r.text.trim().replace(/[:：.,;]+$/, '');
      if (term.length < 2 || term.length > 60 || terms.has(term.toLowerCase()) || /^\d+$/.test(term)) continue;
      const sentence = full.split(/(?<=[.!?。])\s+/).find((s) => s.includes(term)) || full;
      terms.set(term.toLowerCase(), { term, context: sentence.length > 260 ? `${sentence.slice(0, 257)}…` : sentence });
    }
  };
  const walk = (list) => list.forEach((b) => {
    if (b.type === 'paragraph') visit(b.inlines);
    if (b.type === 'list') b.items.forEach((i) => { visit(i.inlines); walk(i.blocks); });
    if (b.type === 'quote') walk(b.blocks);
  });
  walk(blocks);
  return [...terms.values()].filter((t) => t.context !== t.term).slice(0, 30);
}

function reviewQuestions(headings, terms) {
  const templates = [
    (h) => `What are the key ideas presented in "${h}"?`,
    (h) => `Explain "${h}" in your own words.`,
    (h) => `How does "${h}" connect to the main topic of this material?`,
    (h) => `What example or evidence best illustrates "${h}"?`,
  ];
  const qs = headings.slice(0, 10).map((h, i) => (/[?？]$/.test(h) ? h : templates[i % templates.length](h)));
  terms.slice(0, 5).forEach((t) => qs.push(`Define "${t.term}" and give an example.`));
  return qs;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function buildStudyDocx(page, { includeImages = true, maxImages = 40, onProgress = () => {} } = {}) {
  const d = new DocxBuilder();
  const collected = new Date(page.collectedAt);
  const contentHeadings = page.headings.filter((h) => !(h.level === 1 && h.text === page.title));
  const minLevel = contentHeadings.length ? Math.min(...contentHeadings.map((h) => h.level)) : 2;
  const topHeadings = contentHeadings.filter((h) => h.level === minLevel).map((h) => h.text);

  // --- Cover -----------------------------------------------------------------
  d.text(page.title, { style: 'Title' });
  d.text(`Study material · ${page.siteName || page.domain}`, { style: 'Subtitle' });
  const src = page.canonical || page.url;
  d.add(d.para(d.run('Source: ', { bold: true }) + d.runs([{ text: src, href: src }])));
  const facts = [
    page.author && ['Author', page.author],
    page.published && ['Published', page.published.slice(0, 10)],
    ['Collected', collected.toLocaleString()],
    ['Reading time', `~${page.stats.readingMinutes} min (${page.stats.words.toLocaleString()} words)`],
    page.stats.videos && ['Embedded videos', String(page.stats.videos)],
  ].filter(Boolean);
  facts.forEach(([k, v]) => d.add(d.para(d.run(`${k}: `, { bold: true }) + d.run(v), { spacingAfter: 40 })));

  if (page.description) {
    d.heading('Overview', 1);
    d.text(page.description, { style: 'Callout' });
  }

  d.heading('Contents', 1);
  d.toc();

  if (topHeadings.length) {
    d.heading('Learning Objectives', 1);
    d.text('After studying this material you should be able to:', { fmt: { italic: true } });
    d.bulletList(topHeadings.slice(0, 8).map((h) => `Understand and explain: ${h}`));
  }

  // --- Main content ----------------------------------------------------------
  d.pageBreak();
  d.heading('Study Content', 1);
  const shift = 2 - minLevel;

  // Preload images in parallel (bounded) so the document keeps source order.
  const imageData = new Map();
  if (includeImages) {
    const imgs = [];
    const walk = (list) => list.forEach((b) => {
      if (b.type === 'image' && imgs.length < maxImages) imgs.push(b.src);
      if (b.blocks) walk(b.blocks);
      if (b.items) b.items.forEach((i) => walk(i.blocks));
    });
    walk(page.blocks);
    let done = 0;
    const queue = [...new Set(imgs)];
    const worker = async () => {
      while (queue.length) {
        const url = queue.shift();
        imageData.set(url, await fetchImageForDoc(url));
        onProgress(`Embedding images ${++done}/${imgs.length}`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  const renderBlocks = (blocks, listLevel = 0) => {
    for (const b of blocks) {
      switch (b.type) {
        case 'heading':
          if (!b.isTitle) d.heading(b.text, Math.min(6, Math.max(2, b.level + shift)), b.inlines);
          break;
        case 'paragraph':
          d.paragraph(b.inlines);
          break;
        case 'list': {
          const numId = b.ordered ? d.newOrderedNum() : 1;
          const renderItems = (items, level, num) => {
            for (const item of items) {
              d.add(d.para(d.runs(item.inlines), { style: 'ListParagraph', numId: num, level }));
              for (const child of item.blocks) {
                if (child.type === 'list') renderItems(child.items, level + 1, child.ordered ? num : 1);
                else renderBlocks([child], level + 1);
              }
            }
          };
          renderItems(b.items, listLevel, numId);
          break;
        }
        case 'code':
          b.text.split('\n').forEach((line) => d.add(d.para(d.run(line || ' '), { style: 'Code' })));
          d.add(d.para('', { spacingAfter: 120 }));
          break;
        case 'quote':
          for (const inner of b.blocks) {
            if (inner.type === 'paragraph') d.paragraph(inner.inlines, { style: 'Quote' });
            else renderBlocks([inner]);
          }
          break;
        case 'table': {
          const rows = b.rows.map((r) => r.cells.map((c) => c.inlines));
          if (b.caption) d.text(b.caption, { style: 'Caption', keepNext: true });
          d.table(rows, { headerRow: !!b.rows[0]?.header });
          break;
        }
        case 'image': {
          const data = imageData.get(b.src);
          if (data) d.image(b, data);
          else d.add(d.para(d.run('[Image] ', { bold: true }) + d.runs([{ text: b.alt || b.src, href: b.src }])));
          if (b.caption || b.alt) d.text(b.caption || b.alt, { style: 'Caption' });
          break;
        }
        case 'video': {
          const label = b.title || `${b.provider} video`;
          d.add(d.para(
            d.run('▶ Video: ', { bold: true, color: 'C00000' }) + d.runs([{ text: label, href: b.url || b.embedUrl }]) + d.run(` (${b.provider})`, { color: '666666' }),
            { style: 'Callout' },
          ));
          break;
        }
        case 'embed':
          d.add(d.para(d.run(`Embedded ${b.kind || 'content'}: `, { bold: true }) + d.runs([{ text: b.title || b.src, href: b.src }]), { style: 'Callout' }));
          break;
        case 'hr':
          d.add('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>');
          break;
        default:
          break;
      }
    }
  };
  renderBlocks(page.blocks);

  // --- Study aids ------------------------------------------------------------
  const takeaways = sectionsOf(page.blocks)
    .filter((s) => s.paragraphs.some((p) => p.length > 40))
    .slice(0, 12)
    .map((s) => ({ heading: s.heading?.text, point: firstSentence(s.paragraphs.find((p) => p.length > 40)) }));
  if (takeaways.length) {
    d.pageBreak();
    d.heading('Key Takeaways', 1);
    takeaways.forEach((t) => d.bulletList([[...(t.heading ? [{ text: `${t.heading}: `, bold: true }] : []), { text: t.point }]]));
  }

  const terms = keyTerms(page.blocks);
  if (terms.length) {
    d.heading('Key Terms', 1);
    d.table([['Term', 'Context from the source'], ...terms.map((t) => [[{ text: t.term, bold: true }], t.context])], { widths: [2600, 6760] });
  }

  const embedded = page.videos.filter((v) => v.embedded);
  const linked = page.videos.filter((v) => !v.embedded);
  if (embedded.length || linked.length) {
    d.heading('Video Resources', 1);
    const rows = [['#', 'Video', 'Provider', 'Link']];
    [...embedded, ...linked].forEach((v, i) => {
      const link = v.url || v.embedUrl;
      rows.push([String(i + 1), `${v.title || '(untitled)'}${v.embedded ? '' : ' — linked'}`, v.provider, link ? [{ text: link, href: link }] : v.note || '—']);
    });
    d.table(rows, { widths: [500, 3300, 1500, 4060] });
  }

  const questions = reviewQuestions(topHeadings.length ? topHeadings : contentHeadings.map((h) => h.text), terms);
  if (questions.length) {
    d.heading('Review Questions', 1);
    const numId = d.newOrderedNum();
    questions.forEach((q) => {
      d.add(d.para(d.run(q), { style: 'ListParagraph', numId }));
      d.add(d.para('', { style: 'NoteLine' }));
    });
  }

  d.heading('My Notes', 1);
  for (let i = 0; i < 8; i++) d.add(d.para('', { style: 'NoteLine' }));

  const refs = page.links.filter((l) => /^https?:/.test(l.href)).slice(0, 40);
  d.heading('References', 1);
  d.bulletList([[{ text: page.title, italic: true }, { text: ' — ' }, { text: src, href: src }]]);
  refs.forEach((l) => d.bulletList([[{ text: `${l.text} — ` }, { text: l.href, href: l.href }]]));

  // --- Package ---------------------------------------------------------------
  const zip = new ZipWriter();
  const mediaTypes = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' };
  zip.add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(mediaTypes).map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join('')}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  zip.add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.add('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(page.title)}</dc:title><dc:creator>Web Content Collector</dc:creator><dc:description>${xml(src)}</dc:description><cp:keywords>${xml((page.keywords || []).join(', '))}</cp:keywords><dcterms:created xsi:type="dcterms:W3CDTF">${collected.toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`);
  zip.add('word/document.xml', d.documentXml());
  zip.add('word/styles.xml', STYLES_XML);
  zip.add('word/numbering.xml', d.numberingXml());
  zip.add('word/settings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`);
  zip.add('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${d.rels.join('')}</Relationships>`);
  d.media.forEach((m) => zip.add(`word/media/${m.name}`, m.bytes));
  return zip.toBlob('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}
