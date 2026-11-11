// Media Downloader — frontend. Vanilla ES module, no dependencies.
//
// Sections:
//   1. Helpers (DOM, formatting, parsing)
//   2. API + shared state
//   3. Segmented control
//   4. Hero: link field, probing, multi-link queue
//   5. Bench: stage, preview, timeline, specs, download
//   6. Playlist
//   7. Ledger
//   8. Settings sheet + engine
//   9. Server events, keyboard, init

/* ───────────────────────── 1. Helpers ───────────────────────── */

const el = {};
for (const node of document.querySelectorAll('[id]')) el[node.id] = node;

// Windows: no Safari, Explorer instead of Finder, Windows-style paths.
const IS_WIN = /Windows/.test(navigator.userAgent);
if (IS_WIN) {
  document.documentElement.classList.add('is-win');
  el.setBrowser?.querySelector('option[value="safari"]')?.remove();
  if (el.setCookieFile) el.setCookieFile.placeholder = 'C:\\Users\\you\\cookies.txt';
  if (el.cookieHelp) el.cookieHelp.textContent = 'Used only as a fallback when a site demands sign-in. Firefox works best: Chrome and Edge lock their cookies while open, so close them first or export a cookies.txt.';
}

function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setText(node, text) {
  const s = text == null ? '' : String(text);
  if (node.textContent !== s) node.textContent = s;
}
function show(node, on) {
  const hide = !on;
  if (node.hidden !== hide) node.hidden = hide;
}
function setVal(input, value) {
  if (document.activeElement === input) return; // never fight the user's typing
  const s = value == null ? '' : String(value);
  if (input.value !== s) input.value = s;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 83.5 → "1:23.5", 3723 → "1:02:03.0". With tenths=false → "1:23". */
function fmtClock(sec, tenths = true) {
  if (sec == null || !isFinite(sec)) return '';
  let t = Math.round(Math.max(0, Number(sec)) * 10); // tenths of a second
  if (!tenths) t = Math.round(t / 10) * 10;
  const d = t % 10; t = (t - d) / 10;
  const s = t % 60; t = (t - s) / 60;
  const m = t % 60;
  const hrs = (t - m) / 60;
  const tail = tenths ? '.' + d : '';
  return hrs > 0 ? `${hrs}:${pad2(m)}:${pad2(s)}${tail}` : `${m}:${pad2(s)}${tail}`;
}

/** Accepts "83.5", "1:23.5", "1:02:03". Returns seconds or null. */
function parseClock(str) {
  const s = String(str == null ? '' : str).trim().replace(',', '.');
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const ok = last ? /^(\d+\.?\d*|\.\d+)$/.test(parts[i]) : /^\d+$/.test(parts[i]);
    if (!ok) return null;
    total = total * 60 + parseFloat(parts[i]);
  }
  return isFinite(total) ? total : null;
}

function fmtBytes(bytes) {
  const b = Number(bytes);
  if (!isFinite(b) || b <= 0) return '';
  const mb = b / 1048576;
  if (mb >= 1000) { const gb = mb / 1024; return gb.toFixed(gb >= 10 ? 1 : 2) + ' GB'; }
  if (mb >= 100) return Math.round(mb) + ' MB';
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}
function fmtSpeed(bps) {
  const b = Number(bps);
  if (bps == null || !isFinite(b) || b <= 0) return '';
  const mb = b / 1048576;
  return mb >= 1 ? mb.toFixed(1) + ' MB/s' : Math.max(1, Math.round(b / 1024)) + ' KB/s';
}
function fmtEta(sec) {
  const s = Number(sec);
  if (sec == null || !isFinite(s) || s < 0) return '';
  if (s < 60) return Math.max(1, Math.round(s)) + ' s left';
  if (s < 3600) return Math.round(s / 60) + ' min left';
  const hrs = Math.floor(s / 3600);
  const min = Math.round((s - hrs * 3600) / 60);
  return min ? `${hrs} h ${min} min left` : `${hrs} h left`;
}

const thumbUrl = (remote) => (remote ? '/api/thumb?u=' + encodeURIComponent(remote) : '');

/** Pull every link out of a blob of text. Links without a scheme get https://. */
function extractUrls(text) {
  const out = [];
  for (let tok of String(text || '').split(/\s+/)) {
    tok = tok.replace(/^[<("'\[]+/, '').replace(/[>)"'\],;.]+$/, '');
    if (!tok) continue;
    let cand = null;
    if (/^https?:\/\//i.test(tok)) cand = tok;
    else if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(tok)) cand = 'https://' + tok;
    if (!cand) continue;
    try {
      const u = new URL(cand);
      if (u.hostname.includes('.') && !out.includes(u.href)) out.push(u.href);
    } catch { /* not a link */ }
  }
  return out;
}

const isTypingTarget = (t) =>
  !!t && t.nodeType === 1 && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

const errText = (err) => [err && err.message, err && err.hint].filter(Boolean).join(' ');

/* ───────────────────────── 2. API + state ───────────────────────── */

class ApiError extends Error {
  constructor(message, hint) { super(message); this.hint = hint || ''; }
}

async function api(method, path, body, signal) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError('The downloader is not responding.', 'Check that the server is still running, then try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const er = (data && data.error) || {};
    throw new ApiError(er.message || `The request failed (${res.status}).`, er.hint || '');
  }
  return data || {};
}
const post = (path, body = {}, signal) => api('POST', path, body, signal);

const VIDEO_FORMATS = [{ value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV' }];
const AUDIO_FORMATS = [{ value: 'mp3', label: 'MP3' }, { value: 'm4a', label: 'M4A' }, { value: 'wav', label: 'WAV' }];
const OFF_ON = [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }];
const PLAYLIST_HEIGHTS = [2160, 1440, 1080, 720, 480];

const state = {
  loaded: false,
  settings: {},
  engine: null,
  // The user's last format choices; persisted as settings.preset.
  fmt: { kind: 'video', height: null, container: 'mp4', audioFormat: 'mp3' },
  exact: true,   // Cut: exact or fast
  subs: false,   // Subtitles toggle (per session)
  probe: null,   // { token, ctrl }
};

function setFmt(patch) {
  Object.assign(state.fmt, patch);
  renderBenchSpecs();
  renderPlaylistSpecs();
  clearTimeout(setFmt.timer);
  setFmt.timer = setTimeout(() => saveSettings({ preset: { ...state.fmt } }, true), 250);
}

/** Body for POST /api/download, shared by the bench, playlists and multi-link paste. */
function downloadBody(src, { kind, height, trim = null, subtitles = false }) {
  return {
    url: src.url,
    title: src.title || src.url,
    thumbnail: src.thumbnail || null,
    site: src.site || null,
    duration: src.duration == null ? null : src.duration,
    strategy: src.strategy || null,
    referer: src.referer || null,
    playlistItem: src.playlistItem == null ? null : src.playlistItem,
    kind,
    height: kind === 'video' && height ? height : null,
    container: state.fmt.container,
    audioFormat: state.fmt.audioFormat,
    trim,
    subtitles: !!subtitles,
  };
}

/* ───────────────────────── 3. Segmented control ───────────────────────── */

/** Render (or update in place) a segmented control. Values are compared as strings. */
function seg(container, options, value, onPick) {
  const sig = options.map((o) => o.value + '=' + o.label).join('|');
  if (container.dataset.sig !== sig) {
    container.dataset.sig = sig;
    container.replaceChildren(...options.map((o) =>
      h('button', { type: 'button', class: 'seg-btn', 'data-value': o.value }, o.label)));
  }
  for (const b of container.children) {
    const on = String(b.dataset.value === String(value));
    if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on);
  }
  container._pick = onPick;
  if (!container._bound) {
    container._bound = true;
    container.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (b && container.contains(b) && container._pick) container._pick(b.dataset.value);
    });
  }
}

