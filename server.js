#!/usr/bin/env node
// Media Downloader — local server. No dependencies: Node + yt-dlp + ffmpeg.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.MD_DATA || path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'cache');
const THUMBS = path.join(DATA, 'thumbs');
const PORT = Number(process.env.PORT) || 4865;
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const WIN = process.platform === 'win32';
// MD_BIN: folder of bundled tools (the Windows app keeps yt-dlp, ffmpeg and node there).
const ENV = { ...process.env, PATH: [process.env.MD_BIN, ...(WIN ? [] : ['/opt/homebrew/bin', '/usr/local/bin']), process.env.PATH || process.env.Path || '']
  .filter(Boolean).join(path.delimiter) };
if (WIN) delete ENV.Path; // Windows env keys are case-insensitive; keep a single PATH
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

for (const d of [DATA, CACHE, THUMBS]) fs.mkdirSync(d, { recursive: true });

// ───────────────────────── persistence ─────────────────────────
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); } catch { return fallback; }
};
const writeTimers = new Map();
const writeJson = (file, getValue) => {
  clearTimeout(writeTimers.get(file));
  writeTimers.set(file, setTimeout(() => {
    const target = path.join(DATA, file);
    fsp.writeFile(target + '.tmp', JSON.stringify(getValue(), null, 1))
      .then(() => fsp.rename(target + '.tmp', target)).catch(() => {});
  }, 300));
};

const DEFAULTS = {
  downloadDir: path.join(os.homedir(), 'Downloads', 'Media Downloader'),
  cookiesMode: 'off', cookiesBrowser: WIN ? 'firefox' : 'safari', cookiesFile: '',
  concurrency: 2, rateLimit: '', editReady: true, subLangs: 'en,es',
  theme: 'auto', exactTrim: true,
  preset: { kind: 'video', height: 1080, container: 'mp4', audioFormat: 'mp3' },
};
let settings = { ...DEFAULTS, ...readJson('settings.json', {}) };
settings.preset = { ...DEFAULTS.preset, ...(settings.preset || {}) };
const remembered = readJson('strategies.json', {}); // host → strategy id that last worked
/** @type {Map<string, any>} */
const jobs = new Map();
for (const j of readJson('history.json', [])) jobs.set(j.id, j);
const saveHistory = () => writeJson('history.json', () =>
  [...jobs.values()].filter((j) => ['done', 'error', 'canceled'].includes(j.state)).slice(-500));

// ───────────────────────── process helpers ─────────────────────────
const children = new Set();
function run(cmd, args, { timeout = 0, onLine, holder } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: ENV, detached: !WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ code: -1, out: '', err: String(e) }); }
    children.add(child);
    if (holder) holder.child = child;
    let out = '', err = '', timer;
    const wire = (stream, isErr) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        if (isErr) err = (err + d).slice(-40000);
        else if (!onLine) out += d;
        if (!onLine) return;
        buf += d;
        const parts = buf.split(/[\r\n]+/);
        buf = parts.pop();
        for (const line of parts) if (line) onLine(line, isErr);
      });
      stream.on('end', () => { if (buf && onLine) onLine(buf, isErr); });
    };
    wire(child.stdout, false);
    wire(child.stderr, true);
    if (timeout) timer = setTimeout(() => killTree(child), timeout);
    child.on('error', (e) => { err += String(e); });
    child.on('close', (code) => {
      clearTimeout(timer); children.delete(child);
      resolve({ code: code ?? -1, out, err });
    });
  });
}
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (WIN) { // no process groups on Windows: kill the whole tree (yt-dlp → ffmpeg)
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2500).unref();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isYouTube = (u) => /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(hostOf(u));

// ───────────────────────── events (SSE) ─────────────────────────
const clients = new Set();
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}
const lastEmit = new Map();
function emitJob(job, force = true) {
  const now = Date.now();
  if (!force && now - (lastEmit.get(job.id) || 0) < 220) return;
  lastEmit.set(job.id, now);
  broadcast({ type: 'job', job: publicJob(job) });
}
function publicJob(j) {
  const { child, holder, canceled, ...rest } = j;
  return { ...rest, fileName: j.file ? path.basename(j.file) : null };
}

// ───────────────────────── strategy chain ─────────────────────────
// Every request walks this chain until one route works. The route that worked
// is remembered per site, so the next request starts there.
function cookieArgs() {
  if (settings.cookiesMode === 'browser' && settings.cookiesBrowser) return ['--cookies-from-browser', settings.cookiesBrowser];
  if (settings.cookiesMode === 'file' && settings.cookiesFile && fs.existsSync(settings.cookiesFile)) return ['--cookies', settings.cookiesFile];
  return null;
}
function chainFor(url, preferred) {
  const yt = isYouTube(url);
  const ytAlt = ['--extractor-args', 'youtube:player_client=web_embedded,mweb,web'];
  const ytTv = ['--extractor-args', 'youtube:player_client=tv,web_safari,android_vr'];
  const list = [{ id: 'direct', label: 'Trying the direct route', args: [] }];
  if (yt) {
    list.push({ id: 'yt-alt', label: 'Trying an alternate YouTube client', args: ytAlt });
    list.push({ id: 'yt-tv', label: 'Trying the TV client', args: ytTv });
  } else {
    list.push({ id: 'chrome', label: 'Retrying as Chrome', args: ['--impersonate', 'chrome'] });
    list.push({ id: 'safari', label: 'Retrying as Safari', args: ['--impersonate', 'safari'] });
  }
  const cookies = cookieArgs();
  if (cookies) {
    list.push({ id: 'cookies', label: 'Retrying with your signed-in cookies', args: cookies });
    if (yt) list.push({ id: 'cookies-alt', label: 'Retrying with cookies and an alternate client', args: [...cookies, ...ytAlt] });
  }
  const first = preferred || remembered[hostOf(url)];
  const i = list.findIndex((s) => s.id === first);
  if (i > 0) list.unshift(...list.splice(i, 1));
  return list;
}
function remember(url, id) {
  const h = hostOf(url);
  if (!h || remembered[h] === id) return;
  remembered[h] = id;
  writeJson('strategies.json', () => remembered);
}

