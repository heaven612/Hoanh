// Offscreen document: builds files that need DOM/Blob APIs the service worker
// lacks (DOMParser, URL.createObjectURL) and hands back blob: URLs to download.
import { buildStudyDocx } from '../lib/docx.js';
import { buildSiteKit } from '../lib/sitekit.js';

const AUTO_REVOKE_MS = 10 * 60 * 1000;

function publish(blob) {
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), AUTO_REVOKE_MS);
  return url;
}

const progress = (jobId, text) => chrome.runtime.sendMessage({ type: 'progress', jobId, text }).catch(() => {});

async function handle(msg) {
  switch (msg.type) {
    case 'text':
      return { url: publish(new Blob([msg.text], { type: msg.mime || 'text/plain;charset=utf-8' })) };
    case 'docx': {
      const blob = await buildStudyDocx(msg.page, { ...msg.options, onProgress: (t) => progress(msg.jobId, t) });
      return { url: publish(blob), bytes: blob.size };
    }
    case 'sitekit': {
      const { blob, stats } = await buildSiteKit(msg.kit, { ...msg.options, onProgress: (t) => progress(msg.jobId, t) });
      return { url: publish(blob), bytes: blob.size, stats };
    }
    case 'revoke':
      URL.revokeObjectURL(msg.url);
      return {};
    default:
      throw new Error(`Unknown offscreen task: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  handle(msg).then(sendResponse, (err) => sendResponse({ error: err?.message || String(err) }));
  return true;
});