/* ───────────────────────── 4. Hero ───────────────────────── */

function setStatus(text) { setText(el.status, text); }
function showError(err) {
  setStatus('');
  setText(el.errorMsg, (err && err.message) || 'Something went wrong.');
  setText(el.errorHint, (err && err.hint) || '');
  show(el.error, true);
}
function clearError() { show(el.error, false); }

function setBusy(on) {
  el.heroRule.classList.toggle('is-busy', on);
  setText(el.fetchBtn, on ? 'Cancel' : 'Fetch');
}

function cancelProbe() {
  if (!state.probe) return;
  state.probe.ctrl.abort();
  state.probe = null;
  setBusy(false);
  setStatus('');
}

async function probe(url) {
  cancelProbe();
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const ctrl = new AbortController();
  state.probe = { token, ctrl, url };
  el.url.value = url;
  clearError();
  setBusy(true);
  setStatus('Reading the link');
  try {
    const info = await post('/api/probe', { url, token }, ctrl.signal);
    if (!state.probe || state.probe.token !== token) return;
    setStatus('');
    if (info && info.type === 'playlist') showPlaylist(info);
    else showBench(info || {});
  } catch (err) {
    if ((err && err.name === 'AbortError') || !state.probe || state.probe.token !== token) return;
    showError(err);
  } finally {
    if (state.probe && state.probe.token === token) {
      state.probe = null;
      setBusy(false);
    }
  }
}