function explain(stderr = '') {
  const s = stderr.split('\n').filter((l) => /ERROR/.test(l)).join('\n') || stderr;
  const cookiesOn = !!cookieArgs();
  const cookieHint = cookiesOn
    ? 'Open the site in that browser, make sure you are signed in, then try again.'
    : 'Turn on “Signed-in cookies” in Settings so the app can use your browser session, then try again.';
  const short = (s.match(/ERROR:\s*(?:\[[^\]]+\]\s*)?(?:[\w-]+:\s*)?(.{0,220})/) || [])[1] || s.slice(-220);
  if (/DRM/i.test(s)) return { code: 'drm', fatal: true, message: 'This video is DRM-protected.', hint: 'Protected streams (Netflix, Spotify and similar) cannot be downloaded by any tool.' };
  if (/could not find .*cookies|cookies database|Operation not permitted|failed to decrypt|keyring|Keychain/i.test(s))
    return { code: 'cookies', message: 'The app could not read your browser cookies.', hint: 'For Safari, give Full Disk Access to the app that launched the server (System Settings → Privacy & Security). For Chrome, allow the Keychain prompt. Or export a cookies.txt file and point Settings at it.' };
  if (/not a bot|Sign in to confirm/i.test(s)) return { code: 'auth', message: 'YouTube wants a sign-in check on this network.', hint: cookieHint };
  if (/429|Too Many Requests|rate.?limit/i.test(s)) return { code: 'rate', message: 'The site is rate-limiting this network.', hint: 'Wait a few minutes, switch off any VPN, or turn on signed-in cookies in Settings.' };
  if (/log ?in|sign in|logged.in|members.only|private|authenticat|cookies|age.restricted|confirm your age|NSFW/i.test(s)) return { code: 'auth', message: 'This post is only visible when signed in.', hint: cookieHint };
  if (/not available in your country|geo.?restrict|geo.?block/i.test(s)) return { code: 'geo', fatal: true, message: 'This video is blocked in your region.', hint: 'A VPN set to the publisher’s country usually fixes it.' };
  if (/Unsupported URL|No video could be found|no video formats|No media found|not a valid URL/i.test(s)) return { code: 'unsupported', message: 'No downloadable media was found at that link.', hint: 'Open the page, start the video, and paste the link to the post itself rather than a feed or homepage.' };
  if (/404|not found|unavailable|removed|deleted|does not exist/i.test(s)) return { code: 'gone', fatal: true, message: 'That video is unavailable or was removed.', hint: 'Check that the link still plays in your browser.' };
  if (/403|Forbidden|blocked/i.test(s)) return { code: 'blocked', message: 'The site refused the request.', hint: 'Switch off any VPN, or turn on signed-in cookies in Settings. If it keeps failing, update the engine.' };
  if (/timed out|Temporary failure|getaddrinfo|Connection (reset|refused)|Network is unreachable/i.test(s)) return { code: 'network', message: 'The connection dropped.', hint: 'Check your internet connection and retry.' };
  return { code: 'unknown', message: short.trim() || 'The download failed.', hint: 'Retry, and if it keeps failing update the engine in Settings — sites change often.' };
}

