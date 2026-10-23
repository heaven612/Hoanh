// Builds the "site kit" ZIP: a localized, offline copy of the page plus the design
// tokens, layout map, asset manifest and a RECREATE.md guide. Runs in an
// extension page (offscreen document) because it needs DOMParser + fetch.

import { ZipWriter } from './zip.js';
import { renderMarkdown, videoLine } from './markdown.js';

const EXT_BY_TYPE = {
  'text/css': 'css', 'text/javascript': 'js', 'application/javascript': 'js', 'application/x-javascript': 'js',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'font/woff2': 'woff2',
  'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'application/font-woff': 'woff', 'application/font-woff2': 'woff2',
  'application/vnd.ms-fontobject': 'eot', 'application/json': 'json', 'application/manifest+json': 'json', 'video/mp4': 'mp4', 'video/webm': 'webm',
};
const FOLDER_BY_EXT = {
  css: 'css', js: 'js', mjs: 'js', png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', avif: 'img', svg: 'img',
  ico: 'img', bmp: 'img', woff2: 'fonts', woff: 'fonts', ttf: 'fonts', otf: 'fonts', eot: 'fonts', mp4: 'media', webm: 'media',
  mp3: 'media', json: 'data', webmanifest: 'data',
};

function relPath(fromDir, toPath) {
  if (!fromDir) return toPath;
  const from = fromDir.split('/').filter(Boolean);
  const to = toPath.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return `${'../'.repeat(from.length - i)}${to.slice(i).join('/')}`;
}

function safeName(url, ext) {
  let name = 'file';
  try {
    const u = new URL(url);
    name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
  } catch {
    /* keep default */
  }
  name = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
  return `${name}.${ext}`;
}

async function replaceAsync(str, re, fn) {
  const tasks = [];
  str.replace(re, (...args) => {
    tasks.push(fn(...args));
    return args[0];
  });
  const results = await Promise.all(tasks);
  let i = 0;
  return str.replace(re, () => results[i++]);
}

class AssetFetcher {
  constructor(zip, { maxAssets, maxBytes, onProgress, root }) {
    this.zip = zip;
    this.root = root;
    this.maxAssets = maxAssets;
    this.maxBytes = maxBytes;
    this.onProgress = onProgress;
    this.cache = new Map();
    this.manifest = [];
    this.totalBytes = 0;
    this.count = 0;
    this.active = 0;
    this.waiters = [];
  }

  async slot() {
    if (this.active < 8) {
      this.active++;
      return;
    }
    await new Promise((r) => this.waiters.push(r));
    this.active++;
  }

  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Returns the kit-relative path of the localized asset, or null if it stays remote. */
  get(rawUrl, kind = 'auto', depth = 0) {
    if (!rawUrl || /^(data|blob|about|javascript|mailto|tel):/i.test(rawUrl) || rawUrl.startsWith('#')) return Promise.resolve(null);
    const url = rawUrl.split('#')[0];
    if (!/^https?:/i.test(url)) return Promise.resolve(null);
    if (!this.cache.has(url)) this.cache.set(url, this.download(url, kind, depth));
    return this.cache.get(url);
  }

  async download(url, kind, depth) {
    if (this.count >= this.maxAssets) {
      this.manifest.push({ url, status: 'skipped (asset limit reached)' });
      return null;
    }
    this.count++;
    await this.slot();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      let res;
      try {
        res = await fetch(url, { signal: controller.signal, credentials: 'include' });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        this.manifest.push({ url, status: `HTTP ${res.status}` });
        return null;
      }
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      let ext = EXT_BY_TYPE[type];
      const urlExt = (url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i) || [])[1]?.toLowerCase();
      if (!ext || (ext === 'json' && urlExt === 'webmanifest')) ext = urlExt && FOLDER_BY_EXT[urlExt] ? urlExt : ext;
      if (kind === 'css') ext = 'css';
      if (kind === 'js' && !ext) ext = 'js';
      if (!ext) ext = type.startsWith('image/') ? type.slice(6).replace('+xml', '') : 'bin';
      const folder = FOLDER_BY_EXT[ext] || 'other';
      const path = `assets/${folder}/${safeName(url, ext)}`;