/** Several links at once: queue them straight away with the current format settings. */
async function queueMany(urls) {
  cancelProbe();
  clearError();
  el.url.value = '';
  let added = 0;
  let firstError = null;
  for (let i = 0; i < urls.length; i++) {
    setStatus(`Adding link ${i + 1} of ${urls.length}`);
    try {
      const res = await post('/api/download', downloadBody({ url: urls[i], title: urls[i] }, { kind: state.fmt.kind, height: state.fmt.height }));
      if (res.job) upsertJob(res.job, true);
      added++;
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  if (firstError && !added) { showError(firstError); return; }
  setStatus(firstError
    ? `Added ${added} of ${urls.length} links to the queue. ${errText(firstError)}`
    : `Added ${added} links to the queue.`);
}

function submitText(text) {
  const urls = extractUrls(text);
  if (!urls.length) {
    showError({ message: 'That does not look like a link.', hint: 'Paste the address of a video or page, for example youtube.com/watch?v=…' });
    return;
  }
  if (urls.length === 1) probe(urls[0]);
  else queueMany(urls);
}

function bindHero() {
  el.heroForm.addEventListener('submit', (e) => {
    e.preventDefault();
    // While fetching, the button reads "Cancel"; a different link starts a new fetch instead.
    if (state.probe) {
      const urls = extractUrls(el.url.value);
      if (!urls.length || (urls.length === 1 && urls[0] === state.probe.url)) { cancelProbe(); return; }
    }
    submitText(el.url.value);
  });

  // Pasting into the empty (or fully selected) field fetches at once.
  el.url.addEventListener('paste', (e) => {
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    const input = el.url;
    const replacesAll = !input.value || (input.selectionStart === 0 && input.selectionEnd === input.value.length);
    if (!replacesAll || !extractUrls(text).length) return;
    e.preventDefault();
    submitText(text);
  });

  // Pasting anywhere else on the page (outside a field) fills the link and fetches.
  document.addEventListener('paste', (e) => {
    if (isTypingTarget(e.target) || sheetOpen()) return;
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (!extractUrls(text).length) return;
    e.preventDefault();
    window.scrollTo(0, 0);
    submitText(text);
  });
}

/** Replay the one orchestrated entrance on a result section. */
function reveal(section) {
  section.classList.remove('is-revealing');
  void section.offsetWidth; // restart the animations
  section.classList.add('is-revealing');
  clearTimeout(section._revealTimer);
  // Drop the class afterwards so clip-path never clips focus outlines.
  section._revealTimer = setTimeout(() => section.classList.remove('is-revealing'), 1400);
}

/* ───────────────────────── 5. Bench ───────────────────────── */

const MIN_CLIP = 0.2;

const B = {
  info: null,
  duration: 0,      // 0 = unknown
  start: 0,
  end: 0,
  playhead: 0,
  videoReady: false,
  wantPlay: false,
  raf: 0,
  preview: { key: null, state: 'idle', pct: 0 }, // idle | downloading | ready | error
};
// Server events can arrive before the POST /api/preview response names the key.
const previewEvents = new Map();
const stripKeys = new Set();

const benchOpen = () => !!B.info && !el.bench.hidden;
const hasTimeline = () => !!B.info && !B.info.isLive && B.duration > 0;
const isTrimmed = () => hasTimeline() && (B.start > 0.05 || B.end < B.duration - 0.05);

function benchHeights() {
  const hs = B.info && Array.isArray(B.info.heights) ? B.info.heights : [];
  return hs.map(Number).filter((n) => isFinite(n) && n > 0);
}
function benchKind() {
  const i = B.info;
  if (i.hasVideo === false) return 'audio';
  if (i.hasAudio === false) return 'video';
  return state.fmt.kind === 'audio' ? 'audio' : 'video';
}
function benchHeight() {
  return benchHeights().includes(state.fmt.height) ? state.fmt.height : null;
}

function showBench(info) {
  resetPlayer();
  closePlaylist();
  B.info = info;
  B.duration = !info.isLive && Number(info.duration) > 0 ? Number(info.duration) : 0;
  B.start = 0;
  B.end = B.duration;
  B.playhead = 0;

  setText(el.bTitle, info.title || info.url || 'Untitled');
  setText(el.bMeta, [info.uploader, info.site, info.isLive ? 'Live' : fmtClock(info.duration, false)].filter(Boolean).join(', '));

  if (info.thumbnail) { el.thumb.src = thumbUrl(info.thumbnail); show(el.thumb, true); }
  else { el.thumb.removeAttribute('src'); show(el.thumb, false); }

  show(el.liveNote, !!info.isLive);
  setText(el.dlNote, '');
  renderPreviewBtn();
  renderAlternates();
  renderTimelineFrame();
  renderTrim();
  renderBenchSpecs();
  renderPlayBtn();

  show(el.bench, true);
  reveal(el.bench);
}

function closeBench() {
  resetPlayer();
  B.info = null;
  show(el.bench, false);
}

function resetPlayer() {
  cancelAnimationFrame(B.raf);
  B.raf = 0;
  B.videoReady = false;
  B.wantPlay = false;
  B.preview = { key: null, state: 'idle', pct: 0 };
  const v = el.video;
  try { v.pause(); } catch { /* nothing playing */ }
  if (v.hasAttribute('src')) { v.removeAttribute('src'); v.load(); }
  show(v, false);
  el.stage.classList.remove('is-playable');
  el.tlStrip.style.backgroundImage = '';
  show(el.tlStrip, false);
  show(el.tlTicks, true);
  setText(el.previewNote, '');
}

function renderAlternates() {
  const info = B.info;
  const alts = info && Array.isArray(info.alternates) ? info.alternates.filter((a) => a && a.url) : [];
  show(el.alts, alts.length > 1);
  if (alts.length <= 1) { el.altList.replaceChildren(); return; }
  el.altList.replaceChildren(...alts.map((a) => {
    const current = a.url === info.url;
    const btn = h('button', { type: 'button', class: 'txt', 'data-url': a.url, 'aria-current': current ? 'true' : null }, a.label || a.url);
    return h('li', null, btn);
  }));
}

/* Preview */

function renderPreviewBtn() {
  const info = B.info;
  const p = B.preview;
  const visible = !!info && !info.isLive && p.state !== 'ready';
  show(el.previewBtn, visible);
  if (!visible) return;
  el.previewBtn.disabled = p.state === 'downloading';
  setText(el.previewBtn,
    p.state === 'downloading' ? `Loading preview ${Math.round(clamp(Number(p.pct) || 0, 0, 100))}%`
      : p.state === 'error' ? 'Try the preview again'
        : 'Load preview');
}

async function loadPreview(autoplay) {
  const info = B.info;
  if (!info || info.isLive) return;
  if (autoplay) B.wantPlay = true;
  if (B.preview.state === 'downloading' || B.preview.state === 'ready') return;
  B.preview = { key: null, state: 'downloading', pct: 0 };
  setText(el.previewNote, '');
  renderPreviewBtn();
  try {
    const res = await post('/api/preview', { url: info.url, strategy: info.strategy || null, referer: info.referer || null });
    if (B.info !== info) return;
    B.preview.key = res.key;
    if (res.strip || stripKeys.has(res.key)) setStrip(res.key);
    const late = previewEvents.get(res.key);
    onPreviewState(res.state !== 'ready' && late ? late : res);
  } catch (err) {
    if (B.info !== info) return;
    onPreviewState({ state: 'error', message: errText(err) });
  }
}

function onPreviewState(p) {
  if (B.preview.state === 'ready') return;
  if (p.state === 'ready') {
    B.preview.state = 'ready';
    el.video.src = `/media/preview/${B.preview.key}.mp4`;
    el.video.load();
  } else if (p.state === 'error') {
    B.preview.state = 'error';
    B.wantPlay = false;
    setText(el.previewNote, p.message || 'The preview could not be loaded. You can still set the clip times by hand and download.');
  } else {
    B.preview.state = 'downloading';
    if (p.pct != null && isFinite(p.pct)) B.preview.pct = Math.max(B.preview.pct, Number(p.pct));
  }
  renderPreviewBtn();
}

function setStrip(key) {
  const url = `/media/strip/${key}.jpg`;
  const img = new Image();
  img.onload = () => {
    if (B.preview.key !== key) return;
    el.tlStrip.style.backgroundImage = `url("${url}")`;
    show(el.tlStrip, true);
    show(el.tlTicks, false);
  };
  img.src = url;
}

/* Playback */

function renderPlayBtn() {
  setText(el.playBtn, B.videoReady && !el.video.paused ? 'Pause' : 'Play');
}

function play() {
  const v = el.video;
  if (!B.videoReady) return;
  if (isTrimmed() && (v.currentTime < B.start - 0.02 || v.currentTime >= B.end - 0.05)) {
    v.currentTime = B.start;
    setPlayhead(B.start, false);
  }
  const p = v.play();
  if (p && p.catch) p.catch(() => {});
}

function togglePlay() {
  if (!B.info || B.info.isLive) return;
  if (!B.videoReady) { loadPreview(true); return; } // first press fetches the preview, then plays
  if (el.video.paused) play();
  else el.video.pause();
}

function tick() {
  const v = el.video;
  if (v.paused || !B.videoReady) { B.raf = 0; return; }
  const t = v.currentTime;
  if (isTrimmed() && t >= B.end) {
    v.pause();
    v.currentTime = B.end;
    setPlayhead(B.end, false);
  } else {
    setPlayhead(t, false);
  }
  B.raf = requestAnimationFrame(tick);
}

function bindVideo() {
  const v = el.video;
  v.addEventListener('loadedmetadata', () => {
    if (!B.info || B.preview.state !== 'ready') return;
    B.videoReady = true;
    // Duration was unknown: take it from the preview so the timeline can appear.
    if (!B.duration && !B.info.isLive && isFinite(v.duration) && v.duration > 0) {
      B.duration = v.duration;
      B.start = 0;
      B.end = B.duration;
      renderTimelineFrame();
      renderTrim();
    }
    if (B.playhead > 0) { try { v.currentTime = B.playhead; } catch { /* not seekable yet */ } }
    el.stage.classList.add('is-playable');
    renderPlayBtn();
    if (B.wantPlay) { B.wantPlay = false; play(); }
  });
  v.addEventListener('loadeddata', () => {
    if (B.preview.state !== 'ready') return;
    show(v, true);
    show(el.thumb, false);
  });
  v.addEventListener('play', () => {
    renderPlayBtn();
    cancelAnimationFrame(B.raf);
    B.raf = requestAnimationFrame(tick);
  });
  v.addEventListener('pause', renderPlayBtn);
  v.addEventListener('ended', renderPlayBtn);
  v.addEventListener('timeupdate', () => {
    // Fallback for when rAF is throttled (background tab).
    if (!v.paused && B.videoReady && isTrimmed() && v.currentTime >= B.end) {
      v.pause();
      v.currentTime = B.end;
      setPlayhead(B.end, false);
    }
  });
  v.addEventListener('error', () => {
    if (B.preview.state !== 'ready' || !v.hasAttribute('src')) return;
    B.videoReady = false;
    B.wantPlay = false;
    B.preview.state = 'error';
    show(v, false);
    show(el.thumb, !!(B.info && B.info.thumbnail));
    el.stage.classList.remove('is-playable');
    setText(el.previewNote, 'The preview would not play. You can still set the clip times by hand and download.');
    renderPreviewBtn();
    renderPlayBtn();
  });

  el.thumb.addEventListener('error', () => show(el.thumb, false));

  el.stage.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (B.videoReady) togglePlay();
  });
  el.previewBtn.addEventListener('click', () => loadPreview(false));
}

/* Timeline */

function setPlayhead(t, seek) {
  B.playhead = clamp(Number(t) || 0, 0, B.duration || 0);
  if (seek && B.videoReady) {
    try { el.video.currentTime = B.playhead; } catch { /* not seekable */ }
  }
  renderPlayhead();
}

function renderPlayhead() {
  if (!hasTimeline()) return;
  el.playhead.style.left = (B.playhead / B.duration) * 100 + '%';
  setText(el.phTime, fmtClock(B.playhead));
}

