# Web Content Collector (Chrome extension)

Collect the content of any webpage you're reading in an organized format:

| Output | What you get |
| --- | --- |
| **Markdown (.md)** for Claude | YAML front matter (source URL, author, dates, word count…), outline, clean content (headings, lists, tables, code, quotes, images), and tables of **embedded videos**, images and links. |
| **Study document (.docx)** | Cover page, overview, table of contents, learning objectives, full content with images, key takeaways, key terms, video resources, review questions, note space and references. |
| **Site kit (.zip)** to recreate the page | Offline copy (`index.html`) with local CSS/images/fonts/scripts (Shadow DOM included), raw snapshot, above-the-fold and **full-page** screenshots, design tokens (colors, typography, radii, shadows, breakpoints, CSS variables), section and layout maps, asset manifest, all video links and a `RECREATE.md` guide with a ready-made prompt for Claude. |

**Embedded video links** are found in iframes, `<video>` tags, lazy-load placeholders (lite-youtube, `data-video-id`…), Open Graph/Twitter tags and JSON-LD, for YouTube, Vimeo, Loom, Wistia, Dailymotion, TikTok, Twitch, Bilibili, TED, Vidyard, Brightcove, Google Drive, Facebook, direct video files and more. Each video gets a watch URL and an embed URL.

## Install

1. Download `web-content-collector.zip` and unzip it (or clone this repository and use the `extension/` folder).
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
4. Pin the extension icon in the toolbar.

## Use

- **Collect content:** click the icon, then choose Markdown and/or Study document, then **Collect this page** (or press `Alt+Shift+S`).
- **Recreate the webpage:** click **Collect all elements (.zip)** (or press `Alt+Shift+K`).
- **Auto-collect:** switch it on in the popup. By default it only runs on sites you add (**+ Add site to the auto list**); you can set it to all sites. Sensitive sites (mail, banking-style logins, etc.) are on a block list you can edit. Auto-collected pages go to the **Library** and can optionally be downloaded as `.md` too.
- **Library** (popup, then *Open library & settings*): re-download any page as `.md` or `.docx`, export everything as a **Claude bundle** (zip with `index.md` + one `.md` per page), export one combined `.md`, or export all study docs.

Files are saved to `Downloads/WebCollector/<site>/`. To avoid a save dialog per file, turn off *Ask where to save each file* in Chrome's download settings.

## Privacy

Everything runs locally in your browser. Nothing is sent to any server. Collected pages are stored in the extension's local storage until you delete them.

## Notes and limits

- Chrome blocks extensions on `chrome://` pages, the Chrome Web Store and some built-in viewers.
- Streaming players (e.g. a `<video>` fed by `blob:` URLs) don't expose their file URL; the page's own embed/watch URL is reported when available.
- The full-page screenshot is stitched from up to 20 screen-heights; very long pages are cut off there. Pages heavily built in JavaScript recreate best from `index.html` (static) together with `RECREATE.md`.
- Content hidden in closed tabs/accordions is skipped unless you enable *Include hidden/collapsed content* in Settings.
- Only recreate or reuse sites you own or have permission to use.

## Project layout

```
extension/
  manifest.json            MV3 manifest
  src/background.js        service worker: jobs, auto-collect, downloads
  src/content/extractor.js page-side extraction (content, videos, site kit data)
  src/lib/markdown.js      Markdown renderer
  src/lib/docx.js          .docx study-guide builder (no dependencies)
  src/lib/sitekit.js       site-kit ZIP builder (asset localization, RECREATE.md)
  src/lib/zip.js           ZIP writer
  src/lib/storage.js       settings + library
  src/offscreen/           offscreen document for Blob/DOMParser work
  src/popup/               toolbar popup
  src/library/             library + settings page
```
