import { getSettings, saveSettings, listPages, hostMatches } from '../lib/storage.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
let tab;
let settings;
let currentJob = null;

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = `status ${kind}`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'progress' && msg.jobId === currentJob) setStatus(msg.text);
});

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function renderSiteButton() {
  const host = hostOf(tab?.url);
  const btn = $('siteBtn');
  if (!host) {
    btn.hidden = true;
    return;
  }
  const listed = hostMatches(host, settings.allowlist);
  btn.textContent = listed ? `✓ ${host} is on the auto list (remove)` : `+ Add ${host} to the auto list`;
  btn.onclick = async () => {
    const allowlist = listed ? settings.allowlist.filter((h) => !hostMatches(host, [h])) : [...settings.allowlist, host];
    settings = await saveSettings({ allowlist });
    renderSiteButton();
  };
}

function renderAuto() {
  $('autoToggle').checked = settings.autoCollect;
  $('autoOptions').classList.toggle('off', !settings.autoCollect);
  document.querySelectorAll('input[name="autoScope"]').forEach((r) => { r.checked = r.value === settings.autoScope; });
  $('autoMd').checked = settings.autoDownloadMd;
  renderSiteButton();
}

async function run(type, button, extra = {}) {
  currentJob = `job${Date.now()}`;
  const buttons = [$('collectBtn'), $('kitBtn')];
  buttons.forEach((b) => { b.disabled = true; });
  setStatus(type === 'sitekit' ? 'Collecting all page elements… (large pages can take a minute)' : 'Collecting…');
  try {
    const res = await chrome.runtime.sendMessage({ type, tabId: tab.id, jobId: currentJob, ...extra });
    if (!res?.ok) throw new Error(res?.error || 'Something went wrong.');
    const r = res.result;
    if (type === 'collect') {
      const s = r.stats;
      setStatus(`Saved ${r.files.length} file(s): ${s.words.toLocaleString()} words · ${s.videos} embedded video(s) · ${s.images} image(s).\nCheck your Downloads/${settings.folder} folder.`, 'ok');
    } else {
      const mb = (r.bytes / 1024 / 1024).toFixed(1);
      setStatus(`Site kit saved (${mb} MB): ${r.stats.ok} assets downloaded, ${r.stats.failed} unavailable, ${r.videos} video link(s).`, 'ok');
    }
    $('count').textContent = (await listPages()).length;
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    currentJob = null;
  }
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await getSettings();
  $('pageTitle').textContent = tab?.title || 'Untitled page';
  $('pageHost').textContent = hostOf(tab?.url);
  $('outMd').checked = settings.outputs.md;
  $('outDocx').checked = settings.outputs.docx;
  $('scope').value = settings.scope;
  $('kitScripts').checked = settings.kit.includeScripts;
  $('kitScroll').checked = settings.kit.autoScroll;
  $('count').textContent = (await listPages()).length;
  renderAuto();

  if (!/^https?:|^file:/i.test(tab?.url || '')) {
    setStatus('This page cannot be collected (browser or extension page).', 'err');
    $('collectBtn').disabled = true;
    $('kitBtn').disabled = true;
  }

  const persistOutputs = async () => {
    settings = await saveSettings({ outputs: { md: $('outMd').checked, docx: $('outDocx').checked } });
  };
  $('outMd').onchange = persistOutputs;
  $('outDocx').onchange = persistOutputs;
  $('scope').onchange = async () => { settings = await saveSettings({ scope: $('scope').value }); };
  $('kitScripts').onchange = async () => { settings = await saveSettings({ kit: { includeScripts: $('kitScripts').checked } }); };
  $('kitScroll').onchange = async () => { settings = await saveSettings({ kit: { autoScroll: $('kitScroll').checked } }); };
  $('autoToggle').onchange = async () => {
    settings = await saveSettings({ autoCollect: $('autoToggle').checked });
    renderAuto();
  };
  document.querySelectorAll('input[name="autoScope"]').forEach((r) => {
    r.onchange = async () => {
      settings = await saveSettings({ autoScope: r.value });
      renderAuto();
    };
  });
  $('autoMd').onchange = async () => { settings = await saveSettings({ autoDownloadMd: $('autoMd').checked }); };

  $('collectBtn').onclick = () => {
    const outputs = { md: $('outMd').checked, docx: $('outDocx').checked };
    if (!outputs.md && !outputs.docx) {
      setStatus('Choose at least one output format.', 'err');
      return;
    }
    run('collect', $('collectBtn'), { outputs, scope: $('scope').value });
  };
  $('kitBtn').onclick = () => run('sitekit', $('kitBtn'));
  $('libraryBtn').onclick = () => chrome.runtime.openOptionsPage();
}

init();