/** Show or hide the trim block and set the parts that only depend on duration. */
function renderTimelineFrame() {
  const on = hasTimeline();
  show(el.trim, on);
  if (!on) return;
  setText(el.scaleEnd, fmtClock(B.duration, false));
  for (const hd of [el.handleIn, el.handleOut]) {
    hd.setAttribute('aria-valuemin', '0');
    hd.setAttribute('aria-valuemax', B.duration.toFixed(1));
  }
}

function renderTrim() {
  if (hasTimeline()) {
    const d = B.duration;
    const a = B.start / d;
    const b = B.end / d;
    el.handleIn.style.left = a * 100 + '%';
    el.handleOut.style.left = b * 100 + '%';
    el.tlSel.style.left = a * 100 + '%';
    el.tlSel.style.right = (1 - b) * 100 + '%';
    el.dimL.style.transform = `scaleX(${a})`;
    el.dimR.style.transform = `scaleX(${1 - b})`;
    el.handleIn.setAttribute('aria-valuenow', B.start.toFixed(1));
    el.handleIn.setAttribute('aria-valuetext', fmtClock(B.start));
    el.handleOut.setAttribute('aria-valuenow', B.end.toFixed(1));
    el.handleOut.setAttribute('aria-valuetext', fmtClock(B.end));
    setVal(el.inInput, fmtClock(B.start));
    setVal(el.outInput, fmtClock(B.end));
    setText(el.lenOut, fmtClock(B.end - B.start));
    renderPlayhead();
  }
  if (!B.info) return;
  const trimmed = isTrimmed();
  show(el.rowCut, trimmed);
  setText(el.dlLabel, trimmed ? 'Download clip' : 'Download');
  setText(el.dlLen, trimmed ? fmtClock(B.end - B.start) : hasTimeline() ? fmtClock(B.duration, false) : '');
  renderHints();
}

/**
 * Move the in or out point.
 * push: when the new point would cross the other one, release the other one
 *       (used by "Set in/out" and typed times) instead of clamping against it.
 * scrub: move the playhead (and the preview frame) to the new point.
 */
function setTrim(which, t, { push = false, scrub = true } = {}) {
  const d = B.duration;
  if (!d) return;
  const min = Math.min(MIN_CLIP, d);
  t = Math.round(clamp(Number(t) || 0, 0, d) * 10) / 10;
  if (which === 'in') {
    if (push && t > B.end - min) B.end = d;
    B.start = clamp(t, 0, Math.max(0, B.end - min));
  } else {
    if (d - t < 0.1) t = d; // snap to the very end
    if (push && t < B.start + min) B.start = 0;
    B.end = clamp(t, Math.min(d, B.start + min), d);
  }
  if (scrub) setPlayhead(which === 'in' ? B.start : B.end, true);
  renderTrim();
}

function resetTrim() {
  B.start = 0;
  B.end = B.duration;
  renderTrim();
}

function commitTime(which) {
  const input = which === 'in' ? el.inInput : el.outInput;
  const t = parseClock(input.value);
  if (t == null) {
    input.setAttribute('aria-invalid', 'true');
    setTimeout(() => input.removeAttribute('aria-invalid'), 1500);
  } else {
    setTrim(which, t, { push: true });
  }
  input.value = fmtClock(which === 'in' ? B.start : B.end);
}

function bindTimeline() {
  const fracAt = (clientX) => {
    const r = el.timeline.getBoundingClientRect();
    return r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) : 0;
  };

  // Drag a handle. The grab offset keeps the handle exactly under the pointer.
  const bindHandle = (handle, which) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !hasTimeline()) return;
      e.preventDefault();
      e.stopPropagation();
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(e.pointerId);
      const r = el.timeline.getBoundingClientRect();
      const cur = which === 'in' ? B.start : B.end;
      const grab = e.clientX - (r.left + (cur / B.duration) * r.width);
      const move = (ev) => setTrim(which, fracAt(ev.clientX - grab) * B.duration);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('click', (e) => e.stopPropagation());
    handle.addEventListener('keydown', (e) => {
      if (!hasTimeline()) return;
      const cur = which === 'in' ? B.start : B.end;
      const step = e.shiftKey ? 0.1 : 1;
      let next = null;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + step;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = B.duration;
      if (next == null) return;
      e.preventDefault();
      e.stopPropagation();
      setTrim(which, next);
    });
  };
  bindHandle(el.handleIn, 'in');
  bindHandle(el.handleOut, 'out');

  // Click or drag on the track to move the playhead.
  el.timeline.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !hasTimeline() || e.target.closest('.tl-handle')) return;
    e.preventDefault();
    el.timeline.setPointerCapture(e.pointerId);
    const seek = (ev) => setPlayhead(fracAt(ev.clientX) * B.duration, true);
    const up = () => {
      el.timeline.removeEventListener('pointermove', seek);
      el.timeline.removeEventListener('pointerup', up);
      el.timeline.removeEventListener('pointercancel', up);
      try { el.timeline.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    seek(e);
    el.timeline.addEventListener('pointermove', seek);
    el.timeline.addEventListener('pointerup', up);
    el.timeline.addEventListener('pointercancel', up);
  });

  for (const which of ['in', 'out']) {
    const input = which === 'in' ? el.inInput : el.outInput;
    input.addEventListener('change', () => commitTime(which));
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitTime(which); input.select(); }
      else if (e.key === 'Escape') {
        e.stopPropagation();
        input.value = fmtClock(which === 'in' ? B.start : B.end);
        input.blur();
      }
    });
  }

  el.playBtn.addEventListener('click', togglePlay);
  el.setInBtn.addEventListener('click', () => setTrim('in', B.playhead, { push: true, scrub: false }));
  el.setOutBtn.addEventListener('click', () => setTrim('out', B.playhead, { push: true, scrub: false }));
  el.resetBtn.addEventListener('click', resetTrim);
}

/* Specs + download */

function sizeHint() {
  const info = B.info;
  const sizes = (info && info.sizes) || {};
  const kind = benchKind();
  const height = benchHeight();
  let bytes = kind === 'audio' ? sizes.audio : height == null ? sizes.best : sizes[String(height)];
  bytes = Number(bytes);
  if (!isFinite(bytes) || bytes <= 0) return '';
  if (isTrimmed()) bytes *= (B.end - B.start) / B.duration;
  const text = fmtBytes(bytes);
  return text ? 'about ' + text : '';
}

function renderHints() {
  if (!B.info) return;
  const hint = sizeHint();
  const audio = benchKind() === 'audio';
  setText(el.hintQuality, audio ? '' : hint);
  // Converted audio changes size, so the estimate only fits M4A, the usual source format.
  setText(el.hintFormat, audio && state.fmt.audioFormat === 'm4a' ? hint : '');
}

