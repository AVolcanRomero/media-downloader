# Media Downloader

Save video and audio from almost any web page: YouTube, Instagram, X, LinkedIn, Substack, TED, news sites and about 1,800 others. Trim the exact clip you want before it downloads, with a live preview. Runs entirely on your computer: no account, no API key, no quota.

A native Mac app and a Windows app, built on [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org), with a Swiss-style black, white and green interface.

## Download

Get the latest installers from [Releases](../../releases/latest).

**Mac** (macOS 13 or later)

1. Install the engine once with [Homebrew](https://brew.sh): `brew install node yt-dlp ffmpeg`
2. Open `Media Downloader for Mac.dmg` and drag the app to Applications.
3. The app is not notarised by Apple, so the first time, right-click it and choose **Open**, or go to System Settings → Privacy & Security → **Open Anyway**.

**Windows** (10 or 11)

1. Unzip `Media Downloader for Windows.zip` and double-click **Install Media Downloader**. If SmartScreen warns you, choose **More info → Run anyway**.
2. Setup downloads its engine (portable Node.js, yt-dlp and ffmpeg, about 110 MB) into `%LOCALAPPDATA%\Media Downloader`. No admin rights, nothing preinstalled.
3. Open **Media Downloader** from the Start menu or Desktop. It runs in its own Edge app window. Closing the window stops the engine, and it asks first if downloads are running.

Run Install again to update; settings and history are kept. **Uninstall Media Downloader** removes it and leaves your downloaded files alone. For signed-in cookies on Windows, use Firefox or a `cookies.txt`: Chrome and Edge lock their cookies while open.

Mac shortcuts: ⌘N new link, ⌘, settings, ⇧⌘O open the downloads folder, ⌘+ / ⌘− zoom.

## Build from source

Needs `node`, `yt-dlp` and `ffmpeg`; the Mac app also needs Xcode's command-line tools (`xcode-select --install`).

    node server.js --open    # run in a browser while developing
    ./mac/build.sh           # build the Mac app into /Applications and dist/*.dmg
    ./windows/package.sh     # build dist/Media Downloader for Windows.zip

## What it does

- Paste a link from YouTube, Instagram, X, LinkedIn, Substack, TED, news sites and about 1,800 others. Paste several links at once to queue them all.
- Pages no extractor recognises are read directly for embedded players and stream files.
- Trim with in/out handles, typed times, or the keyboard (Space, I, O, arrow keys). "Load preview" fetches a small copy so you can scrub; only the clip is downloaded at full quality.
- Video up to the best resolution on offer, as MP4 or MKV. Audio as MP3, M4A or WAV.
- "Edit-ready H.264" converts VP9/AV1 downloads so Premiere, After Effects and QuickTime open them.
- Playlists and channels: pick the entries you want.
- The download list survives restarts. Files go to `~/Downloads/Media Downloader` unless you change it in Settings.

## Why it keeps working

There is no API key, account or quota. Everything runs on this Mac through yt-dlp.

- **Fallback chain.** Each link is tried by several routes in turn (plain request, alternate player clients, browser impersonation, your signed-in cookies). The route that worked is remembered per site.
- **Rate limits.** A rate-limited download waits, then retries slowly instead of failing.
- **Cookies.** Off by default. Turn on "Signed-in cookies" in Settings for posts that need a login (private Instagram, age-restricted YouTube, YouTube on a VPN). They are only used after the anonymous routes fail. Arc is not readable by yt-dlp; use Safari, or export a `cookies.txt` and point Settings at it.
- **Engine updates.** Sites change constantly; yt-dlp ships fixes every few weeks. Settings → Update engine runs `brew upgrade yt-dlp`. If a site suddenly stops working, do this first.

## Limits

- DRM-protected services (Netflix, Disney+, Spotify and similar) cannot be downloaded by any tool.
- YouTube throttles VPN and data-centre addresses. If quality tops out at 360p or it asks for a sign-in, switch the VPN off or turn on cookies.

## Use it responsibly

Download only what you have the right to keep: your own uploads, openly licensed media, or material you may save under the law where you live and the site's terms. This project does not bypass DRM and is not affiliated with any of the sites it works with.

## Files

- `server.js` — the whole backend
- `public/` — the interface
- `mac/` — the native window (Swift), icon, Info.plist and build script
- `windows/` — installer, launcher, icon and the script that packs the Windows zip
- `~/Library/Application Support/Media Downloader/` — the app's settings, history, preview cache and engine log (cache is safe to delete)
- `data/` — the same, for the browser version used while developing
- `%LOCALAPPDATA%\Media Downloader\` — the Windows app, its engine and its data

## License

[MIT](LICENSE). yt-dlp is released under the Unlicense and ffmpeg under the LGPL/GPL; the Windows installer downloads them from their official sources at setup time.