      let data;
      if (ext === 'css') {
        const text = await res.text();
        data = await this.processCss(text, url, `assets/${folder}`, depth);
      } else {
        data = new Uint8Array(await res.arrayBuffer());
        if (this.totalBytes + data.length > this.maxBytes) {
          this.manifest.push({ url, status: 'skipped (size limit reached)', bytes: data.length });
          return null;
        }
      }
      const size = typeof data === 'string' ? data.length : data.length;
      this.totalBytes += size;
      const finalPath = this.zip.add(`${this.root}${path}`, data).slice(this.root.length);
      this.manifest.push({ url, path: finalPath, type: type || ext, bytes: size, status: 'ok' });
      this.onProgress(`Downloaded ${this.manifest.filter((m) => m.status === 'ok').length} assets…`);
      return finalPath;
    } catch (err) {
      this.manifest.push({ url, status: `failed: ${err.name === 'AbortError' ? 'timeout' : err.message}` });
      return null;
    } finally {
      this.release();
    }
  }

  /** Localizes @import and url() references inside CSS. */
  async processCss(text, cssUrl, fromDir, depth = 0) {
    const resolve = (u) => {
      try {
        return new URL(u.trim(), cssUrl).href;
      } catch {
        return '';
      }
    };
    let out = text;
    if (depth < 4) {
      out = await replaceAsync(out, /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?/gi, async (m, q, u) => {
        const local = await this.get(resolve(u), 'css', depth + 1);
        return local ? `@import url("${relPath(fromDir, local)}")` : m.replace(u, resolve(u) || u);
      });
    }
    out = await replaceAsync(out, /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, async (m, q, u) => {
      if (/^(data:|#|about:)/i.test(u.trim())) return m;
      const absUrl = resolve(u);
      if (!absUrl) return m;
      if (/\.css(?:[?#]|$)/i.test(absUrl)) return m; // handled by @import
      const local = await this.get(absUrl, 'auto', depth + 1);
      return `url("${local ? relPath(fromDir, local) : absUrl}")`;
    });
    return out;
  }
}

function rewriteSrcset(value, base, fetcher) {
  return Promise.all(value.split(/,\s+/).map(async (candidate) => {
    const [u, ...desc] = candidate.trim().split(/\s+/);
    let absUrl = u;
    try {
      absUrl = new URL(u, base).href;
    } catch {
      return candidate;
    }
    const local = await fetcher.get(absUrl, 'auto');
    return [local || absUrl, ...desc].join(' ');
  })).then((parts) => parts.join(', '));
}

const json = (v) => JSON.stringify(v, null, 2);

function tokensMarkdown(t) {
  const list = (arr, fmt = (x) => `\`${x.value}\` ×${x.count}`) => (arr && arr.length ? arr.map(fmt).join(', ') : '_none detected_');
  const lines = [
    '### Colors',
    `- **Text colors:** ${list(t.textColors)}`,
    `- **Background colors (weighted by area):** ${list(t.backgroundColors)}`,
    `- **Border colors:** ${list(t.borderColors)}`,
    '',
    '### Typography',
    `- **Font families:** ${list(t.fontFamilies)}`,
    `- **Font sizes:** ${list(t.fontSizes)}`,
    `- **Font weights:** ${list(t.fontWeights)}`,
    '',
    '| Element | Font | Size | Weight | Line height | Color |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(t.typography || {}).map(([el, s]) => `| \`${el}\` | ${s.fontFamily.split(',')[0].replace(/["|]/g, '')} | ${s.fontSize} | ${s.fontWeight} | ${s.lineHeight} | \`${s.color}\` |`),
    '',
    '### Shape, depth & layout',
    `- **Border radii:** ${list(t.borderRadii)}`,
    `- **Box shadows:** ${list(t.boxShadows, (x) => `\`${x.value}\``)}`,
    `- **Container max-widths:** ${list(t.containerMaxWidths)}`,
    `- **Flex/grid gaps:** ${list(t.layoutGaps)}`,
    `- **Responsive breakpoints (from @media):** ${list(t.breakpoints)}`,
  ];
  const vars = Object.entries(t.cssVariables || {});
  if (vars.length) {
    lines.push('', `### CSS custom properties (${vars.length})`, '```css', ':root {', ...vars.slice(0, 120).map(([k, v]) => `  ${k}: ${v};`), vars.length > 120 ? '  /* …see data/design-tokens.json for the rest */' : '', '}', '```');
  }
  return lines.filter((l) => l !== undefined).join('\n');
}

function recreateGuide(kit, page, stats) {
  const v = kit.viewport;
  const embedded = page.videos.filter((x) => x.embedded);
  const sections = kit.sections.map((s) => `| ${s.index} | \`<${s.tag}${s.id ? `#${s.id}` : ''}${s.class ? `.${s.class.split(' ').slice(0, 2).join('.')}` : ''}>\` | ${s.top}px / ${s.height}px | ${s.layout.replace(/\|/g, '/')} | \`${s.background}\` | ${(s.heading || s.textSample.slice(0, 80)).replace(/\|/g, '/').replace(/\n/g, ' ')} | ${s.images} img · ${s.links} links · ${s.buttons} buttons |`);
  return `# Recreate: ${page.title}

- **Source:** <${page.url}>
- **Captured:** ${new Date(page.collectedAt).toLocaleString()}
- **Viewport at capture:** ${v.width}×${v.height} @${v.devicePixelRatio}x · full page ${v.scrollWidth}×${v.scrollHeight}px
- **Detected stack:** ${kit.tech.length ? kit.tech.join(', ') : 'nothing recognisable (likely hand-written HTML/CSS)'}

## What is in this kit

| Path | Purpose |
| --- | --- |
| \`index.html\` | Static, offline copy of the rendered page. Styles, images and fonts point to \`assets/\`; scripts removed so the snapshot renders exactly as captured. **Start here.** |
| \`index-with-scripts.html\` | Same snapshot with the original scripts kept (localized). Interactive bits may work, or the framework may re-render. |
| \`original-snapshot.html\` | Raw DOM as captured, all URLs still pointing at the live site. |
| \`screenshot.png\` | Screenshot of the visible viewport at capture time${kit.screenshot ? '' : ' (not captured)'}. |
| \`content.md\` | Clean text content of the page (Markdown) – use it for copy. |
| \`assets/css\`, \`assets/img\`, \`assets/fonts\`, \`assets/js\` | Downloaded assets (${stats.ok} files, ${(stats.bytes / 1024 / 1024).toFixed(1)} MB; ${stats.failed} could not be fetched). |
| \`data/design-tokens.json\` | Colors, typography, radii, shadows, breakpoints, CSS variables. |
| \`data/sections.json\` | Top-level page sections with position, layout and content summary. |
| \`data/layout-tree.json\` | DOM layout tree with bounding boxes, flex/grid settings and backgrounds. |
| \`data/assets-manifest.json\` | Every asset URL → local file (or why it stayed remote). |
| \`data/videos.json\` | Every embedded/linked video with watch + embed URLs. |
| \`data/page-info.json\` | Meta tags, icons, loaded web fonts, scripts, forms, stack hints. |

Tip: serve the folder (e.g. \`npx serve .\` or \`python3 -m http.server\`) instead of opening the file directly – some fonts and modules refuse to load from \`file://\`.

## Page structure

| # | Element | Top / height | Layout | Background | Heading / text | Contents |
| --- | --- | --- | --- | --- | --- | --- |
${sections.join('\n') || '| – | – | – | – | – | – | – |'}

## Design tokens

${tokensMarkdown(kit.designTokens)}

## Web fonts loaded

${kit.fonts.length ? [...new Map(kit.fonts.map((f) => [`${f.family}|${f.weight}|${f.style}`, f])).values()].slice(0, 40).map((f) => `- ${f.family} — weight ${f.weight}, ${f.style} (${f.status})`).join('\n') : '_No web fonts reported by the page._'}

## Embedded videos

${embedded.length ? embedded.map((x, i) => `${i + 1}. ${videoLine(x)}${x.embedUrl ? `\n   \`\`\`html\n   <iframe src="${x.embedUrl}" title="${(x.title || x.provider).replace(/"/g, '&quot;')}" width="560" height="315" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>\n   \`\`\`` : ''}`).join('\n') : '_No embedded videos found._'}

## Forms

${kit.forms.length ? kit.forms.map((f, i) => `${i + 1}. \`${f.method.toUpperCase()} ${f.action || '(same page)'}\` — fields: ${f.fields.filter((x) => x.type !== 'hidden').map((x) => `${x.label || x.name || x.placeholder || x.type} (${x.type})`).join(', ') || '—'}`).join('\n') : '_No forms._'}

## How to rebuild it (suggested prompt for Claude)

> Using the attached site kit (RECREATE.md, screenshot.png, content.md, data/design-tokens.json and data/sections.json), rebuild this page as a clean, responsive, accessible site using **[your stack, e.g. HTML + Tailwind / React + Next.js]**. Match the section order, layout, colors and typography from the tokens; reuse images from \`assets/img\`; keep the embedded videos with the iframe snippets above; replace tracking scripts and third-party widgets with lightweight equivalents.

Only rebuild sites you own or have permission to reuse; text, images, fonts and videos remain the property of their owners.
`;
}

export async function buildSiteKit(kit, { includeScripts = true, maxAssets = 600, maxTotalMB = 300, onProgress = () => {}, rootName = 'site-kit' } = {}) {
  const zip = new ZipWriter();
  const root = `${rootName}/`;
  const fetcher = new AssetFetcher(zip, { maxAssets, maxBytes: maxTotalMB * 1024 * 1024, onProgress, root });
  const base = kit.baseUrl;
  const absolute = (u) => {
    try {
      return new URL(u, base).href;
    } catch {
      return '';
    }
  };

  onProgress('Parsing page snapshot…');
  zip.add(`${root}original-snapshot.html`, kit.html);
  const doc = new DOMParser().parseFromString(kit.html, 'text/html');
  doc.querySelectorAll('base').forEach((b) => b.remove());

  // Restore CSS-in-JS rules that only lived in the CSSOM.
  const styleEls = [...doc.querySelectorAll('style')];
  for (const s of kit.stylesheets) {
    if (s.injected && styleEls[s.styleIndex]) styleEls[s.styleIndex].textContent = s.text;
    if (s.adopted && s.text) {
      const el = doc.createElement('style');
      el.setAttribute('data-from', 'adoptedStyleSheets');
      el.textContent = s.text;
      doc.head.appendChild(el);
    }
  }

  const tasks = [];
  const later = (fn) => tasks.push(fn());

  onProgress('Downloading stylesheets, fonts and images…');
  doc.querySelectorAll('link[href]').forEach((link) => {
    const rel = (link.getAttribute('rel') || '').toLowerCase();
    const href = absolute(link.getAttribute('href'));
    if (!href) return;
    if (rel.includes('stylesheet')) {
      later(async () => {
        const local = await fetcher.get(href, 'css');
        if (local) {
          link.setAttribute('href', local);
          link.removeAttribute('integrity');
          link.removeAttribute('crossorigin');
          return;
        }
        const fallback = kit.stylesheets.find((s) => s.href === href && s.fallbackText);
        if (fallback) {
          const css = await fetcher.processCss(fallback.fallbackText, href, 'assets/css');
          const path = zip.add(`${root}assets/css/${safeName(href, 'css')}`, css).slice(root.length);
          link.setAttribute('href', path);
          link.removeAttribute('integrity');
        } else link.setAttribute('href', href);
      });
    } else if (/icon|apple-touch|mask-icon|manifest/.test(rel) || (rel.includes('preload') && /font|image|style/.test(link.getAttribute('as') || ''))) {
      later(async () => {
        const local = await fetcher.get(href, link.getAttribute('as') === 'style' ? 'css' : 'auto');
        link.setAttribute('href', local || href);
        link.removeAttribute('integrity');
      });
    } else {
      link.setAttribute('href', href);
    }
  });

  doc.querySelectorAll('style').forEach((style) => {
    later(async () => {
      style.textContent = await fetcher.processCss(style.textContent, base, '');
    });
  });

  doc.querySelectorAll('[style*="url("]').forEach((el) => {
    later(async () => {
      el.setAttribute('style', await fetcher.processCss(el.getAttribute('style'), base, ''));
    });
  });

  doc.querySelectorAll('img, source, video[poster], input[type="image"], image, use, picture source').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const isMediaSource = tag === 'source' && el.parentElement && /^(video|audio)$/i.test(el.parentElement.tagName);
    for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'poster', 'href', 'xlink:href']) {
      const val = el.getAttribute(attr);
      if (!val || val.startsWith('data:')) continue;
      const absUrl = absolute(val);
      if (isMediaSource || ((tag === 'use') && val.startsWith('#'))) {
        if (isMediaSource) el.setAttribute(attr, absUrl);
        continue;
      }
      later(async () => {
        const fragment = tag === 'use' && val.includes('#') ? `#${val.split('#')[1]}` : '';
        const local = await fetcher.get(absUrl, 'auto');
        el.setAttribute(attr, local ? local + fragment : absUrl);
        if (local && attr !== 'src' && tag === 'img' && /data-/.test(attr) && (!el.getAttribute('src') || el.getAttribute('src').startsWith('data:'))) {
          el.setAttribute('src', local);
        }
      });
    }
    for (const attr of ['srcset', 'data-srcset']) {
      const val = el.getAttribute(attr);
      if (!val || isMediaSource) continue;
      later(async () => el.setAttribute(attr, await rewriteSrcset(val, base, fetcher)));
    }
  });

  const scriptEls = [...doc.querySelectorAll('script[src]')];
  if (includeScripts) {
    scriptEls.forEach((s) => later(async () => {
      const src = absolute(s.getAttribute('src'));
      const local = await fetcher.get(src, 'js');
      s.setAttribute('src', local || src);
      s.removeAttribute('integrity');
    }));
  } else {
    scriptEls.forEach((s) => s.setAttribute('src', absolute(s.getAttribute('src'))));
  }

  // Navigation links and embeds keep working by pointing at the live site.
  doc.querySelectorAll('a[href], area[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href && !href.startsWith('#') && !/^(javascript|mailto|tel):/i.test(href)) a.setAttribute('href', absolute(href));
  });
  doc.querySelectorAll('iframe[src], embed[src], form[action], object[data]').forEach((el) => {
    const attr = el.tagName === 'FORM' ? 'action' : el.tagName === 'OBJECT' ? 'data' : 'src';
    const val = el.getAttribute(attr);
    if (val && !/^(about|javascript|data):/i.test(val)) el.setAttribute(attr, absolute(val));
  });

  await Promise.all(tasks);

  const doctype = kit.html.match(/^<!DOCTYPE[^>]*>/i)?.[0] || '<!DOCTYPE html>';
  const stamp = doc.createComment(` Collected by Web Content Collector from ${kit.content.url} on ${kit.content.collectedAt} `);
  doc.documentElement.insertBefore(stamp, doc.documentElement.firstChild);
  zip.add(`${root}index-with-scripts.html`, `${doctype}\n${doc.documentElement.outerHTML}`);

  doc.querySelectorAll('script, link[rel="modulepreload"], link[rel="preload"][as="script"]').forEach((s) => {
    if ((s.getAttribute('type') || '').includes('json')) return; // keep JSON-LD / data islands
    s.remove();
  });
  // Lazy-loaded images that were never scrolled into view: make them load eagerly.
  doc.querySelectorAll('img[loading="lazy"]').forEach((img) => img.removeAttribute('loading'));
  zip.add(`${root}index.html`, `${doctype}\n${doc.documentElement.outerHTML}`);

  onProgress('Writing design data and guides…');
  const page = kit.content;
  zip.add(`${root}content.md`, renderMarkdown(page));
  if (kit.screenshot) {
    const b64 = kit.screenshot.split(',')[1];
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    zip.add(`${root}screenshot.png`, bytes);
  }
  zip.add(`${root}data/design-tokens.json`, json(kit.designTokens));
  zip.add(`${root}data/sections.json`, json(kit.sections));
  zip.add(`${root}data/layout-tree.json`, json(kit.layout));
  zip.add(`${root}data/assets-manifest.json`, json(fetcher.manifest));
  zip.add(`${root}data/videos.json`, json(page.videos));
  zip.add(`${root}data/page-info.json`, json({
    url: page.url,
    title: page.title,
    description: page.description,
    lang: page.lang,
    tech: kit.tech,
    viewport: kit.viewport,
    metaTags: kit.metaTags,
    icons: kit.icons,
    fonts: kit.fonts,
    scripts: kit.scripts,
    stylesheets: kit.stylesheets.map(({ href, media, ownerTag, injected, adopted }) => ({ href, media, ownerTag, injected, adopted })),
    forms: kit.forms,
  }));

  const ok = fetcher.manifest.filter((m) => m.status === 'ok');
  const stats = { ok: ok.length, bytes: fetcher.totalBytes, failed: fetcher.manifest.length - ok.length };
  zip.add(`${root}RECREATE.md`, recreateGuide(kit, page, stats));

  onProgress('Compressing ZIP…');
  return { blob: await zip.toBlob(), stats };
}