function renderBenchSpecs() {
  const info = B.info;
  if (!info) return;
  const kind = benchKind();
  const height = benchHeight();

  const types = [];
  if (info.hasVideo !== false) types.push({ value: 'video', label: 'Video' });
  if (info.hasAudio !== false || !types.length) types.push({ value: 'audio', label: 'Audio' });
  seg(el.segType, types, kind, (v) => { if (v !== kind) setFmt({ kind: v }); });

  show(el.rowQuality, kind === 'video');
  seg(el.segQuality,
    [{ value: 'best', label: 'Best' }, ...benchHeights().map((x) => ({ value: String(x), label: x + 'p' }))],
    height == null ? 'best' : String(height),
    (v) => setFmt({ height: v === 'best' ? null : Number(v) }));

  if (kind === 'video') seg(el.segFormat, VIDEO_FORMATS, state.fmt.container, (v) => setFmt({ container: v }));
  else seg(el.segFormat, AUDIO_FORMATS, state.fmt.audioFormat, (v) => setFmt({ audioFormat: v }));

  seg(el.segCut, [{ value: 'exact', label: 'Exact' }, { value: 'fast', label: 'Fast' }], state.exact ? 'exact' : 'fast', (v) => {
    state.exact = v === 'exact';
    renderBenchSpecs();
    saveSettings({ exactTrim: state.exact }, true);
  });

  show(el.rowSubs, kind === 'video');
  seg(el.segSubs, OFF_ON, state.subs ? 'on' : 'off', (v) => { state.subs = v === 'on'; renderBenchSpecs(); });

  renderHints();
}

async function downloadCurrent() {
  const info = B.info;
  if (!info) return;
  const kind = benchKind();
  const trimmed = isTrimmed();
  const body = downloadBody(info, {
    kind,
    height: benchHeight(),
    trim: trimmed ? { start: B.start, end: B.end, exact: !!state.exact } : null,
    subtitles: kind === 'video' && state.subs,
  });
  el.dlBtn.disabled = true;
  clearTimeout(downloadCurrent.timer);
  try {
    const res = await post('/api/download', body);
    if (res.job) upsertJob(res.job, true);
    // The bench stays open: people cut several clips from one video.
    setText(el.dlNote, trimmed ? `Added the ${fmtClock(body.trim.end - body.trim.start)} clip to the queue.` : 'Added to the queue.');
    downloadCurrent.timer = setTimeout(() => setText(el.dlNote, ''), 4000);
  } catch (err) {
    setText(el.dlNote, errText(err));
  } finally {
    el.dlBtn.disabled = false;
  }
}

function bindBench() {
  bindVideo();
  bindTimeline();
  el.dlBtn.addEventListener('click', downloadCurrent);
  el.closeBench.addEventListener('click', () => { closeBench(); el.url.focus(); });
  el.altList.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-url]');
    if (!b || b.getAttribute('aria-current') === 'true') return;
    window.scrollTo(0, 0);
    probe(b.dataset.url);
  });
}

/* ───────────────────────── 6. Playlist ───────────────────────── */

const P = { info: null, entries: [], selected: new Set(), busy: false };

function showPlaylist(info) {
  closeBench();
  P.info = info;
  P.entries = Array.isArray(info.entries) ? info.entries.filter((en) => en && (en.url || en.playlistItem != null)) : [];
  P.selected = new Set(P.entries.map((_, i) => i));

  setText(el.pTitle, info.title || info.url || 'Playlist');
  const count = Number(info.count) || P.entries.length;
  setText(el.pMeta, [info.uploader, info.site, `${count} ${count === 1 ? 'item' : 'items'}`].filter(Boolean).join(', '));
  setText(el.pNote, '');

  el.pList.replaceChildren(...P.entries.map((en, i) =>
    h('li', { class: 'pl-item' },
      h('label', null,
        h('input', { type: 'checkbox', class: 'check', 'data-i': i, checked: true }),
        h('span', { class: 'pl-idx' }, String(en.index != null ? en.index : i + 1)),
        h('span', { class: 'pl-name' }, en.title || en.url || 'Untitled'),
        h('span', { class: 'pl-dur' }, fmtClock(en.duration, false))))));

  renderPlaylistSpecs();
  renderPlaylistCount();
  show(el.playlist, true);
  reveal(el.playlist);
}

function closePlaylist() {
  P.info = null;
  P.entries = [];
  P.selected = new Set();
  el.pList.replaceChildren();
  show(el.playlist, false);
}

function renderPlaylistCount() {
  const n = P.selected.size;
  setText(el.pCount, `${n} of ${P.entries.length} selected`);
  setText(el.pAddLabel, `Add ${n} to queue`);
  el.pAddBtn.disabled = P.busy || n === 0;
}

function renderPlaylistSpecs() {
  if (!P.info) return;
  const kind = state.fmt.kind === 'audio' ? 'audio' : 'video';
  const height = PLAYLIST_HEIGHTS.includes(state.fmt.height) ? state.fmt.height : null;
  seg(el.pSegType, [{ value: 'video', label: 'Video' }, { value: 'audio', label: 'Audio' }], kind, (v) => { if (v !== kind) setFmt({ kind: v }); });
  show(el.pRowQuality, kind === 'video');
  seg(el.pSegQuality,
    [{ value: 'best', label: 'Best' }, ...PLAYLIST_HEIGHTS.map((x) => ({ value: String(x), label: x + 'p' }))],
    height == null ? 'best' : String(height),
    (v) => setFmt({ height: v === 'best' ? null : Number(v) }));
  if (kind === 'video') seg(el.pSegFormat, VIDEO_FORMATS, state.fmt.container, (v) => setFmt({ container: v }));
  else seg(el.pSegFormat, AUDIO_FORMATS, state.fmt.audioFormat, (v) => setFmt({ audioFormat: v }));
}

function selectAllEntries(on) {
  P.selected = new Set(on ? P.entries.map((_, i) => i) : []);
  for (const box of el.pList.querySelectorAll('input[type="checkbox"]')) box.checked = on;
  renderPlaylistCount();
}

