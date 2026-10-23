// Settings + the local library of collected pages (chrome.storage.local).

export const DEFAULT_SETTINGS = {
  folder: 'WebCollector',
  scope: 'main', // 'main' (article/main content) | 'full' (whole page)
  includeHidden: false, // include collapsed accordions / hidden tabs
  outputs: { md: true, docx: true },
  docxImages: true,
  autoCollect: false,
  autoScope: 'allowlist', // 'allowlist' | 'all'
  allowlist: [],
  blocklist: [
    'mail.google.com', 'accounts.google.com', 'myaccount.google.com', 'outlook.live.com', 'outlook.office.com',
    'web.whatsapp.com', 'messenger.com', 'paypal.com', 'chatgpt.com', 'claude.ai', 'localhost',
  ],
  autoDelaySec: 3,
  autoMinWords: 150,
  autoDownloadMd: false,
  kit: { includeScripts: true, screenshot: true, autoScroll: true, maxAssets: 600, maxTotalMB: 300 },
};

const area = chrome.storage.local;

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

export async function getSettings() {
  const { settings } = await area.get('settings');
  return merge(DEFAULT_SETTINGS, settings);
}

export async function saveSettings(patch) {
  const next = merge(await getSettings(), patch);
  await area.set({ settings: next });
  return next;
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(p)) u.searchParams.delete(p);
    return u.href;
  } catch {
    return url;
  }
}

export function pageId(url) {
  let h = 0x811c9dc5;
  const s = normalizeUrl(url);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p${h.toString(16).padStart(8, '0')}`;
}

let lock = Promise.resolve();
const exclusive = (fn) => {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
};

export async function listPages() {
  const { index } = await area.get('index');
  return index || [];
}

export function summarize(page, extra = {}) {
  return {
    id: pageId(page.url),
    url: page.url,
    title: page.title,
    domain: page.domain,
    siteName: page.siteName,
    collectedAt: page.collectedAt,
    words: page.stats.words,
    videos: page.stats.videos,
    images: page.stats.images,
    ...extra,
  };
}

/** Saves (or replaces) a page. Returns { id, isNew, changed }. */
export function savePage(page, extra = {}) {
  return exclusive(async () => {
    const summary = summarize(page, extra);
    const index = await listPages();
    const prev = index.find((p) => p.id === summary.id);
    const changed = !prev || prev.title !== summary.title || Math.abs(prev.words - summary.words) > 20 || prev.videos !== summary.videos;
    const next = [summary, ...index.filter((p) => p.id !== summary.id)];
    await area.set({ index: next, [`page:${summary.id}`]: page });
    return { id: summary.id, isNew: !prev, changed };
  });
}

export async function getPage(id) {
  const key = `page:${id}`;
  return (await area.get(key))[key] || null;
}

export function deletePages(ids) {
  return exclusive(async () => {
    const set = new Set(ids);
    const index = await listPages();
    await area.remove(ids.map((id) => `page:${id}`));
    await area.set({ index: index.filter((p) => !set.has(p.id)) });
  });
}

export function hostMatches(host, patterns) {
  host = (host || '').toLowerCase().replace(/^www\./, '');
  return patterns.some((p) => {
    p = p.trim().toLowerCase().replace(/^\*\.|^www\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return p && (host === p || host.endsWith(`.${p}`));
  });
}

/** Downloads-API-safe relative path segment. */
export function pathSegment(s, max = 80) {
  return (s || 'untitled')
    .replace(/[<>:"/\\|?*\u0000-\u001f~]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, max)
    .trim() || 'untitled';
}
