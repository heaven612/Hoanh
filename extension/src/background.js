// Service worker: runs extraction in tabs, auto-collects, and saves downloads.
import { renderMarkdown, slugify } from './lib/markdown.js';
import * as store from './lib/storage.js';

// ---------------------------------------------------------------------------
// Offscreen document (Blob URLs + DOMParser for docx/zip building)
// ---------------------------------------------------------------------------

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['BLOBS', 'DOM_PARSER'],
    justification: 'Build Markdown, Word and ZIP files and parse page snapshots for download.',
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

async function offscreen(task) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...task });
  if (!res) throw new Error('File builder did not respond');
  if (res.error) throw new Error(res.error);
  return res;
}

const blobDownloads = new Map();
async function download(url, filename) {
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  if (url.startsWith('blob:')) blobDownloads.set(id, url);
  return id;
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || delta.state.current === 'in_progress' || !blobDownloads.has(delta.id)) return;
  const url = blobDownloads.get(delta.id);
  blobDownloads.delete(delta.id);
  offscreen({ type: 'revoke', url }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Page access
// ---------------------------------------------------------------------------

async function runInPage(tabId, fn, options) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/extractor.js'] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (name, opts) => window.__webCollector[name](opts),
    args: [fn, options ?? {}],
  });
  if (!res || res.result == null) throw new Error('Could not read this page.');
  return res.result;
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/cannot access|cannot be scripted|chrome:\/\/|edge:\/\/|webstore|extensions gallery/i.test(msg)) {
    return 'Chrome does not allow extensions to read this page (browser pages, the Web Store, and some PDFs are protected).';
  }
  if (/no tab with id/i.test(msg)) return 'The tab was closed.';
  return msg;
}

const progress = (jobId, text) => chrome.runtime.sendMessage({ type: 'progress', jobId, text }).catch(() => {});

async function badge(tabId, text, color = '#2f6fed', clearAfterMs = 4000) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    if (clearAfterMs) setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), clearAfterMs);
  } catch {
    /* tab may be gone */
  }
}

function basePath(settings, page) {
  return `${store.pathSegment(settings.folder || 'WebCollector')}/${store.pathSegment(page.domain || 'site')}/${slugify(page.title)}`;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function collectPage(tabId, { outputs, scope, jobId = `job${Date.now()}`, auto = false } = {}) {
  const settings = await store.getSettings();
  outputs ??= settings.outputs;
  progress(jobId, 'Reading page content…');
  await badge(tabId, '…', '#888', 0);
  const page = await runInPage(tabId, 'extractPage', { scope: scope || settings.scope, includeHidden: settings.includeHidden });
  const saved = await store.savePage(page, { auto });
  const base = basePath(settings, page);
  const files = [];

  if (outputs.md) {
    progress(jobId, 'Writing Markdown…');
    const { url } = await offscreen({ type: 'text', text: renderMarkdown(page), mime: 'text/markdown;charset=utf-8' });
    await download(url, `${base}.md`);
    files.push(`${base}.md`);
  }
  if (outputs.docx) {
    progress(jobId, 'Building study document…');
    const { url } = await offscreen({ type: 'docx', page, jobId, options: { includeImages: settings.docxImages } });
    await download(url, `${base}.docx`);
    files.push(`${base}.docx`);
  }
  await badge(tabId, '✓', '#1a7f37');
  return { id: saved.id, title: page.title, stats: page.stats, files };
}

async function collectSiteKit(tabId, { jobId = `job${Date.now()}` } = {}) {
  const settings = await store.getSettings();
  const tab = await chrome.tabs.get(tabId);
  await badge(tabId, '…', '#888', 0);
  if (settings.kit.autoScroll) {
    progress(jobId, 'Scrolling page to load lazy content…');
    await runInPage(tabId, 'autoScroll', 40);
  }
  progress(jobId, 'Capturing HTML, CSS, layout and design tokens…');
  const kit = await runInPage(tabId, 'extractSiteKit', { scope: settings.scope, includeHidden: settings.includeHidden });

  if (settings.kit.screenshot) {
    try {
      if (tab.active) kit.screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch {
      /* screenshots are best-effort */
    }
  }

  await store.savePage(kit.content);
  const base = basePath(settings, kit.content);
  const rootName = `${slugify(kit.content.title, 50)}-site-kit`;
  const res = await offscreen({
    type: 'sitekit',
    kit,
    jobId,
    options: {
      includeScripts: settings.kit.includeScripts,
      maxAssets: settings.kit.maxAssets,
      maxTotalMB: settings.kit.maxTotalMB,
      rootName,
    },
  });
  const filename = `${base}-site-kit.zip`;
  await download(res.url, filename);
  await badge(tabId, '✓', '#1a7f37');
  return { title: kit.content.title, stats: res.stats, bytes: res.bytes, files: [filename], videos: kit.content.stats.videos };
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab.id;
}

// ---------------------------------------------------------------------------
// Auto-collect
// ---------------------------------------------------------------------------

const autoTimers = new Map();

async function scheduleAuto(tabId, url) {
  if (!/^https?:/i.test(url || '')) return;
  const settings = await store.getSettings();
  if (!settings.autoCollect) return;
  const host = new URL(url).hostname;
  if (store.hostMatches(host, settings.blocklist)) return;
  if (settings.autoScope === 'allowlist' && !store.hostMatches(host, settings.allowlist)) return;

  clearTimeout(autoTimers.get(tabId));
  autoTimers.set(tabId, setTimeout(() => {
    autoTimers.delete(tabId);
    runAuto(tabId, url).catch(() => badge(tabId, '!', '#cf222e'));
  }, Math.max(0, Number(settings.autoDelaySec) || 0) * 1000));
}

async function runAuto(tabId, expectedUrl) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || store.normalizeUrl(tab.url) !== store.normalizeUrl(expectedUrl)) return; // navigated away
  const settings = await store.getSettings();
  const page = await runInPage(tabId, 'extractPage', { scope: settings.scope, includeHidden: settings.includeHidden });
  if (page.stats.words < settings.autoMinWords && !page.stats.videos) return;
  const saved = await store.savePage(page, { auto: true });
  if (settings.autoDownloadMd && saved.changed) {
    const { url } = await offscreen({ type: 'text', text: renderMarkdown(page), mime: 'text/markdown;charset=utf-8' });
    await download(url, `${basePath(settings, page)}.md`);
  }
  await badge(tabId, saved.isNew ? 'A' : 'A✓', '#8250df');
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') scheduleAuto(tabId, tab.url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId === 0) scheduleAuto(d.tabId, d.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(autoTimers.get(tabId));
  autoTimers.delete(tabId);
});

// ---------------------------------------------------------------------------
// Messages & shortcuts
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen' || msg.type === 'progress') return false;
  const handlers = {
    collect: () => collectPage(msg.tabId, msg),
    sitekit: () => collectSiteKit(msg.tabId, msg),
  };
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler().then(
    (result) => sendResponse({ ok: true, result }),
    (err) => {
      if (msg.tabId) badge(msg.tabId, '!', '#cf222e');
      sendResponse({ ok: false, error: friendlyError(err) });
    },
  );
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  let tabId;
  try {
    tabId = await activeTabId();
    if (command === 'collect-page') await collectPage(tabId);
    if (command === 'collect-site-kit') await collectSiteKit(tabId);
  } catch {
    if (tabId) badge(tabId, '!', '#cf222e');
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await store.saveSettings({});
    chrome.runtime.openOptionsPage();
  }
});