async function addPlaylist() {
  const info = P.info;
  if (!info || P.busy) return;
  const picks = P.entries.filter((_, i) => P.selected.has(i));
  if (!picks.length) return;
  const kind = state.fmt.kind === 'audio' ? 'audio' : 'video';
  const height = PLAYLIST_HEIGHTS.includes(state.fmt.height) ? state.fmt.height : null;
  P.busy = true;
  renderPlaylistCount();
  let added = 0;
  let firstError = null;
  for (let n = 0; n < picks.length; n++) {
    const en = picks[n];
    setText(el.pNote, `Adding ${n + 1} of ${picks.length}`);
    try {
      const res = await post('/api/download', downloadBody({
        url: en.url || info.url,
        title: en.title,
        thumbnail: en.thumbnail,
        site: info.site,
        duration: en.duration,
        strategy: info.strategy,
        playlistItem: en.playlistItem,
      }, { kind, height }));
      if (res.job) upsertJob(res.job, true);
      added++;
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }
  P.busy = false;
  if (P.info === info) {
    renderPlaylistCount();
    setText(el.pNote, firstError
      ? `Added ${added} of ${picks.length} to the queue. ${errText(firstError)}`
      : `Added ${added} to the queue.`);
  }
}

function bindPlaylist() {
  el.pList.addEventListener('change', (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    const i = Number(box.dataset.i);
    if (box.checked) P.selected.add(i);
    else P.selected.delete(i);
    renderPlaylistCount();
  });
  el.pAll.addEventListener('click', () => selectAllEntries(true));
  el.pNone.addEventListener('click', () => selectAllEntries(false));
  el.pAddBtn.addEventListener('click', addPlaylist);
  el.closePlaylist.addEventListener('click', () => { closePlaylist(); el.url.focus(); });
}

/* ───────────────────────── 7. Ledger ───────────────────────── */

const rows = new Map(); // id → row record

// Closing the window stops the engine (Windows app), so ask while downloads are running.
window.addEventListener('beforeunload', (e) => {
  for (const r of rows.values()) {
    if (r.job && (r.job.state === 'running' || r.job.state === 'queued')) { e.preventDefault(); e.returnValue = ''; return; }
  }
});

const EMPTY_INVITE = 'Nothing here yet. Paste a link above and your downloads line up here.';

function stamp(v) {
  if (typeof v === 'number' && isFinite(v)) return v < 1e11 ? v * 1000 : v;
  const t = Date.parse(v);
  return isFinite(t) ? t : Date.now();
}

function jobMeta(job) {
  const parts = [];
  if (job.site) parts.push(job.site);
  if (job.kind === 'audio') parts.push(String(job.audioFormat || 'audio').toUpperCase());
  else parts.push(`${job.height ? job.height + 'p' : 'Best'} ${String(job.container || 'mp4').toUpperCase()}`);
  const tr = job.trim;
  if (tr && tr.start != null && tr.end != null) parts.push(`clip ${fmtClock(tr.start)}–${fmtClock(tr.end)}`);
  return parts.join(', ');
}

function createRow(job) {
  const img = h('img', { class: 'row-img', alt: '', hidden: true });
  img.addEventListener('error', () => { img.hidden = true; });
  const r = {
    id: String(job.id),
    ts: stamp(job.createdAt),
    img,
    title: h('p', { class: 'row-title' }),
    meta: h('p', { class: 'row-meta' }),
    phase: h('p', { class: 'row-phase' }),
    pct: h('p', { class: 'row-pct' }),
    detail: h('p', { class: 'row-detail' }),
    actions: h('div', { class: 'row-actions' }),
    bar: h('i'),
    thumbSrc: '',
    actKey: '',
    barKey: '',
    search: '',
    job: null,
  };
  r.li = h('li', { class: 'row', 'data-id': job.id },
    h('div', { class: 'row-clip' },
      h('div', { class: 'row-body' },
        h('div', { class: 'row-thumb' }, img),
        h('div', { class: 'row-main' }, r.title, r.meta),
        h('div', { class: 'row-status' }, r.phase, r.pct, r.detail),
        r.actions)),
    h('div', { class: 'row-bar' }, r.bar));
  return r;
}

const actionBtn = (act, label) => h('button', { type: 'button', class: 'txt', 'data-act': act }, label);

/** Update one row in place; only touches the nodes whose content changed. */
function updateRow(r, job) {
  r.job = job;
  const title = job.title || job.fileName || job.url || 'Untitled';
  setText(r.title, title);
  setText(r.meta, jobMeta(job));
  r.search = title.toLowerCase();

  const src = job.thumbLocal ? `/media/thumb/${encodeURIComponent(job.id)}.jpg` : thumbUrl(job.thumbnail);
  if (src !== r.thumbSrc) {
    r.thumbSrc = src;
    if (src) { r.img.hidden = false; r.img.src = src; }
    else { r.img.hidden = true; r.img.removeAttribute('src'); }
  }

  let phase = '';
  let big = '';
  let detail = '';
  switch (job.state) {
    case 'queued':
      phase = job.phase || 'Queued';
      break;
    case 'running':
      phase = job.phase || 'Downloading';
      big = job.pct == null ? '' : Math.floor(clamp(Number(job.pct) || 0, 0, 100)) + '%';
      detail = [fmtSpeed(job.speed), fmtEta(job.eta)].filter(Boolean).join(', ');
      break;
    case 'done':
      if (job.missing) { phase = 'File moved or deleted'; }
      else { phase = 'Saved'; big = fmtBytes(job.size); detail = job.fileName || ''; }
      break;
    case 'error':
      phase = (job.error && job.error.message) || 'The download failed.';
      detail = (job.error && job.error.hint) || '';
      break;
    case 'canceled':
      phase = 'Canceled';
      break;
    default:
      phase = job.phase || '';
  }
  setText(r.phase, phase);
  setText(r.pct, big);
  setText(r.detail, detail);

  if (r.li.dataset.state !== job.state) r.li.dataset.state = job.state || '';
  const missing = String(job.state === 'done' && !!job.missing);
  if (r.li.dataset.missing !== missing) r.li.dataset.missing = missing;

  // Progress line
  const running = job.state === 'running';
  const indeterminate = running && job.pct == null;
  const barKey = indeterminate ? 'i' : running ? String(clamp(Number(job.pct) || 0, 0, 100)) : '0';
  if (barKey !== r.barKey) {
    r.barKey = barKey;
    r.bar.classList.toggle('is-indeterminate', indeterminate);
    r.bar.style.transform = indeterminate ? '' : `scaleX(${Number(barKey) / 100})`;
  }

  // Actions depend only on state, so rebuild them only when it changes.
  const actKey = job.state + '|' + missing;
  if (actKey !== r.actKey) {
    r.actKey = actKey;
    let btns;
    if (job.state === 'queued' || job.state === 'running') btns = [actionBtn('cancel', 'Cancel')];
    else if (job.state === 'done' && job.missing) btns = [actionBtn('remove', 'Remove')];
    else if (job.state === 'done') btns = [actionBtn('reveal', IS_WIN ? 'Show in Explorer' : 'Show in Finder'), actionBtn('open', 'Open'), actionBtn('remove', 'Remove')];
    else btns = [actionBtn('retry', 'Retry'), actionBtn('remove', 'Remove')];
    r.actions.replaceChildren(...btns);
  }
}

function upsertJob(job, animate) {
  if (!job || job.id == null) return;
  const id = String(job.id);
  let r = rows.get(id);
  if (!r) {
    r = createRow(job);
    rows.set(id, r);
    // Newest first.
    let before = null;
    for (const child of el.jobs.children) {
      const other = rows.get(child.dataset.id);
      if (other && other.ts < r.ts) { before = child; break; }
    }
    el.jobs.insertBefore(r.li, before);
    if (animate) {
      void r.li.offsetHeight; // commit the collapsed state, then expand
      r.li.classList.add('is-in');
    } else {
      r.li.classList.add('no-anim', 'is-in');
    }
  }
  updateRow(r, job);
  filterRow(r);
  renderLedgerState();
}

function removeRow(id) {
  id = String(id);
  const r = rows.get(id);
  if (!r) return;
  r.li.remove();
  rows.delete(id);
  renderLedgerState();
}

function reconcileJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const keep = new Set(list.map((j) => String(j && j.id)));
  for (const id of [...rows.keys()]) if (!keep.has(id)) removeRow(id);
  for (const job of list) upsertJob(job, false);
  renderLedgerState();
}

const filterQuery = () => el.filter.value.trim().toLowerCase();

function filterRow(r) {
  const q = filterQuery();
  show(r.li, !q || r.search.includes(q));
}