// ───────────────────────── probing ─────────────────────────
function pickThumb(d) {
  if (d.thumbnail) return d.thumbnail;
  const t = (d.thumbnails || []).filter((x) => x && x.url);
  return t.length ? t[t.length - 1].url : null;
}
function normalize(d, url, strategy, referer) {
  if (d._type === 'playlist') {
    const raw = (d.entries || []).filter(Boolean);
    const urls = raw.map((e) => e.url || e.webpage_url || e.original_url || '');
    const shared = raw.length > 1 && new Set(urls).size < raw.length; // several videos inside one post
    if (raw.length === 1 && raw[0].formats) return normalize(raw[0], url, strategy, referer);
    return {
      type: 'playlist', url, title: d.title || hostOf(url), uploader: d.uploader || d.channel || null,
      site: d.extractor_key || hostOf(url), count: raw.length, strategy,
      entries: raw.map((e, i) => ({
        index: i + 1, title: e.title || urls[i] || `Item ${i + 1}`,
        url: shared || !urls[i] ? url : urls[i], duration: e.duration ?? null,
        thumbnail: pickThumb(e), uploader: e.uploader || e.channel || null,
        playlistItem: shared || !urls[i] ? i + 1 : null,
      })),
    };
  }
  const formats = d.formats || [];
  const vids = formats.filter((f) => f.vcodec && f.vcodec !== 'none');
  const auds = formats.filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  const dur = d.duration || null;
  const sizeOf = (f) => f?.filesize || f?.filesize_approx || (f?.tbr && dur ? Math.round(f.tbr * 125 * dur) : 0);
  const bestOf = (list) => list.reduce((a, b) => ((b.tbr || 0) >= (a?.tbr || 0) ? b : a), null);
  const audioSize = sizeOf(bestOf(auds)) || null;
  const heights = [...new Set(vids.map((f) => f.height).filter(Boolean))].sort((a, b) => b - a);
  const sizes = { best: null, audio: audioSize };
  for (const h of heights) {
    const f = bestOf(vids.filter((x) => x.height === h && !/^(av01|vp0?9)/.test(x.vcodec || ''))) || bestOf(vids.filter((x) => x.height === h));
    const v = sizeOf(f);
    if (v) sizes[h] = v + (f.acodec && f.acodec !== 'none' ? 0 : audioSize || 0);
  }
  if (heights.length) sizes.best = sizes[heights[0]] || null;
  const noFormats = !formats.length;
  const audioExt = /^(mp3|m4a|aac|opus|ogg|wav|flac)$/.test(d.ext || '');
  return {
    type: 'video', url: d.webpage_url && !referer ? d.webpage_url : url,
    title: d.title || d.fulltitle || hostOf(url), uploader: d.uploader || d.channel || d.creator || null,
    site: d.extractor_key === 'Generic' ? hostOf(referer || url) : (d.extractor_key || hostOf(url)),
    duration: dur, thumbnail: pickThumb(d), isLive: !!d.is_live,
    hasVideo: vids.length > 0 || (noFormats && !audioExt), hasAudio: true,
    heights: heights.slice(0, 9), sizes, strategy, referer: referer || null, alternates: [],
  };
}

async function probeOnce(url, { token, referer, preferred } = {}) {
  const chain = chainFor(url, preferred);
  let last = '', thin = null;
  for (const s of chain) {
    if (token) broadcast({ type: 'probe', token, step: thin ? 'Looking for higher quality' : s.label });
    const args = ['-J', '--flat-playlist', '--no-playlist', '--no-warnings', '--playlist-end', '300',
      '--socket-timeout', '20', ...s.args, ...(referer ? ['--referer', referer] : []), '--', url];
    const r = await run('yt-dlp', args, { timeout: 120000 });
    if (r.code === 0 && r.out.trim().startsWith('{')) {
      try {
        const info = normalize(JSON.parse(r.out), url, s.id, referer);
        if (info.type === 'playlist' && !info.count) throw new Error('empty');
        // A throttled YouTube session only offers 360p. Keep it as a fallback and try the next route.
        const top = info.type === 'video' && info.hasVideo ? info.heights[0] || 0 : 9999;
        if (isYouTube(url) && top < 720 && s !== chain[chain.length - 1]) {
          if (!thin || top > (thin.heights[0] || 0)) thin = info;
          continue;
        }
        if (thin && top <= (thin.heights[0] || 0)) continue;
        remember(url, s.id);
        return info;
      } catch { last = 'ERROR: No media found'; }
    } else last = r.err || 'ERROR: yt-dlp is not installed or did not start';
    const ex = explain(last);
    if (ex.fatal || ex.code === 'unsupported') break;
  }
  if (thin) return thin;
  throw Object.assign(new Error('probe failed'), { detail: explain(last) });
}

// Last resort for pages no extractor understands: read the page and look for media ourselves.
async function scanPage(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const ct = res.headers.get('content-type') || '';
  if (/^(video|audio)\//.test(ct) || /mpegurl|dash\+xml/.test(ct)) return [{ url: res.url, label: 'Direct file' }];
  if (!/html|xml|json|text/.test(ct)) return [];
  const html = (await res.text()).slice(0, 4_000_000)
    .replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const found = new Map();
  const add = (u, label) => {
    try {
      const abs = new URL(u.trim(), res.url);
      if (!/^https?:$/.test(abs.protocol)) return;
      if (!found.has(abs.href)) found.set(abs.href, label);
    } catch {}
  };
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream|og:audio(?::secure_url|:url)?)["'][^>]*content=["']([^"']+)["']/gi)) add(m[1], 'Page video');
  for (const m of html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["']/gi)) add(m[1], 'Page video');
  for (const m of html.matchAll(/<(?:video|audio|source)[^>]+src=["']([^"']+)["']/gi)) if (!/^(blob|data):/.test(m[1])) add(m[1], 'Embedded player');
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\)]+?\.(m3u8|mpd|mp4|webm|mov|m4v|mp3|m4a)(\?[^\s"'<>\\)]*)?/gi)) add(m[0], m[1].toUpperCase() + ' stream');
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    if (/youtube(-nocookie)?\.com\/embed|player\.vimeo|dailymotion\.com\/embed|jwplatform|jwplayer|brightcove|wistia|streamable\.com|rumble\.com\/embed|facebook\.com\/plugins\/video|ted\.com|soundcloud\.com|twitch\.tv|vidyard|loom\.com|kaltura|mux\.com|bunny|cloudflarestream|videodelivery|spotify\.com\/embed/i.test(m[1])) add(m[1], 'Embedded ' + hostOf(new URL(m[1], res.url).href));
  }
  const rank = (u) => (/\.m3u8|\.mpd/.test(u) ? 0 : /embed|player/.test(u) ? 1 : 2);
  return [...found].map(([u, label]) => ({ url: u, label })).sort((a, b) => rank(a.url) - rank(b.url)).slice(0, 12);
}

async function probe(url, token) {
  try {
    return await probeOnce(url, { token });
  } catch (e) {
    const detail = e.detail || explain('');
    if (detail.fatal) throw e;
    if (token) broadcast({ type: 'probe', token, step: 'Reading the page for embedded media' });
    let candidates = [];
    try { candidates = await scanPage(url); } catch {}
    for (const c of candidates.slice(0, 4)) {
      try {
        if (token) broadcast({ type: 'probe', token, step: `Checking ${c.label.toLowerCase()}` });
        const info = await probeOnce(c.url, { referer: url });
        if (info.type === 'video') {
          info.alternates = candidates;
          if (!info.title || info.title === hostOf(c.url) || /^(master|index|playlist|video|manifest)/i.test(info.title)) info.title = await pageTitle(url) || info.title;
        }
        return info;
      } catch {}
    }
    throw e;
  }
}
async function pageTitle(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
    const html = (await res.text()).slice(0, 300000);
    const m = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m ? m[1].replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, '’').replace(/&quot;/g, '"').trim().slice(0, 160) : null;
  } catch { return null; }
}

