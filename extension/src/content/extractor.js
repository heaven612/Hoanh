// Injected into the page (isolated world) on demand. Defines
// window.__webCollector with two entry points:
//   extractPage(options)    -> structured, clean content (blocks, videos, metadata)
//   extractSiteKit(options) -> everything needed to rebuild the page (HTML, CSS,
//                              design tokens, layout map, tech hints, ...)
(() => {
  if (window.__webCollector) return;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const abs = (url, base = document.baseURI) => {
    if (!url) return '';
    try {
      return new URL(String(url).trim(), base).href;
    } catch {
      return '';
    }
  };

  const clean = (s) => (s || '').replace(/[\s ]+/g, ' ').trim();

  const meta = (...names) => {
    for (const name of names) {
      const el = document.querySelector(`meta[name="${name}" i], meta[property="${name}" i], meta[itemprop="${name}" i]`);
      const v = el && clean(el.getAttribute('content'));
      if (v) return v;
    }
    return '';
  };

  const classOf = (el) => (el.getAttribute && el.getAttribute('class')) || '';

  function jsonLdObjects() {
    const out = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      out.push(node);
      if (node['@graph']) visit(node['@graph']);
      for (const key of ['video', 'mainEntity', 'hasPart', 'associatedMedia', 'subjectOf']) {
        if (node[key]) visit(node[key]);
      }
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        visit(JSON.parse(s.textContent));
      } catch {
        /* malformed JSON-LD is common; ignore */
      }
    });
    return out;
  }

  const ldHasType = (obj, type) => {
    const t = obj['@type'];
    return Array.isArray(t) ? t.includes(type) : t === type;
  };

  const ldName = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(ldName).filter(Boolean).join(', ');
    return v.name || '';
  };

  // ---------------------------------------------------------------------------
  // Video detection
  // ---------------------------------------------------------------------------

  const VIDEO_PROVIDERS = [
    {
      name: 'YouTube',
      re: /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|v\/|shorts\/|live\/|watch\?(?:[^#]*&)?v=)|youtu\.be\/)([\w-]{11})/i,
      url: (id) => `https://www.youtube.com/watch?v=${id}`,
      embed: (id) => `https://www.youtube.com/embed/${id}`,
      thumb: (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    },
    {
      name: 'YouTube playlist',
      re: /youtube(?:-nocookie)?\.com\/(?:embed\/videoseries|playlist)\?(?:[^#]*&)?list=([\w-]+)/i,
      url: (id) => `https://www.youtube.com/playlist?list=${id}`,
      embed: (id) => `https://www.youtube.com/embed/videoseries?list=${id}`,
    },
    {
      name: 'Vimeo',
      re: /(?:player\.vimeo\.com\/video\/|vimeo\.com\/(?:video\/|channels\/[\w-]+\/|groups\/[\w-]+\/videos\/)?)(\d{5,})/i,
      url: (id) => `https://vimeo.com/${id}`,
      embed: (id) => `https://player.vimeo.com/video/${id}`,
    },
    {
      name: 'Dailymotion',
      re: /(?:dailymotion\.com\/(?:embed\/)?video\/|dai\.ly\/|geo\.dailymotion\.com\/player(?:\/\w+)?\.html\?video=)([a-z0-9]+)/i,
      url: (id) => `https://www.dailymotion.com/video/${id}`,
      embed: (id) => `https://www.dailymotion.com/embed/video/${id}`,
    },
    {
      name: 'Loom',
      re: /loom\.com\/(?:share|embed)\/([a-f0-9]{20,})/i,
      url: (id) => `https://www.loom.com/share/${id}`,
      embed: (id) => `https://www.loom.com/embed/${id}`,
    },
    {
      name: 'Wistia',
      re: /(?:wistia\.(?:com|net)\/(?:medias|embed\/iframe|embed\/medias)\/|wvideo=)([a-z0-9]{6,})/i,
      url: (id) => `https://fast.wistia.net/embed/iframe/${id}`,
      embed: (id) => `https://fast.wistia.net/embed/iframe/${id}`,
    },
    {
      name: 'TikTok',
      re: /tiktok\.com\/(?:embed(?:\/v2)?\/|@[\w.-]+\/video\/|player\/v1\/)(\d{8,})/i,
      url: (id) => `https://www.tiktok.com/video/${id}`,
      embed: (id) => `https://www.tiktok.com/embed/v2/${id}`,
    },
    {
      name: 'Twitch',
      re: /(?:player\.twitch\.tv\/\?(?:[^#]*&)?(?:video|channel|clip)=|twitch\.tv\/videos\/|clips\.twitch\.tv\/(?:embed\?clip=)?)([\w-]+)/i,
      url: (id) => (/^\d+$/.test(id) ? `https://www.twitch.tv/videos/${id}` : `https://www.twitch.tv/${id}`),
    },
    {
      name: 'Bilibili',
      re: /(?:player\.bilibili\.com\/player\.html\?(?:[^#]*&)?bvid=|bilibili\.com\/video\/)(BV\w+)/i,
      url: (id) => `https://www.bilibili.com/video/${id}`,
      embed: (id) => `https://player.bilibili.com/player.html?bvid=${id}`,
    },
    {
      name: 'TED',
      re: /(?:embed\.)?ted\.com\/talks\/([\w-]+)/i,
      url: (id) => `https://www.ted.com/talks/${id}`,
      embed: (id) => `https://embed.ted.com/talks/${id}`,
    },
    {
      name: 'Streamable',
      re: /streamable\.com\/(?:e\/|o\/|s\/)?([a-z0-9]{4,})(?:[/?#]|$)/i,
      url: (id) => `https://streamable.com/${id}`,
      embed: (id) => `https://streamable.com/e/${id}`,
    },
    {
      name: 'Vidyard',
      re: /(?:play\.vidyard\.com\/|vidyard\.com\/watch\/)([\w-]{10,})/i,
      url: (id) => `https://share.vidyard.com/watch/${id}`,
      embed: (id) => `https://play.vidyard.com/${id}`,
    },
    {
      name: 'Google Drive',
      re: /drive\.google\.com\/file\/d\/([\w-]{10,})/i,
      url: (id) => `https://drive.google.com/file/d/${id}/view`,
      embed: (id) => `https://drive.google.com/file/d/${id}/preview`,
    },
    {
      name: 'Facebook',
      re: /facebook\.com\/(?:plugins\/video\.php\?[^#]*href=([^&#]+)|[\w.]+\/videos\/(\d+)|watch\/?\?v=(\d+))/i,
    },
    { name: 'Instagram', re: /instagram\.com\/(?:p|reel|tv)\/([\w-]+)/i, url: (id) => `https://www.instagram.com/reel/${id}/` },
    { name: 'X / Twitter video', re: /(?:twitter|x)\.com\/i\/videos\/(?:tweet\/)?(\d+)/i },
    { name: 'Brightcove', re: /players\.brightcove\.net\/(\d+)\/[^?#]+\?(?:[^#]*&)?videoId=([\w-]+)/i },
    { name: 'JW Player', re: /(?:cdn\.jwplayer\.com|content\.jwplatform\.com)\/(?:players|previews|manifests|videos)\/([a-z0-9]{8})/i },
    { name: 'Kaltura', re: /kaltura\.com\/.*?(?:entry_id|entryId)[=/]([\w-]+)/i },
    { name: 'Rumble', re: /rumble\.com\/embed\/([\w]+)/i, url: (id) => `https://rumble.com/embed/${id}/` },
    { name: 'Odysee', re: /odysee\.com\/\$\/embed\/([^?#]+)/i },
    { name: 'SoundCloud', re: /(?:w\.)?soundcloud\.com\/(?:player\/\?url=)?([^?#]+)/i, kind: 'audio' },
    { name: 'Spotify', re: /open\.spotify\.com\/(?:embed\/)?((?:episode|show|track|playlist|album)\/[\w]+)/i, kind: 'audio', url: (id) => `https://open.spotify.com/${id}` },
  ];

  const MEDIA_FILE_RE = /\.(mp4|webm|ogv|ogg|mov|m4v|mkv|m3u8|mpd)(?:[?#]|$)/i;

  function videoFromUrl(raw, extra = {}) {
    const url = abs(raw);
    if (!url || url.startsWith('javascript:')) return null;
    if (url.startsWith('blob:')) {
      return {
        provider: 'HTML5 video (stream)',
        id: '',
        url: '',
        embedUrl: '',
        note: 'Streamed via blob/MSE – the original file URL is not exposed by the page.',
        ...extra,
      };
    }
    for (const p of VIDEO_PROVIDERS) {
      const m = url.match(p.re);
      if (!m) continue;
      const id = decodeURIComponent(m.slice(1).find(Boolean) || '');
      return {
        provider: p.name,
        kind: p.kind || 'video',
        id,
        url: p.url && id ? p.url(id) : url,
        embedUrl: p.embed && id ? p.embed(id) : url,
        thumbnail: p.thumb && id ? p.thumb(id) : '',
        ...extra,
      };
    }
    if (MEDIA_FILE_RE.test(url)) {
      return { provider: 'Video file', kind: 'video', id: '', url, embedUrl: url, ...extra };
    }
    return null;
  }

  const ID_ATTRS = [
    ['data-youtube-id', 'yt'],
    ['data-ytid', 'yt'],
    ['data-yt-id', 'yt'],
    ['videoid', 'yt-if-tag'],
    ['data-videoid', 'yt-if-tag'],
    ['data-video-id', 'yt-if-tag'],
    ['data-vimeo-id', 'vimeo'],
    ['data-vimeo', 'vimeo'],
    ['data-wistia-id', 'wistia'],
  ];
  const URL_ATTRS = [
    'src', 'data-src', 'data-lazy-src', 'data-url', 'data-video', 'data-video-url', 'data-video-src',
    'data-embed', 'data-embed-url', 'data-embed-src', 'data-iframe', 'data-iframe-src', 'data-href', 'data-mp4',
  ];

  function videoFromElement(el) {
    const tag = el.tagName;
    const title = clean(el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('data-title') || '');

    if (tag === 'VIDEO') {
      const sources = [...el.querySelectorAll('source[src]')].map((s) => ({ src: abs(s.getAttribute('src')), type: s.type || '' }));
      const src = el.currentSrc || el.getAttribute('src') || (sources[0] && sources[0].src) || '';
      const base = videoFromUrl(src, { source: 'video-tag' }) || {
        provider: 'HTML5 video', kind: 'video', id: '', url: abs(src), embedUrl: abs(src), source: 'video-tag',
      };
      if (!src) base.note = 'Video element without an exposed source URL.';
      base.poster = abs(el.getAttribute('poster'));
      base.sources = sources;
      base.title = title || base.title || '';
      if (el.duration && isFinite(el.duration)) base.durationSec = Math.round(el.duration);
      return base;
    }

    if (tag === 'AUDIO') return null;

    const candidates = [];
    if (tag === 'OBJECT') {
      candidates.push(el.getAttribute('data'));
      el.querySelectorAll('param[name="movie" i], param[name="src" i]').forEach((p) => candidates.push(p.getAttribute('value')));
    }
    for (const a of URL_ATTRS) if (el.hasAttribute(a)) candidates.push(el.getAttribute(a));
    for (const c of candidates) {
      const v = c && videoFromUrl(c, { source: tag === 'IFRAME' ? 'iframe' : tag === 'EMBED' || tag === 'OBJECT' ? 'embed' : 'attribute', title });
      if (v) return v;
    }

    const lowerTag = tag.toLowerCase();
    for (const [attr, kind] of ID_ATTRS) {
      const id = el.getAttribute(attr);
      if (!id) continue;
      if (kind === 'yt' || (kind === 'yt-if-tag' && (/youtube|yt/.test(lowerTag) || /youtube|yt-/.test(classOf(el)) || /^[\w-]{11}$/.test(id) && attr === 'videoid'))) {
        if (/^[\w-]{11}$/.test(id)) return videoFromUrl(`https://www.youtube.com/watch?v=${id}`, { source: 'attribute', title });
      }
      if (kind === 'vimeo' && /^\d+$/.test(id)) return videoFromUrl(`https://vimeo.com/${id}`, { source: 'attribute', title });
      if (kind === 'wistia') return videoFromUrl(`https://fast.wistia.net/embed/iframe/${id}`, { source: 'attribute', title });
    }
    // Brightcove <video-js data-account data-player data-video-id>
    if (el.hasAttribute('data-account') && el.hasAttribute('data-video-id')) {
      const account = el.getAttribute('data-account');
      const player = el.getAttribute('data-player') || 'default';
      const id = el.getAttribute('data-video-id');
      const url = `https://players.brightcove.net/${account}/${player}_default/index.html?videoId=${id}`;
      return { provider: 'Brightcove', kind: 'video', id, url, embedUrl: url, source: 'attribute', title };
    }
    // Wistia async embeds: class="wistia_embed wistia_async_abc123"
    const wistia = classOf(el).match(/wistia_async_([a-z0-9]+)/i);
    if (wistia) return videoFromUrl(`https://fast.wistia.net/embed/iframe/${wistia[1]}`, { source: 'attribute', title });
    return null;
  }

  const videoKey = (v) => (v.id ? `${v.provider}:${v.id}` : v.url || v.poster || `${v.provider}:${Math.random()}`);

  class VideoRegistry {
    constructor() {
      this.map = new Map();
    }
    add(v, patch = {}) {
      if (!v) return null;
      if (v.provider === 'HTML5 video (stream)' && !v.poster && !v.title && !patch.title) {
        // Only keep stream videos when we can say something about them.
        v.note = v.note || '';
      }
      const key = videoKey(v);
      const existing = this.map.get(key);
      if (existing) {
        for (const [k, val] of Object.entries({ ...v, ...patch })) {
          if (val && !existing[k]) existing[k] = val;
        }
        if (patch.inContent) existing.inContent = true;
        if (v.source !== 'link' && existing.source === 'link') existing.source = v.source;
        return existing;
      }
      const entry = { ...v, ...patch };
      this.map.set(key, entry);
      return entry;
    }
    list() {
      return [...this.map.values()].map((v) => ({ ...v, embedded: v.source !== 'link' }));
    }
  }

  function scanVideos(registry) {
    // 1. Iframes, embeds, objects, video tags and lazy-load facades anywhere on the page
    const selector = [
      'iframe', 'embed', 'object', 'video', 'lite-youtube', 'lite-vimeo', 'video-js',
      '[data-youtube-id]', '[data-ytid]', '[data-yt-id]', '[data-video-id]', '[data-videoid]', '[videoid]',
      '[data-vimeo-id]', '[data-wistia-id]', '[data-video-url]', '[data-video-src]', '[data-embed-url]', '[class*="wistia_async_"]',
    ].join(',');
    const roots = [document];
    document.querySelectorAll('*').forEach((el) => el.shadowRoot && roots.push(el.shadowRoot));
    for (const root of roots) {
      root.querySelectorAll(selector).forEach((el) => registry.add(videoFromElement(el)));
    }

    // 2. Metadata: Open Graph / Twitter player
    for (const name of ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player', 'twitter:player:stream']) {
      document.querySelectorAll(`meta[property="${name}" i], meta[name="${name}" i]`).forEach((m) => {
        registry.add(videoFromUrl(m.getAttribute('content'), { source: 'meta' }));
      });
    }

    // 3. Structured data (JSON-LD VideoObject)
    for (const obj of jsonLdObjects()) {
      if (!ldHasType(obj, 'VideoObject')) continue;
      const info = {
        title: obj.name || '',
        description: typeof obj.description === 'string' ? obj.description.slice(0, 500) : '',
        thumbnail: Array.isArray(obj.thumbnailUrl) ? obj.thumbnailUrl[0] : obj.thumbnailUrl || '',
        duration: obj.duration || '',
        uploadDate: obj.uploadDate || '',
      };
      const v = videoFromUrl(obj.embedUrl || obj.contentUrl || obj.url, { source: 'json-ld' });
      if (v) registry.add(v, info);
      else if (obj.embedUrl || obj.contentUrl) {
        const url = abs(obj.contentUrl || obj.embedUrl);
        registry.add({ provider: 'Video (structured data)', kind: 'video', id: '', url, embedUrl: abs(obj.embedUrl) || url, source: 'json-ld' }, info);
      }
    }

    // 4. The page itself may be a video page (e.g. a YouTube watch page)
    const self = videoFromUrl(location.href, { source: 'page', title: meta('og:title') || document.title });
    if (self && self.provider !== 'Video file') registry.add(self);

    // 5. Plain links pointing at video providers (reported separately as "linked")
    document.querySelectorAll('a[href]').forEach((a) => {
      const v = videoFromUrl(a.getAttribute('href'), { source: 'link', title: clean(a.textContent).slice(0, 120) });
      if (v && v.provider !== 'HTML5 video (stream)') registry.add(v);
    });
  }

  // ---------------------------------------------------------------------------
  // Main content detection
  // ---------------------------------------------------------------------------

  const NOISE_RE = /(^|[\s_-])(cookie|cookies|consent|gdpr|advert|advertisement|ads?|adslot|sponsor(ed)?|promo|newsletter|subscribe|share|sharing|social|socials|popup|modal|overlay|sidebar|breadcrumbs?|related|recommended|comments?|disqus|skip-link|visually-hidden|sr-only|screen-reader-text|toolbar|navbar|menu|footer)($|[\s_-])/i;
  const NOISE_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar']);
  const ALWAYS_SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'SVG', 'svg', 'CANVAS', 'BUTTON', 'INPUT',
    'SELECT', 'TEXTAREA', 'OPTION', 'MAP', 'AREA', 'MATH', 'SLOT', 'DIALOG',
  ]);
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I', 'KBD', 'LABEL', 'MARK', 'Q', 'S', 'SAMP',
    'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'BR', 'WBR', 'DEL', 'INS', 'FONT', 'STRIKE', 'TT', 'BIG', 'NOBR',
  ]);
  const BLOCK_SELECTOR = 'p,div,section,article,main,ul,ol,dl,table,h1,h2,h3,h4,h5,h6,pre,blockquote,figure,iframe,video,header,footer,li,form,hr,img,picture';

  function textScore(el) {
    let score = 0;
    el.querySelectorAll('p, li, pre, blockquote, td, h2, h3, h4, dd').forEach((n) => {
      score += clean(n.textContent).length;
    });
    const linkText = [...el.querySelectorAll('a')].reduce((n, a) => n + clean(a.textContent).length, 0);
    const total = clean(el.textContent).length || 1;
    return score * (1 - Math.min(0.9, linkText / total));
  }

  function findMainRoot() {
    const body = document.body;
    if (!body) return document.documentElement;
    const bodyScore = textScore(body) || 1;
    const selectors = [
      'article', 'main', '[role="main"]', '#content', '#main', '#main-content', '.post', '.article', '.entry-content',
      '.post-content', '.article-body', '.article-content', '.content', '.markdown-body', '.prose', '#bodyContent',
    ];
    let best = null;
    let bestScore = 0;
    for (const el of document.querySelectorAll(selectors.join(','))) {
      const s = textScore(el);
      if (s > bestScore) {
        best = el;
        bestScore = s;
      }
    }
    // A candidate covering too little of the readable text is probably a teaser/card.
    if (!best || bestScore < bodyScore * 0.35) return body;
    return best;
  }

  // ---------------------------------------------------------------------------
  // DOM -> blocks conversion
  // ---------------------------------------------------------------------------

  function isHidden(el, ctx) {
    if (el.hidden && !el.closest('details')) return true;
    if (el.getAttribute('aria-hidden') === 'true' && !el.querySelector('iframe, video')) return true;
    if (ctx.includeHidden || !el.checkVisibility) return false;
    if (el.checkVisibility({ visibilityProperty: true })) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'contents') return false;
    if (el.closest('details')) return false;
    return true;
  }

  function shouldSkip(el, ctx) {
    const tag = el.tagName;
    if (ALWAYS_SKIP.has(tag)) return true;
    if (isHidden(el, ctx)) return true;
    if (!ctx.main) return false;
    if (tag === 'NAV' || tag === 'ASIDE' || tag === 'FORM') return true;
    if (tag === 'FOOTER' && !el.closest('article')) return true;
    if (tag === 'HEADER' && !el.closest('article') && !el.querySelector('h1')) return true;
    const role = el.getAttribute('role');
    if (role && NOISE_ROLES.has(role)) return true;
    const sig = `${el.id || ''} ${classOf(el)}`;
    if (sig.trim() && NOISE_RE.test(sig)) {
      // Never drop a wrapper that holds most of the content.
      const len = clean(el.textContent).length;
      if (len < ctx.rootTextLength * 0.4) return true;
    }
    return false;
  }

  function isInlineElement(el) {
    if (INLINE_TAGS.has(el.tagName)) return !el.querySelector(BLOCK_SELECTOR);
    if (el.tagName.includes('-')) {
      if (videoFromElement(el)) return false; // video facades like <lite-youtube>
      const d = getComputedStyle(el).display;
      return d.startsWith('inline') && d !== 'inline-block' && !el.querySelector(BLOCK_SELECTOR);
    }
    return false;
  }

  function childNodesOf(el) {
    if (el.shadowRoot) return [...el.shadowRoot.childNodes];
    if (el.tagName === 'SLOT') return el.assignedNodes({ flatten: true });
    return [...el.childNodes];
  }

  function imageInfo(el) {
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    if (!img) return null;
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    let src = img.currentSrc || img.getAttribute('src') || '';
    if ((!src || src.startsWith('data:')) && lazy) src = lazy;
    src = abs(src);
    if (!src || src.startsWith('data:')) return null;
    const rect = img.getBoundingClientRect();
    const width = img.naturalWidth || Number(img.getAttribute('width')) || Math.round(rect.width);
    const height = img.naturalHeight || Number(img.getAttribute('height')) || Math.round(rect.height);
    // Tracking pixels / spacers / tiny icons
    if ((rect.width && rect.width < 24 && rect.height < 24) || (width && width <= 2) || (height && height <= 2)) return null;
    const link = img.closest('a[href]');
    return {
      src,
      alt: clean(img.getAttribute('alt')),
      title: clean(img.getAttribute('title')),
      width: width || 0,
      height: height || 0,
      href: link ? abs(link.getAttribute('href')) : '',
    };
  }

  const sameFormat = (a, b) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code && !!a.strike === !!b.strike && (a.href || '') === (b.href || '');

  function normalizeRuns(runs) {
    const out = [];
    for (const r of runs) {
      if (!r || !r.text) continue;
      let text = r.br || r.code ? r.text : r.text.replace(/[\s ]+/g, ' ');
      const prev = out[out.length - 1];
      const prevEndsSpace = !prev || prev.br || /\s$/.test(prev.text);
      if (!r.br && !r.code && prevEndsSpace) text = text.replace(/^ /, '');
      if (!text) continue;
      if (prev && !prev.br && !r.br && sameFormat(prev, r)) prev.text += text;
      else out.push({ ...r, text });
    }
    while (out.length && (out[0].br || !out[0].text.trim())) out.shift();
    while (out.length && (out[out.length - 1].br || !out[out.length - 1].text.trim())) out.pop();
    if (out.length) {
      out[0].text = out[0].text.replace(/^\s+/, '');
      const last = out[out.length - 1];
      last.text = last.text.replace(/\s+$/, '');
    }
    return out;
  }

  const runsText = (runs) => runs.map((r) => (r.br ? '\n' : r.text)).join('');

  function collectInlines(el, fmt, ctx) {
    const tag = el.tagName;
    if (tag === 'BR') return [{ text: '\n', br: true }];
    if (tag === 'WBR') return [];
    if (tag === 'IMG' || tag === 'PICTURE') {
      const info = imageInfo(el);
      if (info) {
        ctx.side.push({ type: 'image', ...info });
        ctx.images.push(info);
      } else if (el.alt && el.alt.length <= 3) {
        return [{ text: el.alt, ...fmt }]; // emoji images
      }
      return [];
    }
    if (tag === 'IFRAME' || tag === 'VIDEO' || tag === 'EMBED' || tag === 'OBJECT') {
      const v = videoFromElement(el);
      if (v) ctx.side.push({ type: 'video', ...ctx.videos.add(v, { inContent: true }) });
      return [];
    }
    const f = { ...fmt };
    if (tag === 'B' || tag === 'STRONG') f.bold = true;
    if (tag === 'I' || tag === 'EM' || tag === 'CITE' || tag === 'DFN') f.italic = true;
    if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') f.strike = true;
    if (tag === 'A' && el.hasAttribute('href')) {
      const href = abs(el.getAttribute('href'));
      if (href && !href.startsWith('javascript:')) {
        f.href = href;
        const text = clean(el.textContent);
        if (text && !ctx.linkSet.has(href)) {
          ctx.linkSet.add(href);
          ctx.links.push({ text: text.slice(0, 200), href });
        }
      }
    }
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') {
      return [{ text: el.textContent, ...f, code: true }];
    }
    const out = [];
    const isBlock = !INLINE_TAGS.has(tag) && !tag.includes('-');
    if (isBlock) out.push({ text: ' ', ...fmt });
    for (const child of childNodesOf(el)) {
      if (child.nodeType === Node.TEXT_NODE) out.push({ text: child.nodeValue, ...f });
      else if (child.nodeType === Node.ELEMENT_NODE && !shouldSkip(child, ctx)) out.push(...collectInlines(child, f, ctx));
    }
    if (isBlock) out.push({ text: ' ', ...fmt });
    if (tag === 'SUP' && out.length) return [{ text: `^${runsText(normalizeRuns(out))}`, ...f }];
    return out;
  }

  function convertChildren(parent, ctx, exclude) {
    const blocks = [];
    let inline = [];
    const drain = () => {
      while (ctx.side.length) blocks.push(ctx.side.shift());
    };
    const flush = () => {
      const runs = normalizeRuns(inline);
      inline = [];
      if (runs.length) blocks.push({ type: 'paragraph', inlines: runs });
      drain();
    };
    for (const child of childNodesOf(parent)) {
      if (child === exclude) continue;
      if (child.nodeType === Node.TEXT_NODE) {
        inline.push({ text: child.nodeValue });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE || shouldSkip(child, ctx)) continue;
      if (isInlineElement(child)) {
        inline.push(...collectInlines(child, {}, ctx));
        continue;
      }
      flush();
      blocks.push(...convertElement(child, ctx));
      drain();
    }
    flush();
    return blocks;
  }

  function listBlock(el, ctx) {
    const items = [];
    for (const child of el.children) {
      if (shouldSkip(child, ctx)) continue;
      const blocks = convertChildren(child, ctx);
      const item = { inlines: [], blocks };
      if (blocks[0] && blocks[0].type === 'paragraph') item.inlines = blocks.shift().inlines;
      if (item.inlines.length || item.blocks.length) items.push(item);
    }
    if (!items.length) return [];
    return [{ type: 'list', ordered: el.tagName === 'OL', start: el.tagName === 'OL' ? el.start || 1 : undefined, items }];
  }

  function definitionList(el, ctx) {
    const items = [];
    let current = null;
    for (const child of el.querySelectorAll(':scope > dt, :scope > dd, :scope > div > dt, :scope > div > dd')) {
      const runs = normalizeRuns(collectInlines(child, {}, ctx));
      if (!runs.length) continue;
      if (child.tagName === 'DT') {
        current = { inlines: runs.map((r) => ({ ...r, bold: true })), blocks: [] };
        items.push(current);
      } else if (current) {
        current.inlines.push({ text: ': ' }, ...runs);
      } else {
        items.push({ inlines: runs, blocks: [] });
      }
    }
    return items.length ? [{ type: 'list', ordered: false, items }] : [];
  }

  function tableBlock(el, ctx) {
    const isLayout = el.getAttribute('role') === 'presentation' || el.querySelector('table') ||
      [...el.rows].every((r) => r.cells.length <= 1);
    if (isLayout) {
      const blocks = [];
      for (const row of el.rows) for (const cell of row.cells) blocks.push(...convertChildren(cell, ctx));
      return blocks;
    }
    const rows = [];
    for (const row of el.rows) {
      if (shouldSkip(row, ctx)) continue;
      const cells = [];
      for (const cell of row.cells) {
        const inlines = normalizeRuns(collectInlines(cell, {}, ctx));
        cells.push({ inlines });
        for (let i = 1; i < Math.min(cell.colSpan || 1, 20); i++) cells.push({ inlines: [] });
      }
      const header = row.parentElement.tagName === 'THEAD' || [...row.cells].every((c) => c.tagName === 'TH');
      if (cells.some((c) => c.inlines.length)) rows.push({ header, cells });
    }
    if (!rows.length) return [];
    const caption = el.caption ? clean(el.caption.textContent) : '';
    return [{ type: 'table', caption, rows }];
  }

  function codeLang(el) {
    const code = el.querySelector('code');
    const sig = `${classOf(el)} ${code ? classOf(code) : ''} ${el.getAttribute('data-lang') || ''} ${el.getAttribute('data-language') || ''}`;
    const m = sig.match(/(?:language|lang|highlight-source)-([\w+#.-]+)/i) || sig.match(/^\s*([\w+#-]+)\s*$/);
    return m ? m[1].toLowerCase() : '';
  }

  function convertElement(el, ctx) {
    const tag = el.tagName;
    switch (tag) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const inlines = normalizeRuns(collectInlines(el, {}, ctx)).map((r) => ({ ...r, bold: false }));
        const text = clean(runsText(inlines));
        if (!text) return [];
        const level = Number(tag[1]);
        ctx.headings.push({ level, text });
        return [{ type: 'heading', level, text, inlines }];
      }
      case 'UL': case 'OL': case 'MENU':
        return listBlock(el, ctx);
      case 'DL':
        return definitionList(el, ctx);
      case 'PRE': {
        const text = el.textContent.replace(/^\n+|\s+$/g, '');
        return text ? [{ type: 'code', lang: codeLang(el), text }] : [];
      }
      case 'BLOCKQUOTE': {
        const blocks = convertChildren(el, ctx);
        return blocks.length ? [{ type: 'quote', blocks }] : [];
      }
      case 'TABLE':
        return tableBlock(el, ctx);
      case 'IMG': case 'PICTURE': {
        const info = imageInfo(el);
        if (!info) return [];
        ctx.images.push(info);
        return [{ type: 'image', ...info }];
      }
      case 'FIGURE': {
        const captionEl = el.querySelector(':scope > figcaption');
        const blocks = convertChildren(el, ctx, captionEl);
        const caption = captionEl ? clean(captionEl.textContent) : '';
        if (caption) {
          const media = [...blocks].reverse().find((b) => b.type === 'image' || b.type === 'video');
          if (media) {
            media.caption = caption;
            const img = ctx.images.find((i) => i.src === media.src);
            if (img) img.caption = caption;
          } else blocks.push({ type: 'paragraph', inlines: [{ text: caption, italic: true }] });
        }
        return blocks;
      }
      case 'IFRAME': case 'VIDEO': case 'EMBED': case 'OBJECT': {
        const v = videoFromElement(el);
        if (v) return [{ type: 'video', ...ctx.videos.add(v, { inContent: true }) }];
        const src = abs(el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data'));
        if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) {
          return [{ type: 'embed', src, title: clean(el.getAttribute('title') || el.getAttribute('aria-label') || '') }];
        }
        return [];
      }
      case 'AUDIO': {
        const src = abs(el.currentSrc || el.getAttribute('src') || el.querySelector('source')?.getAttribute('src'));
        return src ? [{ type: 'embed', src, title: clean(el.getAttribute('title') || 'Audio'), kind: 'audio' }] : [];
      }
      case 'HR':
        return [{ type: 'hr' }];
      case 'DETAILS': {
        const summary = el.querySelector(':scope > summary');
        const blocks = [];
        if (summary) {
          const runs = normalizeRuns(collectInlines(summary, {}, ctx));
          if (runs.length) blocks.push({ type: 'paragraph', inlines: runs.map((r) => ({ ...r, bold: true })) });
        }
        return blocks.concat(convertChildren(el, ctx, summary));
      }
      default: {
        {
          const v = videoFromElement(el);
          if (v) return [{ type: 'video', ...ctx.videos.add(v, { inContent: true }) }];
        }
        return convertChildren(el, ctx);
      }
    }
  }

  // Removes paragraphs that merely repeat the heading/title and empty structures.
  function tidyBlocks(blocks, title) {
    const out = [];
    let lastText = '';
    for (const b of blocks) {
      const text = b.type === 'paragraph' ? clean(runsText(b.inlines)) : b.type === 'heading' ? b.text : '';
      if (text && text === lastText) continue; // duplicated (e.g. responsive copies)
      if (text) lastText = text;
      out.push(b);
    }
    // Drop a leading H1 identical to the title (renderers add the title themselves).
    const first = out.findIndex((b) => b.type === 'heading');
    if (first !== -1 && first < 3 && out[first].level === 1 && clean(out[first].text).toLowerCase() === clean(title).toLowerCase()) {
      out[first].isTitle = true;
    }
    return out;
  }

  function countWords(text) {
    const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
    const words = (text.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').match(/\S+/g) || []).length;
    return words + Math.round(cjk / 2);
  }

  function blocksText(blocks) {
    const parts = [];
    const walk = (list) => {
      for (const b of list) {
        if (b.inlines) parts.push(runsText(b.inlines));
        if (b.text && b.type === 'code') parts.push(b.text);
        if (b.blocks) walk(b.blocks);
        if (b.items) b.items.forEach((i) => { parts.push(runsText(i.inlines)); walk(i.blocks); });
        if (b.rows) b.rows.forEach((r) => r.cells.forEach((c) => parts.push(runsText(c.inlines))));
      }
    };
    walk(blocks);
    return parts.join('\n');
  }

  function pageMetadata() {
    const ld = jsonLdObjects();
    const article = ld.find((o) => ['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'ScholarlyArticle', 'WebPage', 'Course', 'HowTo'].some((t) => ldHasType(o, t))) || {};
    const h1 = document.querySelector('h1');
    const h1Text = h1 ? clean(h1.textContent) : '';
    const docTitle = clean(document.title);
    // "Article | Site" titles: prefer the H1 when the <title> just adds a suffix.
    const title = meta('og:title', 'twitter:title') || (h1Text && docTitle.includes(h1Text) ? h1Text : docTitle) || h1Text || location.href;
    const icon = document.querySelector('link[rel~="icon" i], link[rel="shortcut icon" i], link[rel="apple-touch-icon" i]');
    const keywords = meta('keywords', 'news_keywords').split(',').map(clean).filter(Boolean);
    const sections = [...document.querySelectorAll('meta[property="article:tag" i]')].map((m) => clean(m.content)).filter(Boolean);
    const timeEl = document.querySelector('article time[datetime], time[datetime]');
    return {
      url: location.href,
      canonical: abs(document.querySelector('link[rel="canonical" i]')?.getAttribute('href')) || '',
      title,
      description: meta('description', 'og:description', 'twitter:description') || (typeof article.description === 'string' ? article.description : ''),
      siteName: meta('og:site_name', 'application-name') || ldName(article.publisher) || location.hostname.replace(/^www\./, ''),
      author: meta('author', 'article:author', 'parsely-author', 'sailthru.author') || ldName(article.author) ||
        clean(document.querySelector('[rel="author"], .author, .byline, [itemprop="author"]')?.textContent || '').slice(0, 120),
      published: meta('article:published_time', 'datePublished', 'date', 'pubdate') || article.datePublished || timeEl?.getAttribute('datetime') || '',
      modified: meta('article:modified_time', 'dateModified', 'og:updated_time') || article.dateModified || '',
      lang: document.documentElement.lang || meta('og:locale') || '',
      keywords: [...new Set([...keywords, ...sections])].slice(0, 30),
      image: abs(meta('og:image', 'twitter:image')) || '',
      favicon: abs(icon?.getAttribute('href')) || abs('/favicon.ico'),
      domain: location.hostname,
    };
  }

  function extractPage(options = {}) {
    const scope = options.scope === 'full' ? 'full' : 'main';
    const root = scope === 'full' ? document.body : findMainRoot();
    const videos = new VideoRegistry();
    const ctx = {
      main: scope === 'main',
      includeHidden: !!options.includeHidden,
      rootTextLength: clean(root.textContent).length,
      side: [],
      images: [],
      links: [],
      linkSet: new Set(),
      headings: [],
      videos,
    };
    const meta = pageMetadata();

    let blocks = convertChildren(root, ctx);
    // If the chosen root missed the H1 (common: title above <article>), prepend it.
    if (scope === 'main' && !ctx.headings.some((h) => h.level === 1)) {
      const h1 = document.querySelector('h1');
      if (h1 && !root.contains(h1) && !isHidden(h1, ctx)) {
        const text = clean(h1.textContent);
        if (text) {
          blocks.unshift({ type: 'heading', level: 1, text, inlines: [{ text }] });
          ctx.headings.unshift({ level: 1, text });
        }
      }
    }
    blocks = tidyBlocks(blocks, meta.title);
    scanVideos(videos); // whole page: catches players outside the main content too

    const text = blocksText(blocks);
    const words = countWords(text);
    const videoList = videos.list();
    return {
      version: 1,
      ...meta,
      collectedAt: new Date().toISOString(),
      scope,
      blocks,
      headings: ctx.headings,
      videos: videoList,
      images: ctx.images,
      links: ctx.links.slice(0, 400),
      stats: {
        words,
        readingMinutes: Math.max(1, Math.round(words / 220)),
        images: ctx.images.length,
        videos: videoList.filter((v) => v.embedded).length,
        linkedVideos: videoList.filter((v) => !v.embedded).length,
        links: ctx.links.length,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Site kit (everything needed to recreate the page)
  // ---------------------------------------------------------------------------

  const rulesText = (sheet) => {
    try {
      return [...sheet.cssRules].map((r) => r.cssText).join('\n');
    } catch {
      return null; // cross-origin stylesheet: the offscreen builder fetches it instead
    }
  };

  function toHex(color) {
    const m = color && color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
    if (!m) return color;
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a === 0) return 'transparent';
    const hex = [m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('');
    return a < 1 ? `#${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}` : `#${hex}`;
  }

  function topCounts(map, n = 15) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));
  }

  function bump(map, key, by = 1) {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + by);
  }

  function collectSheets() {
    const styleEls = [...document.querySelectorAll('style')];
    const sheets = [];
    for (const sheet of document.styleSheets) {
      const owner = sheet.ownerNode;
      const entry = {
        href: sheet.href || '',
        media: sheet.media ? sheet.media.mediaText : '',
        disabled: sheet.disabled,
        ownerTag: owner ? owner.tagName : '',
      };
      if (!sheet.href && owner && owner.tagName === 'STYLE') {
        entry.styleIndex = styleEls.indexOf(owner);
        const own = owner.textContent.trim();
        entry.text = own || rulesText(sheet) || '';
        entry.injected = !own && !!entry.text; // CSS-in-JS (rules inserted via insertRule)
      } else {
        entry.fallbackText = rulesText(sheet);
      }
      sheets.push(entry);
    }
    for (const sheet of document.adoptedStyleSheets || []) {
      sheets.push({ href: '', adopted: true, text: rulesText(sheet) || '' });
    }
    return sheets;
  }

  function cssVariablesAndMedia() {
    const vars = new Map();
    const media = new Map();
    const rootStyle = getComputedStyle(document.documentElement);
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.style && /^(:root|html|body|:host)\b/.test(rule.selectorText || '')) {
          for (const prop of rule.style) {
            if (prop.startsWith('--') && vars.size < 600) {
              vars.set(prop, (rootStyle.getPropertyValue(prop) || rule.style.getPropertyValue(prop)).trim());
            }
          }
        }
        if (rule.media && rule.conditionText) {
          (rule.conditionText.match(/(min|max)-width:\s*[\d.]+(px|em|rem)/g) || []).forEach((q) => bump(media, q.replace(/\s+/g, ' ')));
        }
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch {
        /* cross-origin */
      }
    }
    return {
      cssVariables: Object.fromEntries(vars),
      breakpoints: topCounts(media, 20),
    };
  }

  function designTokens() {
    const colors = new Map();
    const backgrounds = new Map();
    const borders = new Map();
    const families = new Map();
    const sizes = new Map();
    const weights = new Map();
    const radii = new Map();
    const shadows = new Map();
    const maxWidths = new Map();
    const gaps = new Map();
    const all = document.body ? document.body.querySelectorAll('*') : [];
    let sampled = 0;
    for (const el of all) {
      if (sampled > 5000) break;
      if (ALWAYS_SKIP.has(el.tagName)) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      sampled++;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim());
      if (hasText) {
        bump(colors, toHex(cs.color));
        bump(families, cs.fontFamily);
        bump(sizes, cs.fontSize);
        bump(weights, cs.fontWeight);
      }
      const bg = toHex(cs.backgroundColor);
      if (bg && bg !== 'transparent') bump(backgrounds, bg, Math.max(1, Math.round((rect.width * rect.height) / 10000)));
      if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') bump(borders, toHex(cs.borderTopColor));
      if (cs.borderRadius && cs.borderRadius !== '0px') bump(radii, cs.borderRadius);
      if (cs.boxShadow && cs.boxShadow !== 'none') bump(shadows, cs.boxShadow);
      if (cs.maxWidth && cs.maxWidth !== 'none' && cs.maxWidth.endsWith('px')) bump(maxWidths, cs.maxWidth);
      if ((cs.display.includes('flex') || cs.display.includes('grid')) && cs.gap && cs.gap !== 'normal' && cs.gap !== '0px') bump(gaps, cs.gap);
    }

    const typography = {};
    for (const sel of ['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'li', 'button', 'small', 'code', 'blockquote', 'input']) {
      const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().height > 0);
      if (!el) continue;
      const cs = getComputedStyle(el);
      typography[sel] = {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        textTransform: cs.textTransform,
        color: toHex(cs.color),
        background: toHex(cs.backgroundColor),
        margin: cs.margin,
        padding: sel === 'button' || sel === 'input' ? cs.padding : undefined,
        borderRadius: sel === 'button' || sel === 'input' ? cs.borderRadius : undefined,
        textDecoration: sel === 'a' ? cs.textDecorationLine : undefined,
      };
    }

    return {
      textColors: topCounts(colors, 15),
      backgroundColors: topCounts(backgrounds, 15),
      borderColors: topCounts(borders, 10),
      fontFamilies: topCounts(families, 8),
      fontSizes: topCounts(sizes, 15),
      fontWeights: topCounts(weights, 8),
      borderRadii: topCounts(radii, 10),
      boxShadows: topCounts(shadows, 8),
      containerMaxWidths: topCounts(maxWidths, 8),
      layoutGaps: topCounts(gaps, 10),
      typography,
      ...cssVariablesAndMedia(),
    };
  }

  function layoutTree() {
    let count = 0;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const SEMANTIC = new Set(['HEADER', 'NAV', 'MAIN', 'SECTION', 'ARTICLE', 'ASIDE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'IMG', 'VIDEO', 'IFRAME', 'UL', 'OL', 'TABLE', 'BUTTON', 'A']);
    const node = (el, depth) => {
      if (count > 900 || depth > 9 || ALWAYS_SKIP.has(el.tagName) && el.tagName !== 'BUTTON') return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return null;
      count++;
      const out = {
        tag: el.tagName.toLowerCase(),
        rect: { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) },
      };
      if (el.id) out.id = el.id;
      const cls = classOf(el).split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
      if (cls) out.class = cls;
      const role = el.getAttribute('role');
      if (role) out.role = role;
      out.display = cs.display;
      if (cs.position !== 'static') out.position = cs.position;
      if (cs.display.includes('flex')) out.flex = { direction: cs.flexDirection, wrap: cs.flexWrap, justify: cs.justifyContent, align: cs.alignItems, gap: cs.gap };
      if (cs.display.includes('grid')) out.grid = { columns: cs.gridTemplateColumns, rows: cs.gridTemplateRows, gap: cs.gap };
      const bg = toHex(cs.backgroundColor);
      if (bg !== 'transparent') out.background = bg;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') out.backgroundImage = cs.backgroundImage.slice(0, 300);
      const own = clean([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue).join(' '));
      if (own) out.text = own.slice(0, 100);
      if (el.tagName === 'IMG') out.src = abs(el.currentSrc || el.getAttribute('src'));
      if (el.tagName === 'A') out.href = abs(el.getAttribute('href'));
      const kids = [];
      for (const child of el.children) {
        const cr = child.getBoundingClientRect();
        if (cr.width * cr.height < 300 && !SEMANTIC.has(child.tagName)) continue;
        const k = node(child, depth + 1);
        if (k) kids.push(k);
      }
      if (kids.length) out.children = kids;
      return out;
    };
    return document.body ? node(document.body, 0) : null;
  }

  function pageSections() {
    const vw = document.documentElement.clientWidth;
    let container = document.body;
    // Descend through single-child wrappers until the page splits into sections.
    for (let i = 0; i < 8; i++) {
      const big = [...container.children].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.height > 40 && r.width > vw * 0.5 && !ALWAYS_SKIP.has(c.tagName);
      });
      if (big.length === 1) container = big[0];
      else break;
    }
    const sy = window.scrollY;
    return [...container.children]
      .filter((c) => {
        const r = c.getBoundingClientRect();
        return r.height > 20 && r.width > 0 && !ALWAYS_SKIP.has(c.tagName);
      })
      .slice(0, 40)
      .map((el, i) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const heading = el.querySelector('h1, h2, h3, h4');
        return {
          index: i + 1,
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          class: classOf(el).split(/\s+/).filter(Boolean).slice(0, 5).join(' '),
          top: Math.round(r.top + sy),
          height: Math.round(r.height),
          width: Math.round(r.width),
          background: toHex(cs.backgroundColor),
          backgroundImage: cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 200) : '',
          heading: heading ? clean(heading.textContent).slice(0, 120) : '',
          textSample: clean(el.innerText || '').slice(0, 240),
          images: el.querySelectorAll('img, picture, svg').length,
          links: el.querySelectorAll('a').length,
          buttons: el.querySelectorAll('button, [role="button"], .btn, .button').length,
          forms: el.querySelectorAll('form').length,
          layout: cs.display.includes('grid') ? `grid (${cs.gridTemplateColumns})` : cs.display.includes('flex') ? `flex ${cs.flexDirection}` : cs.display,
        };
      });
  }

  function detectTech() {
    const found = new Set();
    const html = document.documentElement.outerHTML.slice(0, 2_000_000);
    const scripts = [...document.scripts].map((s) => s.src).join(' ');
    const links = [...document.querySelectorAll('link[href]')].map((l) => l.href).join(' ');
    const has = (sel) => !!document.querySelector(sel);
    const generator = meta('generator');
    if (generator) found.add(`Generator: ${generator}`);
    if (has('#__next') || has('script#__NEXT_DATA__') || /\/_next\//.test(scripts)) found.add('Next.js (React)');
    else if (has('[data-reactroot], [data-reactid]') || /react(-dom)?(\.production)?(\.min)?\.js/.test(scripts)) found.add('React');
    if (has('#__nuxt, #__layout') || /\/_nuxt\//.test(scripts)) found.add('Nuxt (Vue)');
    else if (/\sdata-v-[0-9a-f]{6,8}/.test(html) || has('[data-v-app]')) found.add('Vue');
    if (has('[ng-version]')) found.add(`Angular ${document.querySelector('[ng-version]').getAttribute('ng-version')}`);
    if (/class="[^"]*\bsvelte-[a-z0-9]+/.test(html)) found.add('Svelte');
    if (has('#___gatsby')) found.add('Gatsby (React)');
    if (has('astro-island') || /\/_astro\//.test(scripts + links)) found.add('Astro');
    if (/\/wp-content\/|\/wp-includes\//.test(scripts + links)) found.add('WordPress');
    if (/cdn\.shopify\.com/.test(scripts + links)) found.add('Shopify');
    if (has('html[data-wf-page], html[data-wf-site]')) found.add('Webflow');
    if (/squarespace/.test(scripts + links)) found.add('Squarespace');
    if (/wix(static)?\.com/.test(scripts + links)) found.add('Wix');
    if (/framerusercontent|framer\.com/.test(scripts + links)) found.add('Framer');
    if (/ghost/.test(generator.toLowerCase())) found.add('Ghost');
    if (/jquery/i.test(scripts)) found.add('jQuery');
    if (/bootstrap/i.test(scripts + links) || (has('.container .row') && has('[class*="col-"]'))) found.add('Bootstrap');
    const twHits = (html.match(/class="[^"]*\b(?:flex|grid|px-\d|py-\d|mt-\d|text-(?:sm|lg|xl)|bg-[a-z]+-\d{2,3}|rounded-(?:md|lg|xl)|md:|lg:)/g) || []).length;
    if (twHits > 15) found.add('Tailwind CSS (utility classes detected)');
    if (/fonts\.googleapis\.com/.test(links)) found.add('Google Fonts');
    if (/use\.typekit\.net/.test(links + scripts)) found.add('Adobe Fonts (Typekit)');
    if (/font-?awesome/i.test(links + scripts)) found.add('Font Awesome');
    if (/googletagmanager|google-analytics/.test(scripts)) found.add('Google Analytics / Tag Manager');
    if (/gsap|greensock/i.test(scripts)) found.add('GSAP animations');
    if (/swiper/i.test(scripts + links) || has('.swiper')) found.add('Swiper (carousel)');
    if (/alpine/i.test(scripts) || has('[x-data]')) found.add('Alpine.js');
    if (/htmx/i.test(scripts) || has('[hx-get], [hx-post]')) found.add('htmx');
    return [...found];
  }

  function forms() {
    return [...document.forms].slice(0, 20).map((f) => ({
      id: f.id || '',
      action: f.getAttribute('action') ? abs(f.getAttribute('action')) : '',
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      fields: [...f.elements].slice(0, 50).map((el) => {
        const label = el.labels && el.labels[0] ? clean(el.labels[0].textContent) : '';
        return {
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          name: el.name || '',
          label,
          placeholder: el.getAttribute('placeholder') || '',
          required: !!el.required,
        };
      }),
    }));
  }

  // Serializes the DOM including open shadow roots (as declarative shadow DOM).
  function serializeDocument() {
    const root = document.documentElement;
    if (typeof root.getHTML !== 'function') return root.outerHTML;
    const shadowRoots = [];
    const walk = (node) => {
      node.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) {
          shadowRoots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      });
    };
    walk(document);
    if (!shadowRoots.length) return root.outerHTML;
    const open = root.outerHTML.match(/^<html[^>]*>/i)?.[0] || '<html>';
    return `${open}${root.getHTML({ shadowRoots })}</html>`;
  }

  function extractSiteKit(options = {}) {
    const content = extractPage(options);
    const fonts = [];
    try {
      document.fonts.forEach((f) => fonts.push({ family: f.family.replace(/["']/g, ''), style: f.style, weight: f.weight, status: f.status }));
    } catch {
      /* FontFaceSet not iterable in very old pages */
    }
    const doctype = document.doctype
      ? `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC "${document.doctype.publicId}"` : ''}${document.doctype.systemId ? ` "${document.doctype.systemId}"` : ''}>`
      : '<!DOCTYPE html>';
    return {
      content,
      html: `${doctype}\n${serializeDocument()}`,
      baseUrl: document.baseURI,
      stylesheets: collectSheets(),
      scripts: [...document.scripts].map((s) => ({
        src: s.src || '',
        type: s.type || '',
        async: s.async,
        defer: s.defer,
        inlineLength: s.src ? 0 : s.textContent.length,
      })),
      fonts,
      designTokens: designTokens(),
      sections: pageSections(),
      layout: layoutTree(),
      tech: detectTech(),
      forms: forms(),
      metaTags: [...document.querySelectorAll('meta')].map((m) => ({
        name: m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv') || m.getAttribute('charset') && 'charset' || '',
        content: m.getAttribute('content') || m.getAttribute('charset') || '',
      })).filter((m) => m.name),
      icons: [...document.querySelectorAll('link[rel~="icon" i], link[rel="apple-touch-icon" i], link[rel="mask-icon" i], link[rel="manifest" i]')]
        .map((l) => ({ rel: l.rel, href: abs(l.getAttribute('href')), sizes: l.getAttribute('sizes') || '' })),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
      },
    };
  }

  // Scrolls through the page so lazy-loaded images/sections render, then returns to the top.
  async function autoScroll(maxSteps = 40) {
    const step = Math.max(300, Math.round(window.innerHeight * 0.85));
    for (let i = 0; i < maxSteps; i++) {
      const before = window.scrollY;
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 250));
      if (window.scrollY === before) break;
    }
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
    return true;
  }

  // --- Full-page screenshot helpers (driven step by step from the service worker)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function screenshotPlan() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      total: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      dpr: window.devicePixelRatio || 1,
    };
  }

  async function scrollToY(y) {
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    await sleep(350);
    return window.scrollY;
  }

  // Sticky/fixed headers would repeat in every slice; hide them after the first one.
  function hideFixed(hide) {
    if (hide) {
      for (const el of document.querySelectorAll('body *')) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          el.setAttribute('data-wcc-vis', el.style.visibility || '');
          el.style.visibility = 'hidden';
        }
      }
    } else {
      document.querySelectorAll('[data-wcc-vis]').forEach((el) => {
        el.style.visibility = el.getAttribute('data-wcc-vis');
        el.removeAttribute('data-wcc-vis');
      });
    }
    return true;
  }

  window.__webCollector = { extractPage, extractSiteKit, autoScroll, screenshotPlan, scrollToY, hideFixed };
})();