function renderLedgerState() {
  let visible = 0;
  let finished = 0;
  for (const r of rows.values()) {
    if (!r.li.hidden) visible++;
    if (r.job && ['done', 'error', 'canceled'].includes(r.job.state)) finished++;
  }
  el.clearBtn.disabled = finished === 0;
  if (rows.size === 0) { setText(el.empty, EMPTY_INVITE); show(el.empty, true); }
  else if (visible === 0) { setText(el.empty, `No downloads match “${el.filter.value.trim()}”.`); show(el.empty, true); }
  else show(el.empty, false);
}

function ledgerNote(text) {
  setText(el.ledgerNote, text);
  clearTimeout(ledgerNote.timer);
  if (text) ledgerNote.timer = setTimeout(() => setText(el.ledgerNote, ''), 8000);
}

function bindLedger() {
  el.jobs.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const li = btn.closest('.row');
    const id = li && li.dataset.id;
    if (!id) return;
    const act = btn.dataset.act;
    const path = '/api/jobs/' + encodeURIComponent(id);
    btn.disabled = true;
    try {
      if (act === 'remove') {
        await api('DELETE', path); // removes the entry from the list, never the file
        removeRow(id);
      } else {
        const res = await post(`${path}/${act}`);
        if (res && res.job) upsertJob(res.job, false);
      }
      ledgerNote('');
    } catch (err) {
      ledgerNote(errText(err));
    } finally {
      btn.disabled = false;
    }
  });

  el.filter.addEventListener('input', () => {
    for (const r of rows.values()) filterRow(r);
    renderLedgerState();
  });

  el.clearBtn.addEventListener('click', async () => {
    el.clearBtn.disabled = true;
    try {
      await post('/api/jobs/clear');
      for (const r of [...rows.values()]) {
        if (r.job && ['done', 'error', 'canceled'].includes(r.job.state)) removeRow(r.id);
      }
      ledgerNote('');
    } catch (err) {
      ledgerNote(errText(err));
    }
    renderLedgerState();
  });
}

/* ───────────────────────── 8. Settings + engine ───────────────────────── */

let sheetReturnFocus = null;
const sheetOpen = () => el.sheet.classList.contains('is-open');

function applyTheme(theme) {
  const t = ['light', 'dark'].includes(theme) ? theme : 'auto';
  if (document.documentElement.dataset.theme !== t) document.documentElement.dataset.theme = t;
  try { localStorage.setItem('md-theme', t); } catch { /* storage unavailable */ }
}

function settingsNote(text) {
  setText(el.settingsNote, text);
  clearTimeout(settingsNote.timer);
  if (text) settingsNote.timer = setTimeout(() => setText(el.settingsNote, ''), 8000);
}

function applySettings(s) {
  if (!s || typeof s !== 'object') return;
  state.settings = { ...state.settings, ...s };
  if (typeof state.settings.exactTrim === 'boolean' && state.exact !== state.settings.exactTrim) {
    state.exact = state.settings.exactTrim;
    renderBenchSpecs();
  }
  applyTheme(state.settings.theme);
  renderSettings();
}

/** Optimistic save: apply locally, post the partial, then take the server's version. */
async function saveSettings(patch, quiet) {
  state.settings = { ...state.settings, ...patch };
  if (!quiet) renderSettings();
  try {
    const res = await post('/api/settings', patch);
    if (res.settings) applySettings(res.settings);
    if (!quiet) settingsNote('');
  } catch (err) {
    if (!quiet) settingsNote(errText(err));
  }
}

function renderSettings() {
  const s = state.settings;
  setVal(el.setDir, s.downloadDir);
  setVal(el.setCookieFile, s.cookiesFile);
  setVal(el.setRate, s.rateLimit);
  setVal(el.setSubLangs, s.subLangs);
  if (document.activeElement !== el.setBrowser && s.cookiesBrowser) el.setBrowser.value = s.cookiesBrowser;

  const mode = ['browser', 'file'].includes(s.cookiesMode) ? s.cookiesMode : 'off';
  seg(el.segCookies,
    [{ value: 'off', label: 'Off' }, { value: 'browser', label: 'From a browser' }, { value: 'file', label: 'cookies.txt file' }],
    mode,
    (v) => {
      const patch = { cookiesMode: v };
      if (v === 'browser') patch.cookiesBrowser = el.setBrowser.value;
      saveSettings(patch);
    });
  show(el.cookieBrowserWrap, mode === 'browser');
  show(el.cookieFileWrap, mode === 'file');

  seg(el.segConc, [1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) })),
    String(clamp(Math.round(Number(s.concurrency)) || 2, 1, 4)),
    (v) => saveSettings({ concurrency: Number(v) }));

  seg(el.segEdit, OFF_ON, s.editReady ? 'on' : 'off', (v) => saveSettings({ editReady: v === 'on' }));

  seg(el.segTheme,
    [{ value: 'auto', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }],
    ['light', 'dark'].includes(s.theme) ? s.theme : 'auto',
    (v) => { applyTheme(v); saveSettings({ theme: v }); });
}

function openSheet() {
  if (sheetOpen()) return;
  sheetReturnFocus = document.activeElement;
  renderSettings();
  el.sheet.inert = false;
  el.sheet.setAttribute('aria-hidden', 'false');
  el.sheet.classList.add('is-open');
  el.scrim.classList.add('is-open');
  el.closeSettings.focus({ preventScroll: true });
}

function closeSheet() {
  if (!sheetOpen()) return;
  // Commit a field that is still being edited.
  if (el.sheet.contains(document.activeElement)) document.activeElement.blur();
  el.sheet.classList.remove('is-open');
  el.scrim.classList.remove('is-open');
  el.sheet.inert = true;
  el.sheet.setAttribute('aria-hidden', 'true');
  const back = sheetReturnFocus && document.contains(sheetReturnFocus) ? sheetReturnFocus : el.openSettings;
  back.focus({ preventScroll: true });
  sheetReturnFocus = null;
}

function sheetFocusables() {
  return [...el.sheet.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && n.getClientRects().length > 0);
}

