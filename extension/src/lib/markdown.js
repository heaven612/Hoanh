// Renders an extracted page (see content/extractor.js) as clean, Claude-friendly
// Markdown: YAML front matter, outline, content, then media/link appendices.

const yamlString = (s) => JSON.stringify(String(s ?? ''));

function escapeText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*_`])/g, '\\$1')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/</g, '&lt;');
}

const escapeLineStart = (line) => line.replace(/^(\s*)([#>+-]|\d+[.)])(\s)/, '$1\\$2$3');

function wrap(text, marker) {
  // Keep surrounding whitespace outside the emphasis markers.
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : text;
}

export function inlineMarkdown(runs = [], { plain = false } = {}) {
  let out = '';
  for (const r of runs) {
    if (r.br) {
      out += plain ? ' ' : '  \n';
      continue;
    }
    let t;
    if (r.code) {
      const ticks = r.text.includes('`') ? '``' : '`';
      t = `${ticks}${r.text.replace(/\n/g, ' ')}${ticks}`;
    } else {
      t = escapeText(r.text);
      if (r.bold && !plain) t = wrap(t, '**');
      if (r.italic && !plain) t = wrap(t, '*');
      if (r.strike && !plain) t = wrap(t, '~~');
    }
    if (r.href && !plain && t.trim()) {
      const m = t.match(/^(\s*)([\s\S]*?)(\s*)$/);
      t = `${m[1]}[${m[2]}](${r.href.replace(/\)/g, '%29').replace(/ /g, '%20')})${m[3]}`;
    }
    out += t;
  }
  return out;
}

export const plainText = (runs = []) => runs.map((r) => (r.br ? ' ' : r.text)).join('').replace(/\s+/g, ' ').trim();

function tableMarkdown(block) {
  const width = Math.max(...block.rows.map((r) => r.cells.length));
  const cell = (c) => (c ? inlineMarkdown(c.inlines, {}).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>') : '');
  const row = (r) => `| ${Array.from({ length: width }, (_, i) => cell(r.cells[i])).join(' | ')} |`;
  const rows = [...block.rows];
  const head = rows[0].header ? rows.shift() : { cells: Array.from({ length: width }, () => ({ inlines: [] })) };
  const lines = [row(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.map(row)];
  if (block.caption) lines.unshift(`*Table: ${escapeText(block.caption)}*`, '');
  return lines.join('\n');
}

export function videoLine(v) {
  const title = v.title || v.caption || `${v.provider} video`;
  const parts = [`**${escapeText(title)}**`, `(${v.provider})`];
  if (v.url) parts.push(`— Watch: ${v.url}`);
  if (v.embedUrl && v.embedUrl !== v.url) parts.push(`· Embed: ${v.embedUrl}`);
  if (v.note) parts.push(`— _${v.note}_`);
  return parts.join(' ');
}

function blocksMarkdown(blocks, ctx, indent = '') {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': {
        if (b.isTitle) break;
        const level = Math.min(6, Math.max(2, b.level + ctx.headingShift));
        out.push(`${'#'.repeat(level)} ${inlineMarkdown(b.inlines, { plain: true }) || escapeText(b.text)}`);
        break;
      }
      case 'paragraph':
        out.push(inlineMarkdown(b.inlines).split('\n').map(escapeLineStart).join('\n'));
        break;
      case 'list': {
        const lines = [];
        b.items.forEach((item, i) => {
          const marker = b.ordered ? `${(b.start || 1) + i}.` : '-';
          const pad = ' '.repeat(marker.length + 1);
          const first = inlineMarkdown(item.inlines).replace(/\n/g, `\n${pad}`);
          lines.push(`${marker} ${first}`.trimEnd());
          if (item.blocks.length) {
            const nested = blocksMarkdown(item.blocks, ctx).split('\n').map((l) => (l ? pad + l : l)).join('\n');
            lines.push(nested.replace(/^\n+/, ''));
          }
        });
        out.push(lines.join('\n'));
        break;
      }
      case 'code': {
        const fence = b.text.includes('```') ? '````' : '```';
        out.push(`${fence}${b.lang || ''}\n${b.text}\n${fence}`);
        break;
      }
      case 'quote':
        out.push(blocksMarkdown(b.blocks, ctx).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
        break;
      case 'table':
        out.push(tableMarkdown(b));
        break;
      case 'image': {
        const alt = (b.alt || b.caption || '').replace(/[[\]]/g, '');
        let md = `![${alt}](${b.src.replace(/\)/g, '%29').replace(/ /g, '%20')})`;
        if (b.href && b.href !== b.src) md = `[${md}](${b.href})`;
        out.push(b.caption ? `${md}\n*${escapeText(b.caption)}*` : md);
        break;
      }
      case 'video':
        out.push(`> 🎬 **Video:** ${videoLine(b)}${b.caption && b.caption !== b.title ? `\n> *${escapeText(b.caption)}*` : ''}`);
        break;
      case 'embed':
        out.push(`> 📎 **Embedded ${b.kind || 'content'}:** ${b.title ? `${escapeText(b.title)} — ` : ''}${b.src}`);
        break;
      case 'hr':
        out.push('---');
        break;
      default:
        break;
    }
  }
  return out.filter((s) => s && s.trim()).map((s) => indent + s).join('\n\n');
}

/** Lowest heading level used in the body (excluding the title) mapped to H2. */
function headingShift(blocks) {
  const levels = [];
  const walk = (list) => list.forEach((b) => {
    if (b.type === 'heading' && !b.isTitle) levels.push(b.level);
    if (b.blocks) walk(b.blocks);
  });
  walk(blocks);
  return levels.length ? 2 - Math.min(...levels) : 0;
}

export function slugify(text, max = 60) {
  return (text || 'page')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '') || 'page';
}

export function renderMarkdown(page, { includeAppendix = true } = {}) {
  const ctx = { headingShift: headingShift(page.blocks) };
  const fm = [
    '---',
    `title: ${yamlString(page.title)}`,
    `source_url: ${yamlString(page.canonical || page.url)}`,
    page.siteName && `site: ${yamlString(page.siteName)}`,
    page.author && `author: ${yamlString(page.author)}`,
    page.published && `published: ${yamlString(page.published)}`,
    page.modified && `modified: ${yamlString(page.modified)}`,
    `collected_at: ${yamlString(page.collectedAt)}`,
    page.lang && `language: ${yamlString(page.lang)}`,
    page.description && `description: ${yamlString(page.description)}`,
    page.keywords?.length && `keywords: [${page.keywords.map(yamlString).join(', ')}]`,
    `word_count: ${page.stats.words}`,
    `reading_time_minutes: ${page.stats.readingMinutes}`,
    `embedded_videos: ${page.stats.videos}`,
    `images: ${page.stats.images}`,
    `extraction_scope: ${page.scope === 'full' ? 'full-page' : 'main-content'}`,
    '---',
  ].filter(Boolean);

  const parts = [fm.join('\n'), `# ${escapeText(page.title)}`];
  const metaLine = [
    `**Source:** <${page.canonical || page.url}>`,
    page.author && `**Author:** ${escapeText(page.author)}`,
    page.published && `**Published:** ${page.published.slice(0, 10)}`,
  ].filter(Boolean).join(' · ');
  parts.push(metaLine);
  if (page.description) parts.push(`> ${escapeText(page.description)}`);

  const outline = page.headings.filter((h) => !(h.level === 1 && h.text === page.title));
  if (outline.length >= 3) {
    const min = Math.min(...outline.map((h) => h.level));
    parts.push('## Outline', outline.slice(0, 80).map((h) => `${'  '.repeat(Math.min(4, h.level - min))}- ${escapeText(h.text)}`).join('\n'));
    parts.push('## Content');
    ctx.headingShift += 1; // nest page headings under "Content"
  }

  parts.push(blocksMarkdown(page.blocks, ctx) || '_No readable content was found on this page._');

  if (includeAppendix) {
    const embedded = page.videos.filter((v) => v.embedded);
    const linked = page.videos.filter((v) => !v.embedded);
    if (embedded.length) {
      parts.push('## Embedded Videos', [
        '| # | Title | Provider | Watch URL | Embed URL |',
        '| --- | --- | --- | --- | --- |',
        ...embedded.map((v, i) => `| ${i + 1} | ${escapeText(v.title || '—').replace(/\|/g, '\\|')} | ${v.provider} | ${v.url || '—'} | ${v.embedUrl || '—'} |`),
      ].join('\n'));
    }
    if (linked.length) {
      parts.push('## Linked Videos', linked.map((v) => `- ${videoLine(v)}`).join('\n'));
    }
    if (page.images.length) {
      parts.push('## Images', page.images.slice(0, 100).map((img, i) => `${i + 1}. ${img.alt ? `${escapeText(img.alt)} — ` : ''}${img.src}${img.caption ? ` (caption: ${escapeText(img.caption)})` : ''}`).join('\n'));
    }
    const links = page.links.filter((l) => !/^mailto:|^tel:/.test(l.href)).slice(0, 150);
    if (links.length) {
      parts.push('## Links Referenced', links.map((l) => `- [${l.text.replace(/[[\]]/g, '')}](${l.href.replace(/\)/g, '%29')})`).join('\n'));
    }
  }
  return `${parts.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/** A catalog plus every page, for uploading a whole research session to Claude. */
export function renderBundleIndex(pages, fileNames) {
  const lines = [
    '---',
    `title: "Web Content Collection"`,
    `generated_at: ${yamlString(new Date().toISOString())}`,
    `page_count: ${pages.length}`,
    '---',
    '',
    '# Web Content Collection',
    '',
    'Each page below was collected from the web and saved as its own Markdown file. Front matter in each file holds the source URL and metadata.',
    '',
    '| # | Title | Site | Words | Videos | File |',
    '| --- | --- | --- | --- | --- | --- |',
    ...pages.map((p, i) => `| ${i + 1} | [${p.title.replace(/[[\]|]/g, '')}](${p.url}) | ${p.siteName || p.domain} | ${p.stats.words} | ${p.stats.videos} | ${fileNames[i]} |`),
  ];
  const allVideos = pages.flatMap((p) => p.videos.filter((v) => v.embedded).map((v) => ({ ...v, page: p.title })));
  if (allVideos.length) {
    lines.push('', '## All Embedded Videos', '', ...allVideos.map((v) => `- ${videoLine(v)} — from *${escapeText(v.page)}*`));
  }
  return `${lines.join('\n')}\n`;
}