// ───────────────────────── downloads ─────────────────────────
const PRG = 'download:PRG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s';
const num = (v) => (v && v !== 'NA' && !Number.isNaN(Number(v)) ? Number(v) : null);
const stamp = (t) => {
  const s = Math.max(0, Math.round(t * 10) / 10);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = (s % 60).toFixed(1).replace(/\.0$/, '');
  return (h ? `${h}h` : '') + `${m}m${r}s`;
};

function buildArgs(job, strat, slow) {
  const a = ['--newline', '--color', 'never', '--no-quiet', '--progress', '--no-warnings',
    '--progress-template', PRG,
    '--print', 'before_dl:META|%(.{title,thumbnail,duration,extractor_key})j',
    '--print', 'after_move:FILE|%(filepath)s',
    '-P', settings.downloadDir,
    '--retries', '10', '--fragment-retries', '10', '--extractor-retries', '3',
    '--retry-sleep', 'exp=1:30', '--socket-timeout', '30', '-N', '4',
    '--no-mtime', '--embed-metadata', ...strat.args];
  const clip = job.trim ? ` (clip ${stamp(job.trim.start)}-${stamp(job.trim.end)})` : '';
  // Some sites (Instagram, Threads) return the raw media ID as the title — name those by the account.
  const junkTitle = job.title && job.title !== job.url && !/\s/.test(job.title) && job.title.length > 40;
  const name = junkTitle ? 'Video by %(uploader,channel,uploader_id|unknown).80B' : '%(title).120B';
  a.push('-o', `${name} [%(id).32B]${clip}.%(ext)s`, '--trim-filenames', '200');
  if (job.playlistItem) a.push('--yes-playlist', '--playlist-items', String(job.playlistItem));
  else a.push('--no-playlist');
  if (job.referer) a.push('--referer', job.referer);
  if (settings.rateLimit) a.push('-r', settings.rateLimit);
  if (slow) a.push('--sleep-requests', '1.5', '--sleep-interval', '2');
  if (job.kind === 'audio') {
    a.push('-f', 'ba/b', '-x', '--audio-format', job.audioFormat || 'mp3', '--audio-quality', '0');
    if (job.audioFormat !== 'wav') a.push('--embed-thumbnail');
  } else {
    const h = job.height;
    a.push('-f', h ? `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b` : 'bv*+ba/b');
    const c = job.container === 'mkv' ? 'mkv' : 'mp4';
    a.push('-S', c === 'mp4' ? `res${h ? ':' + h : ''},vcodec:h264,acodec:aac` : `res${h ? ':' + h : ''}`);
    a.push('--merge-output-format', c, '--remux-video', c);
    if (job.subtitles) a.push('--write-subs', '--write-auto-subs', '--sub-langs', settings.subLangs || 'en', '--convert-subs', 'srt');
  }
  if (job.trim) {
    a.push('--download-sections', `*${job.trim.start.toFixed(2)}-${job.trim.end.toFixed(2)}`);
    if (job.trim.exact || job.kind === 'audio') a.push('--force-keyframes-at-cuts', '--downloader-args', 'ffmpeg:-crf 18 -preset veryfast');
  }
  a.push('--', job.url);
  return a;
}