function bindSettings() {
  el.openSettings.addEventListener('click', openSheet);
  el.closeSettings.addEventListener('click', closeSheet);
  el.scrim.addEventListener('click', closeSheet);

  // Keep Tab inside the sheet while it is open.
  el.sheet.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = sheetFocusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  const commitOnEnter = (input) => input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });

  el.setDir.addEventListener('change', () => {
    const v = el.setDir.value.trim();
    if (v) saveSettings({ downloadDir: v });
    else { el.setDir.value = state.settings.downloadDir || ''; settingsNote('Choose a folder to save downloads to.'); }
  });
  el.pickDir.addEventListener('click', async () => {
    el.pickDir.disabled = true;
    try {
      // In the Mac app the native folder panel opens as a sheet on the window.
      const native = window.webkit?.messageHandlers?.native;
      const res = native ? await native.postMessage({ cmd: 'pickFolder' }) : await post('/api/pick-folder');
      if (res.path) { el.setDir.value = res.path; await saveSettings({ downloadDir: res.path }); }
    } catch (err) {
      settingsNote(errText(err));
    } finally {
      el.pickDir.disabled = false;
    }
  });

  el.setBrowser.addEventListener('change', () => saveSettings({ cookiesBrowser: el.setBrowser.value }));
  el.setCookieFile.addEventListener('change', () => saveSettings({ cookiesFile: el.setCookieFile.value.trim() }));

  el.setRate.addEventListener('change', () => {
    const v = el.setRate.value.trim().toUpperCase();
    if (v && !/^\d+(\.\d+)?[KMG]?$/.test(v)) {
      el.setRate.value = state.settings.rateLimit || '';
      settingsNote('Type the speed limit as a number with K or M, such as 500K or 2M.');
      return;
    }
    el.setRate.value = v;
    saveSettings({ rateLimit: v });
  });

  el.setSubLangs.addEventListener('change', () => {
    const v = el.setSubLangs.value.split(/[\s,]+/).filter(Boolean).join(',');
    el.setSubLangs.value = v;
    saveSettings({ subLangs: v });
  });

  for (const input of [el.setDir, el.setCookieFile, el.setRate, el.setSubLangs]) commitOnEnter(input);

  el.updateBtn.addEventListener('click', async () => {
    if (state.engine && state.engine.updating) return;
    el.engLog.replaceChildren();
    state.engine = { ...(state.engine || {}), updating: true };
    renderEngine();
    try {
      await post('/api/engine/update');
    } catch (err) {
      state.engine = { ...state.engine, updating: false };
      appendEngineLog(errText(err));
      renderEngine();
    }
  });
}

/* Engine */

let offline = false;

function setOffline(on) {
  if (offline === on) return;
  offline = on;
  renderEngine();
}

function renderEngine() {
  const e = state.engine;
  const version = e && e.ytdlp;
  const age = e && e.ageDays != null && isFinite(e.ageDays) ? Math.max(0, Math.round(Number(e.ageDays))) : null;
  const fresh = !offline && !!version && age != null && age < 45;

  el.engineDot.classList.toggle('is-fresh', fresh);
  setText(el.engineText,
    offline ? 'Not connected'
      : !e ? 'Connecting'
        : e.updating ? 'Updating engine'
          : version ? `Engine ${version}` : 'Engine not found');

  setText(el.engYtdlp, version || 'Not found');
  setText(el.engAge, age == null ? 'Unknown' : age === 0 ? 'Released today' : age === 1 ? '1 day' : `${age} days`);
  setText(el.engFfmpeg, (e && e.ffmpeg) || 'Not found');

  let nudge = '';
  if (e && !version) nudge = IS_WIN ? 'The download engine is missing. Quit and reopen Media Downloader to reinstall it.' : 'yt-dlp was not found. Install it with “brew install yt-dlp”, then reload this page.';
  else if (e && !e.ffmpeg) nudge = IS_WIN ? 'ffmpeg is missing. Quit and reopen Media Downloader to reinstall it.' : 'ffmpeg was not found. Install it with “brew install ffmpeg” so downloads can be merged and trimmed.';
  else if (version && age != null && age >= 45) nudge = `This engine is ${age} days old. Sites change often, so an update is probably available.`;
  setText(el.engNudge, nudge);
  show(el.engNudge, !!nudge);

  const updating = !!(e && e.updating);
  el.updateBtn.disabled = updating || offline;
  setText(el.updateBtn, updating ? 'Updating…' : 'Update engine');
}

function appendEngineLog(line) {
  if (!line) return;
  show(el.engLog, true);
  el.engLog.append(h('div', null, String(line)));
  while (el.engLog.childElementCount > 200) el.engLog.firstElementChild.remove();
  el.engLog.scrollTop = el.engLog.scrollHeight;
}

/* ───────────────────────── 9. Events, keys, init ───────────────────────── */

function handleEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  switch (ev.type) {
    case 'probe':
      if (state.probe && ev.token === state.probe.token && ev.step) setStatus(ev.step);
      break;
    case 'job':
      upsertJob(ev.job, true);
      break;
    case 'jobRemoved':
      removeRow(ev.id);
      break;
    case 'preview':
      if (!ev.key) break;
      previewEvents.set(ev.key, ev);
      if (previewEvents.size > 40) previewEvents.delete(previewEvents.keys().next().value);
      if (B.info && B.preview.key === ev.key) onPreviewState(ev);
      break;
    case 'strip':
      if (!ev.key) break;
      stripKeys.add(ev.key);
      if (B.info && B.preview.key === ev.key) setStrip(ev.key);
      break;
    case 'engine':
      if (ev.engine) state.engine = ev.engine;
      appendEngineLog(ev.line);
      renderEngine();
      break;
    case 'settings':
      applySettings(ev.settings);
      break;
    default:
  }
}

let stateRetry = 0;

async function loadState() {
  clearTimeout(stateRetry);
  try {
    const s = await api('GET', '/api/state');
    if (!state.loaded) {
      state.loaded = true;
      const p = (s.settings && s.settings.preset) || {};
      state.fmt = {
        kind: p.kind === 'audio' ? 'audio' : 'video',
        height: Number(p.height) > 0 ? Number(p.height) : null,
        container: p.container === 'mkv' ? 'mkv' : 'mp4',
        audioFormat: ['mp3', 'm4a', 'wav'].includes(p.audioFormat) ? p.audioFormat : 'mp3',
      };
      renderBenchSpecs();
      renderPlaylistSpecs();
    }
    applySettings(s.settings);
    if (s.engine) state.engine = s.engine;
    setOffline(false);
    renderEngine();
    reconcileJobs(s.jobs);
  } catch {
    setOffline(true);
    stateRetry = setTimeout(loadState, 3000);
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  let dropped = false;
  es.onopen = () => {
    if (!dropped) return;
    dropped = false;
    loadState(); // resync whatever happened while disconnected
  };
  es.onerror = () => {
    dropped = true;
    setOffline(true);
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      setTimeout(connectEvents, 3000);
      loadStateSoon();
    }
  };
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    handleEvent(ev);
  };
}
function loadStateSoon() {
  clearTimeout(stateRetry);
  stateRetry = setTimeout(loadState, 3000);
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetOpen()) { e.preventDefault(); closeSheet(); return; }
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (sheetOpen() || !benchOpen() || B.info.isLive) return;
    const t = e.target;
    if (isTypingTarget(t)) return;

    if (e.key === ' ' || e.code === 'Space') {
      // A control focused with the keyboard keeps Space for itself.
      if (t && t.matches && t.matches('button, a, summary, [role="slider"]') && t.matches(':focus-visible')) return;
      e.preventDefault();
      if (!e.repeat) togglePlay();
      return;
    }
    if (!hasTimeline()) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'i') { e.preventDefault(); setTrim('in', B.playhead, { push: true, scrub: false }); }
    else if (key === 'o') { e.preventDefault(); setTrim('out', B.playhead, { push: true, scrub: false }); }
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 0.1 : 1;
      setPlayhead(Math.round((B.playhead + (key === 'ArrowLeft' ? -step : step)) * 10) / 10, true);
    }
  });
}

function init() {
  applyTheme(document.documentElement.dataset.theme);
  bindHero();
  bindBench();
  bindPlaylist();
  bindLedger();
  bindSettings();
  bindKeys();
  renderSettings();
  renderEngine();
  renderLedgerState();
  connectEvents();
  loadState();
  el.url.focus({ preventScroll: true });
}

init();
