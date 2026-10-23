import { getSettings, saveSettings, listPages, getPage, deletePages, pathSegment } from '../lib/storage.js';
import { renderMarkdown, renderBundleIndex, slugify } from '../lib/markdown.js';
import { buildStudyDocx } from '../lib/docx.js';
import { ZipWriter } from '../lib/zip.js';

const $ = (id) => document.getElementById(id);
let pages = [];
const selected = new Set();

function setStatus(text, kind = '') {
  $('libStatus').textContent = text;
  $('libStatus').className = `status ${kind}`;
}

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  }
}

async function folder() {
  return pathSegment((await getSettings()).folder || 'WebCollector');
}

const fileBase = (p) => `${pathSegment(p.domain || 'site')}/${slugify(p.title)}`;

function render() {
  const q = $('search').value.trim().toLowerCase();
  const rows = pages.filter((p) => !q || `${p.title} ${p.domain} ${p.url}`.toLowerCase().includes(q));
  $('empty').hidden = pages.length > 0;
  $('rows').replaceChildren(...rows.map((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" ${selected.has(p.id) ? 'checked' : ''} aria-label="Select"></td>
      <td class="title"><a target="_blank" rel="noopener"></a><div class="site"></div></td>
      <td>${p.words.toLocaleString()}</td>
      <td>${p.videos}</td>
      <td>${new Date(p.collectedAt).toLocaleString()}</td>
      <td class="files"><button class="mini" data-act="md">.md</button> <button class="mini" data-act="docx">.docx</button> <button class="mini danger" data-act="del" title="Delete">✕</button></td>`;
    const a = tr.querySelector('a');
    a.href = p.url;
    a.textContent = p.title;
    const site = tr.querySelector('.site');
    site.textContent = p.siteName || p.domain;
    if (p.auto) site.insertAdjacentHTML('beforeend', '<span class="badge">auto</span>');
    tr.querySelector('input').onchange = (e) => {
      if (e.target.checked) selected.add(p.id);
      else selected.delete(p.id);
    };
    tr.querySelectorAll('button').forEach((b) => {
      b.onclick = () => rowAction(b.dataset.act, p, b);
    });
    return tr;
  }));
}

async function rowAction(act, summary, button) {
  if (act === 'del') {
    await deletePages([summary.id]);
    selected.delete(summary.id);
    return refresh();
  }
  button.disabled = true;
  try {
    const page = await getPage(summary.id);
    if (!page) throw new Error('Page data missing.');
    const base = `${await folder()}/${fileBase(page)}`;
    if (act === 'md') await saveBlob(new Blob([renderMarkdown(page)], { type: 'text/markdown' }), `${base}.md`);
    if (act === 'docx') {
      setStatus('Building study document…');
      await saveBlob(await buildStudyDocx(page, { includeImages: (await getSettings()).docxImages, onProgress: setStatus }), `${base}.docx`);
      setStatus('Study document saved.', 'ok');
    }
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    button.disabled = false;
  }
}

async function targetPages() {
  const ids = selected.size ? [...selected] : pages.map((p) => p.id);
  const full = [];
  for (const id of ids) {
    const p = await getPage(id);
    if (p) full.push(p);
  }
  if (!full.length) throw new Error('The library is empty.');
  return full;
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

async function bulk(button, fn) {
  document.querySelectorAll('.actions button').forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    document.querySelectorAll('.actions button').forEach((b) => { b.disabled = false; });
  }
}

$('exportMd').onclick = () => bulk($('exportMd'), async () => {
  const list = await targetPages();
  const zip = new ZipWriter();
  const names = list.map((p) => zip.add(`pages/${fileBase(p).replace('/', '__')}.md`, renderMarkdown(p)));
  zip.add('index.md', renderBundleIndex(list, names));
  await saveBlob(await zip.toBlob(), `${await folder()}/claude-bundle-${stamp()}.zip`);
  setStatus(`Exported ${list.length} page(s) as Markdown.`, 'ok');
});

$('exportCombined').onclick = () => bulk($('exportCombined'), async () => {
  const list = await targetPages();
  const text = [renderBundleIndex(list, list.map((p) => `section ${list.indexOf(p) + 1}`)), ...list.map((p, i) => `\n\n<!-- ===== Page ${i + 1} of ${list.length} ===== -->\n\n${renderMarkdown(p)}`)].join('');
  await saveBlob(new Blob([text], { type: 'text/markdown' }), `${await folder()}/collection-${stamp()}.md`);
  setStatus(`Combined ${list.length} page(s) into one Markdown file.`, 'ok');
});

$('exportDocx').onclick = () => bulk($('exportDocx'), async () => {
  const list = await targetPages();
  const zip = new ZipWriter();
  const { docxImages } = await getSettings();
  for (const [i, p] of list.entries()) {
    setStatus(`Building study document ${i + 1}/${list.length}…`);
    const blob = await buildStudyDocx(p, { includeImages: docxImages });
    zip.add(`${fileBase(p).replace('/', '__')}.docx`, await blob.arrayBuffer());
  }
  await saveBlob(await zip.toBlob(), `${await folder()}/study-docs-${stamp()}.zip`);
  setStatus(`Exported ${list.length} study document(s).`, 'ok');
});

$('deleteSelected').onclick = () => bulk($('deleteSelected'), async () => {
  const ids = selected.size ? [...selected] : [];
  if (!ids.length) throw new Error('Select pages to delete first.');
  if (!confirm(`Delete ${ids.length} page(s) from the library?`)) return;
  await deletePages(ids);
  selected.clear();
  await refresh();
  setStatus('Deleted.', 'ok');
});

$('selectAll').onchange = (e) => {
  selected.clear();
  if (e.target.checked) pages.forEach((p) => selected.add(p.id));
  render();
};
$('search').oninput = render;

async function refresh() {
  pages = await listPages();
  render();
}

// --- Settings ---------------------------------------------------------------

const form = $('settingsForm');
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

async function loadSettings() {
  const s = await getSettings();
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = getPath(s, el.name);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.tagName === 'TEXTAREA') el.value = (v || []).join('\n');
    else el.value = v ?? '';
  }
}

form.onsubmit = async (e) => {
  e.preventDefault();
  const patch = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (el.tagName === 'TEXTAREA') v = el.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    const keys = el.name.split('.');
    let target = patch;
    keys.slice(0, -1).forEach((k) => { target = target[k] ??= {}; });
    target[keys.at(-1)] = v;
  }
  await saveSettings(patch);
  $('saved').textContent = 'Saved ✓';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
};

// --- Tabs -------------------------------------------------------------------

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${t.dataset.tab}`; });
  };
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.index) refresh();
});

refresh();
loadSettings();