function onDownloadLine(job, line) {
  if (line.startsWith('PRG|')) {
    const [, done, total, est, speed, eta] = line.split('|');
    const t = num(total) || num(est);
    job.pct = t && num(done) != null ? Math.min(100, (num(done) / t) * 100) : job.pct;
    job.speed = num(speed); job.eta = num(eta);
    if (!job.trim) return emitJob(job, false);
    return;
  }
  if (line.startsWith('META|')) {
    try {
      const m = JSON.parse(line.slice(5));
      if (m.title && (!job.title || job.title === job.url)) job.title = m.title;
      if (m.thumbnail && !job.thumbnail) { job.thumbnail = m.thumbnail; cacheThumb(job); }
      if (m.duration && !job.duration) job.duration = m.duration;
      if (m.extractor_key && !job.site) job.site = m.extractor_key;
    } catch {}
    return emitJob(job);
  }
  if (line.startsWith('FILE|')) { job.file = line.slice(5).trim(); return; }
  const ff = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (ff && job.trim) { // ffmpeg is doing the cut: progress = encoded time / clip length
    const t = +ff[1] * 3600 + +ff[2] * 60 + +ff[3];
    job.pct = Math.min(100, (t / Math.max(0.1, job.trim.end - job.trim.start)) * 100);
    job.speed = null; job.eta = null;
    return emitJob(job, false);
  }
  const dest = line.match(/^\[download\] Destination: (.+)$/);
  if (dest) {
    job.passes = (job.passes || 0) + 1;
    const audioPass = /\.(m4a|opus|mp3|aac|ogg)$|\.f\d+\.(m4a|webm)$/.test(dest[1]) && job.passes > 1;
    job.phase = job.trim ? 'Cutting the clip' : job.kind === 'audio' ? 'Downloading audio' : audioPass ? 'Downloading audio' : 'Downloading video';
    job.pct = job.trim ? null : 0;
    return emitJob(job);
  }
  const pp = line.match(/^\[(Merger|ExtractAudio|VideoRemuxer|VideoConvertor|EmbedThumbnail|Metadata|FixupM3u8|FixupM4a|FixupTimestamp|FixupDuration|EmbedSubtitle|SubtitlesConvertor|MoveFiles)\]/);
  if (pp) {
    const map = { Merger: 'Merging', ExtractAudio: 'Converting audio', VideoRemuxer: 'Remuxing', VideoConvertor: 'Converting' };
    job.phase = map[pp[1]] || 'Finishing'; job.pct = null; job.speed = null; job.eta = null;
    return emitJob(job);
  }
  if (/^\[download\] Sleeping|Retrying/.test(line)) { job.phase = 'Waiting to retry'; emitJob(job, false); }
}

async function ffprobe(file) {
  const r = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeout: 30000 });
  try { return JSON.parse(r.out); } catch { return null; }
}

// Premiere, After Effects and QuickTime do not open VP9/AV1. Convert only when needed.
async function makeEditReady(job) {
  if (job.kind !== 'video' || job.container !== 'mp4' || !settings.editReady || !job.file || !fs.existsSync(job.file)) return;
  const info = await ffprobe(job.file);
  if (!info?.streams) return;
  const v = info.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const au = info.streams.find((s) => s.codec_type === 'audio');
  const vOk = !v || v.codec_name === 'h264';
  const aOk = !au || ['aac', 'mp3', 'alac'].includes(au.codec_name);
  if (vOk && aOk) return;
  const dur = Number(info.format?.duration) || job.duration || 0;
  const tmp = job.file.replace(/\.mp4$/i, '') + '.converting.mp4';
  job.phase = vOk ? 'Converting audio to AAC' : 'Converting to H.264'; job.pct = 0; job.speed = null; job.eta = null;
  emitJob(job);
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', '-i', job.file, '-map', '0:v:0?', '-map', '0:a:0?',
    ...(vOk ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']),
    ...(aOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']), '-movflags', '+faststart', tmp];
  const r = await run('ffmpeg', args, {
    holder: job,
    onLine: (line) => {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m && dur) { job.pct = Math.min(100, (Number(m[1]) / 1e6 / dur) * 100); emitJob(job, false); }
    },
  });
  if (r.code === 0 && fs.existsSync(tmp) && !job.canceled) await fsp.rename(tmp, job.file);
  else fsp.rm(tmp, { force: true }).catch(() => {});
}

async function cacheThumb(job) {
  if (!job.thumbnail || job.thumbLocal) return;
  try {
    const res = await fetch(job.thumbnail, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8_000_000) return;
    await fsp.writeFile(path.join(THUMBS, job.id + '.jpg'), buf);
    job.thumbLocal = true;
    emitJob(job);
  } catch {}
}

async function runJob(job) {
  job.state = 'running'; job.phase = 'Starting'; job.pct = null; job.error = null; job.passes = 0;
  emitJob(job);
  await fsp.mkdir(settings.downloadDir, { recursive: true }).catch(() => {});
  const chain = chainFor(job.url, job.strategy);
  let slow = false, lastErr = '', ok = false;
  for (let i = 0; i < chain.length && !job.canceled; i++) {
    const s = chain[i];
    if (i > 0) { job.phase = s.label; job.pct = null; emitJob(job); }
    job.passes = 0;
    const r = await run('yt-dlp', buildArgs(job, s, slow), { holder: job, onLine: (l) => onDownloadLine(job, l) });
    if (job.canceled) break;
    if (r.code === 0 || (job.file && fs.existsSync(job.file))) { ok = true; remember(job.url, s.id); job.strategy = s.id; break; }
    lastErr = r.err;
    const ex = explain(lastErr);
    if (ex.fatal) break;
    if (ex.code === 'rate' && !slow) {
      slow = true; job.phase = 'Waiting — rate limited'; job.pct = null; emitJob(job);
      await sleep(15000); i--;
    }
  }
  if (ok && !job.canceled) await makeEditReady(job);
  job.child = null; job.speed = null; job.eta = null; job.finishedAt = Date.now();
  if (job.canceled) { job.state = 'canceled'; job.phase = 'Canceled'; job.pct = null; }
  else if (ok) {
    job.state = 'done'; job.phase = 'Saved'; job.pct = 100;
    try { job.size = fs.statSync(job.file).size; } catch { job.size = null; }
  } else {
    job.state = 'error'; job.phase = 'Failed'; job.pct = null;
    const { message, hint } = explain(lastErr);
    job.error = { message, hint };
  }
  emitJob(job); saveHistory(); pump();
}
function pump() {
  const running = [...jobs.values()].filter((j) => j.state === 'running').length;
  const free = Math.max(1, Math.min(4, settings.concurrency || 2)) - running;
  [...jobs.values()].filter((j) => j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.max(0, free)).forEach(runJob);
}
function addJob(b) {
  const trim = b.trim && Number.isFinite(+b.trim.start) && Number.isFinite(+b.trim.end) && +b.trim.end > +b.trim.start
    ? { start: Math.max(0, +b.trim.start), end: +b.trim.end, exact: !!b.trim.exact } : null;
  const job = {
    id: crypto.randomBytes(6).toString('hex'), url: b.url, title: (b.title || b.url).slice(0, 300),
    thumbnail: b.thumbnail || null, thumbLocal: false, site: b.site || hostOf(b.url), duration: b.duration || null,
    strategy: b.strategy || null, referer: b.referer || null, playlistItem: b.playlistItem || null,
    kind: b.kind === 'audio' ? 'audio' : 'video', height: Number(b.height) || null,
    container: b.container === 'mkv' ? 'mkv' : 'mp4',
    audioFormat: ['mp3', 'm4a', 'wav'].includes(b.audioFormat) ? b.audioFormat : 'mp3',
    trim, subtitles: !!b.subtitles, state: 'queued', phase: 'Queued', pct: null, speed: null, eta: null,
    size: null, file: null, missing: false, error: null, createdAt: Date.now(), finishedAt: null,
  };
  jobs.set(job.id, job);
  emitJob(job); cacheThumb(job); pump();
  return job;
}

// ───────────────────────── preview ─────────────────────────
const previews = new Map();
const stripPath = (key) => path.join(CACHE, key + '.strip.jpg');
async function startPreview(url, strategy, referer) {
  const key = sha(url);
  const file = path.join(CACHE, key + '.mp4');
  if (fs.existsSync(file)) {
    if (!fs.existsSync(stripPath(key))) makeStrip(key, file);
    return { key, state: 'ready', pct: 100, strip: fs.existsSync(stripPath(key)) };
  }
  const cur = previews.get(key);
  if (cur?.state === 'downloading') return { key, state: 'downloading', pct: cur.pct, strip: false };
  const p = { state: 'downloading', pct: 0 };
  previews.set(key, p);
  (async () => {
    const chain = chainFor(url, strategy);
    let last = '';
    for (const s of chain) {
      const args = ['--newline', '--color', 'never', '--no-playlist', '--no-warnings', '--progress-template', PRG,
        '-f', 'bv*+ba/b', '-S', 'res:360,vcodec:h264,acodec:aac', '--merge-output-format', 'mp4', '--remux-video', 'mp4',
        '-N', '8', '--retries', '5', '--fragment-retries', '5', '-o', path.join(CACHE, key + '.%(ext)s'),
        ...s.args, ...(referer ? ['--referer', referer] : []), '--', url];
      let pass = 0, sent = 0;
      const r = await run('yt-dlp', args, {
        onLine: (line) => {
          if (/^\[download\] Destination/.test(line)) pass++;
          if (!line.startsWith('PRG|')) return;
          const [, done, total, est] = line.split('|');
          const t = num(total) || num(est);
          if (!t) return;
          const frac = num(done) / t;
          p.pct = Math.min(99, pass <= 1 ? frac * 85 : 85 + frac * 14); // video pass, then audio pass
          if (Date.now() - sent > 200) { sent = Date.now(); broadcast({ type: 'preview', key, state: 'downloading', pct: p.pct }); }
        },
      });
      if (r.code === 0 && fs.existsSync(file)) {
        p.state = 'ready'; p.pct = 100;
        broadcast({ type: 'preview', key, state: 'ready', pct: 100 });
        makeStrip(key, file);
        return;
      }
      last = r.err;
      if (explain(last).fatal) break;
    }
    p.state = 'error';
    const ex = explain(last);
    broadcast({ type: 'preview', key, state: 'error', pct: 0, message: `${ex.message} You can still set the clip times by hand.` });
  })();
  return { key, state: 'downloading', pct: 0, strip: false };
}
async function makeStrip(key, file) {
  const info = await ffprobe(file);
  const dur = Number(info?.format?.duration);
  if (!dur) return;
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vf', `fps=${(24 / dur).toFixed(6)},scale=128:72:force_original_aspect_ratio=increase,crop=128:72,tile=24x1`,
    '-frames:v', '1', '-q:v', '6', stripPath(key)], { timeout: 120000 });
  if (r.code === 0 && fs.existsSync(stripPath(key))) broadcast({ type: 'strip', key });
}
async function sweepCache() {
  const now = Date.now();
  for (const f of await fsp.readdir(CACHE).catch(() => [])) {
    const p = path.join(CACHE, f);
    const st = await fsp.stat(p).catch(() => null);
    if (st && now - st.mtimeMs > 2 * 86400e3) fsp.rm(p, { force: true }).catch(() => {});
  }
}

// ───────────────────────── engine ─────────────────────────
let engine = { ytdlp: null, ageDays: null, ffmpeg: null, brew: false, updating: false };
async function refreshEngine() {
  const [v, f, w] = await Promise.all([
    run('yt-dlp', ['--version'], { timeout: 20000 }),
    run('ffmpeg', ['-version'], { timeout: 20000 }),
    WIN ? Promise.resolve({ out: '' })
      : run('/bin/sh', ['-c', 'readlink -f "$(command -v yt-dlp)" 2>/dev/null || command -v yt-dlp'], { timeout: 5000 }),
  ]);
  const ver = v.code === 0 ? v.out.trim() : null;
  const m = ver && ver.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  engine = {
    ...engine, ytdlp: ver,
    ageDays: m ? Math.max(0, Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400e3)) : null,
    ffmpeg: f.code === 0 ? (f.out.match(/ffmpeg version (\S+)/) || [])[1] || 'installed' : null,
    brew: /Cellar|homebrew|linuxbrew/i.test(w.out),
  };
  return engine;
}
async function updateEngine() {
  if (engine.updating) return;
  engine.updating = true;
  broadcast({ type: 'engine', engine, line: 'Checking for a newer engine…' });
  const onLine = (line) => broadcast({ type: 'engine', engine, line: line.slice(0, 200) });
  const r = engine.brew
    ? await run('brew', ['upgrade', 'yt-dlp'], { onLine, timeout: 600000 })
    : await run('yt-dlp', ['-U'], { onLine, timeout: 600000 });
  engine.updating = false;
  const before = engine.ytdlp;
  await refreshEngine();
  broadcast({ type: 'engine', engine, line: r.code !== 0 ? (engine.brew ? 'The update did not finish. Run “brew upgrade yt-dlp” in Terminal.' : 'The update did not finish. Check your connection and try again.') : engine.ytdlp === before ? `Already on the latest release (${engine.ytdlp}).` : `Updated to ${engine.ytdlp}.` });
}

// ───────────────────────── http ─────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.json': 'application/json' };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (res, code, message, hint) => json(res, code, { error: { message, hint } });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function sendFile(req, res, file, cache = 'no-cache') {
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start); end = Math.min(end, st.size - 1);
      if (start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1, 'cache-control': cache });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': cache });
    fs.createReadStream(file).pipe(res);
  });
}
const isPrivateHost = (h) => /^(localhost|.*\.local|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(h);
const cleanUrl = (u) => {
  try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
};

async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    clients.add(res);
    const beat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); clients.delete(res); });
    return;
  }
  if (p === '/api/state' && m === 'GET') {
    for (const j of jobs.values()) if (j.state === 'done') j.missing = !(j.file && fs.existsSync(j.file));
    if (!engine.ytdlp) await refreshEngine();
    return json(res, 200, { settings, engine, jobs: [...jobs.values()].map(publicJob) });
  }
  if (p === '/api/thumb' && m === 'GET') {
    const u = cleanUrl(url.searchParams.get('u'));
    if (!u || isPrivateHost(new URL(u).hostname)) { res.writeHead(400); return res.end(); }
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\//.test(type)) { res.writeHead(404); return res.end(); }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=86400' });
      return res.end(buf);
    } catch { res.writeHead(404); return res.end(); }
  }
  if (m !== 'POST' && m !== 'DELETE') return fail(res, 405, 'Method not allowed');
  if (m === 'POST' && !/application\/json/.test(req.headers['content-type'] || '')) return fail(res, 415, 'Expected JSON');
  const body = m === 'POST' ? await readBody(req) : {};

  if (p === '/api/probe') {
    const u = cleanUrl(body.url);
    if (!u) return fail(res, 400, 'That does not look like a link.', 'Paste the full address of the page or post, starting with https://');
    try { return json(res, 200, await probe(u, body.token)); }
    catch (e) {
      const d = e.detail || { message: 'Could not read that link.', hint: 'Check the address and try again.' };
      return fail(res, 422, d.message, d.hint);
    }
  }
  if (p === '/api/preview') {
    const u = cleanUrl(body.url);
    if (!u) return fail(res, 400, 'Missing link');
    return json(res, 200, await startPreview(u, body.strategy, cleanUrl(body.referer)));
  }
  if (p === '/api/download') {
    const u = cleanUrl(body.url);
    if (!u) return fail(res, 400, 'That does not look like a link.');
    return json(res, 200, { job: publicJob(addJob({ ...body, url: u, referer: cleanUrl(body.referer) })) });
  }
  if (p === '/api/jobs/clear') {
    for (const j of [...jobs.values()]) if (['done', 'error', 'canceled'].includes(j.state)) { jobs.delete(j.id); broadcast({ type: 'jobRemoved', id: j.id }); fsp.rm(path.join(THUMBS, j.id + '.jpg'), { force: true }).catch(() => {}); }
    saveHistory();
    return json(res, 200, { ok: true });
  }
  const jm = p.match(/^\/api\/jobs\/([a-f0-9]+)(?:\/(cancel|retry|reveal|open))?$/);
  if (jm) {
    const job = jobs.get(jm[1]);
    if (!job) return fail(res, 404, 'That download is no longer in the list.');
    const act = m === 'DELETE' ? 'delete' : jm[2];
    if (act === 'cancel') {
      job.canceled = true;
      if (job.state === 'queued') { job.state = 'canceled'; job.phase = 'Canceled'; job.finishedAt = Date.now(); emitJob(job); saveHistory(); }
      else killTree(job.child);
    } else if (act === 'retry') {
      if (job.state === 'running' || job.state === 'queued') return json(res, 200, { ok: true });
      Object.assign(job, { canceled: false, state: 'queued', phase: 'Queued', pct: null, error: null, file: null, size: null, missing: false, finishedAt: null, strategy: null });
      emitJob(job); pump();
    } else if (act === 'reveal' || act === 'open') {
      if (!job.file || !fs.existsSync(job.file)) { job.missing = true; emitJob(job); return fail(res, 410, 'The file was moved or deleted.'); }
      if (WIN) run('explorer.exe', act === 'reveal' ? [`/select,${job.file}`] : [job.file]);
      else run('open', act === 'reveal' ? ['-R', job.file] : [job.file]);
    } else if (act === 'delete') {
      if (job.state === 'running') { job.canceled = true; killTree(job.child); }
      jobs.delete(job.id); broadcast({ type: 'jobRemoved', id: job.id }); saveHistory();
      fsp.rm(path.join(THUMBS, job.id + '.jpg'), { force: true }).catch(() => {});
    } else return fail(res, 404, 'Unknown action');
    return json(res, 200, { ok: true });
  }
  if (p === '/api/settings') {
    const next = { ...settings };
    const str = (k, max = 600) => { if (typeof body[k] === 'string') next[k] = body[k].trim().slice(0, max); };
    str('cookiesFile'); str('subLangs', 60);
    if (typeof body.downloadDir === 'string' && body.downloadDir.trim()) next.downloadDir = body.downloadDir.trim().replace(/^~(?=\/|$)/, os.homedir());
    if (['off', 'browser', 'file'].includes(body.cookiesMode)) next.cookiesMode = body.cookiesMode;
    if (['safari', 'chrome', 'firefox', 'brave', 'edge', 'chromium', 'opera', 'vivaldi'].includes(body.cookiesBrowser)) next.cookiesBrowser = body.cookiesBrowser;
    if (Number(body.concurrency)) next.concurrency = Math.max(1, Math.min(4, Math.round(Number(body.concurrency))));
    if (typeof body.rateLimit === 'string') next.rateLimit = /^\d+(\.\d+)?[KMG]?$/i.test(body.rateLimit.trim()) ? body.rateLimit.trim().toUpperCase() : '';
    for (const k of ['editReady', 'exactTrim']) if (typeof body[k] === 'boolean') next[k] = body[k];
    if (['auto', 'light', 'dark'].includes(body.theme)) next.theme = body.theme;
    if (body.preset && typeof body.preset === 'object') {
      const b = body.preset;
      next.preset = {
        kind: b.kind === 'audio' ? 'audio' : 'video', height: Number(b.height) || null,
        container: b.container === 'mkv' ? 'mkv' : 'mp4',
        audioFormat: ['mp3', 'm4a', 'wav'].includes(b.audioFormat) ? b.audioFormat : 'mp3',
      };
    }
    settings = next;
    writeJson('settings.json', () => settings);
    broadcast({ type: 'settings', settings });
    pump();
    return json(res, 200, { settings });
  }
  if (p === '/api/pick-folder') {
    const r = WIN
      ? await run('powershell.exe', ['-NoProfile', '-STA', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; $o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "Save downloads to"; if ($d.ShowDialog($o) -eq "OK") { $d.SelectedPath }'], { timeout: 300000 })
      : await run('osascript', ['-e', 'tell application "System Events" to activate', '-e', 'POSIX path of (choose folder with prompt "Save downloads to")'], { timeout: 300000 });
    return json(res, 200, { path: r.code === 0 && r.out.trim() ? r.out.trim().replace(/\/$/, '') : null });
  }
  if (p === '/api/engine/update') { updateEngine(); return json(res, 200, { ok: true }); }
  return fail(res, 404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  try {
    // Only this machine's browser may talk to the server (blocks other sites and DNS rebinding).
    if (!HOSTS.has(req.headers.host || '')) { res.writeHead(403); return res.end('Forbidden'); }
    const origin = req.headers.origin;
    if (origin && !HOSTS.has(origin.replace(/^https?:\/\//, ''))) { res.writeHead(403); return res.end('Forbidden'); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let m;
    if ((m = url.pathname.match(/^\/media\/preview\/([a-f0-9]{16})\.mp4$/))) return sendFile(req, res, path.join(CACHE, m[1] + '.mp4'), 'max-age=3600');
    if ((m = url.pathname.match(/^\/media\/strip\/([a-f0-9]{16})\.jpg$/))) return sendFile(req, res, stripPath(m[1]), 'max-age=3600');
    if ((m = url.pathname.match(/^\/media\/thumb\/([a-f0-9]+)\.jpg$/))) return sendFile(req, res, path.join(THUMBS, m[1] + '.jpg'), 'max-age=86400');
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC, rel === '/' || rel === path.sep ? 'index.html' : rel);
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    sendFile(req, res, file);
  } catch (e) {
    if (!res.headersSent) fail(res, 500, 'Something went wrong inside the app.', String(e.message || e));
    else res.end();
  }
});

const openBrowser = () => process.argv.includes('--open') && run(WIN ? 'explorer.exe' : 'open', [`http://localhost:${PORT}`]);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`Already running at http://localhost:${PORT}`); openBrowser(); setTimeout(() => process.exit(0), 500); }
  else throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Media Downloader is running at http://localhost:${PORT}`);
  // Anything that was mid-flight when the app last closed can simply be retried.
  for (const j of jobs.values()) if (j.state === 'running' || j.state === 'queued') { j.state = 'canceled'; j.phase = 'Interrupted'; }
  refreshEngine(); sweepCache(); openBrowser();
});
const shutdown = () => { for (const c of children) killTree(c); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Inside the Mac app: stop when the app goes away, even if it crashed.
const parent = Number(process.env.MD_PARENT_PID);
if (parent) setInterval(() => { try { process.kill(parent, 0); } catch { shutdown(); } }, 2000).unref();
