// Media Downloader — native macOS shell.
// Runs the bundled Node server (yt-dlp + ffmpeg backend) and shows the interface in a native window.
import Cocoa
import WebKit

let port = 4865
let base = URL(string: "http://localhost:\(port)/")!
let fm = FileManager.default
let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("Media Downloader", isDirectory: true)

/// Paths a Finder-launched app does not inherit from the shell.
let toolPath = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]

func findNode() -> String? {
    for dir in toolPath where fm.isExecutableFile(atPath: dir + "/node") { return dir + "/node" }
    let p = Process(); let pipe = Pipe()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "command -v node"]
    p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
    try? p.run(); p.waitUntilExit()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return out.isEmpty ? nil : out
}

/// Black in dark mode, white in light — matches the interface's paper colour.
let paper = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? .black : .white }

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        startServer()
    }

    // MARK: Server

    func startServer() {
        guard let node = findNode() else {
            return fatal("Node.js is not installed.", "Install it with Homebrew:  brew install node yt-dlp ffmpeg")
        }
        guard let res = Bundle.main.resourceURL?.appendingPathComponent("app") else { return }
        try? fm.createDirectory(at: support, withIntermediateDirectories: true)
        let log = support.appendingPathComponent("server.log")
        fm.createFile(atPath: log.path, contents: nil)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [res.appendingPathComponent("server.js").path]
        p.currentDirectoryURL = res
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = (toolPath + [(env["PATH"] ?? "")]).joined(separator: ":")
        env["PORT"] = String(port)
        env["MD_DATA"] = support.appendingPathComponent("data").path
        env["MD_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        p.environment = env
        if let h = try? FileHandle(forWritingTo: log) { p.standardOutput = h; p.standardError = h }
        do { try p.run() } catch {
            return fatal("The downloader engine could not start.", error.localizedDescription)
        }
        server = p
        waitForServer(tries: 0)
    }

    func waitForServer(tries: Int) {
        var req = URLRequest(url: base.appendingPathComponent("api/state"), timeoutInterval: 1)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if (resp as? HTTPURLResponse)?.statusCode == 200 {
                    self.web.load(URLRequest(url: base))
                } else if tries < 60 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitForServer(tries: tries + 1) }
                } else {
                    self.fatal("The downloader engine did not respond.",
                               "Details are in ~/Library/Application Support/Media Downloader/server.log")
                }
            }
        }.resume()
    }

    func fatal(_ title: String, _ detail: String) {
        let a = NSAlert(); a.messageText = title; a.informativeText = detail
        a.alertStyle = .critical; a.addButton(withTitle: "Quit")
        a.runModal(); NSApp.terminate(nil)
    }

    /// Number of downloads still queued or running, asked of the server.
    func activeJobs() -> Int {
        let sem = DispatchSemaphore(value: 0); var count = 0
        URLSession.shared.dataTask(with: URLRequest(url: base.appendingPathComponent("api/state"), timeoutInterval: 1)) { data, _, _ in
            if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let jobs = obj["jobs"] as? [[String: Any]] {
                count = jobs.filter { ["running", "queued"].contains($0["state"] as? String ?? "") }.count
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 1.5)
        return count
    }

    // MARK: Window

    func buildWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        cfg.mediaTypesRequiringUserActionForPlayback = []

        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = paper
        web.allowsMagnification = true

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 840),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Media Downloader"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = paper
        window.minSize = NSSize(width: 720, height: 560)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("Main")
        window.tabbingMode = .disallowed
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    // Links to other sites open in the default browser; the app only shows itself.
    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let local = ["localhost", "127.0.0.1"].contains(url.host ?? "") || url.scheme == "about"
        if local && action.targetFrame?.isMainFrame != false { return decisionHandler(.allow) }
        if action.targetFrame?.isMainFrame == false && local { return decisionHandler(.allow) }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }

    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    // MARK: Bridge  (window.webkit.messageHandlers.native.postMessage({cmd}))

    func userContentController(_ c: WKUserContentController, didReceive msg: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let cmd = (msg.body as? [String: Any])?["cmd"] as? String
        switch cmd {
        case "pickFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true; panel.canChooseFiles = false
            panel.canCreateDirectories = true; panel.prompt = "Choose"
            panel.message = "Save downloads to"
            panel.beginSheetModal(for: window) { r in
                let path: Any = (r == .OK ? panel.url?.path : nil) ?? NSNull()
                replyHandler(["path": path], nil)
            }
        default:
            replyHandler(nil, "Unknown command")
        }
    }

    // MARK: Menu actions

    @objc func reload(_ s: Any?) { web.reload() }
    @objc func zoomReset(_ s: Any?) { web.pageZoom = 1 }
    @objc func zoomIn(_ s: Any?) { web.pageZoom = min(2, web.pageZoom + 0.1) }
    @objc func zoomOut(_ s: Any?) { web.pageZoom = max(0.6, web.pageZoom - 0.1) }
    @objc func openDownloads(_ s: Any?) {
        URLSession.shared.dataTask(with: base.appendingPathComponent("api/state")) { data, _, _ in
            guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let dir = (obj["settings"] as? [String: Any])?["downloadDir"] as? String else { return }
            try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
            DispatchQueue.main.async { NSWorkspace.shared.open(URL(fileURLWithPath: dir)) }
        }.resume()
    }
    @objc func newLink(_ s: Any?) {
        window.makeKeyAndOrderFront(nil)
        web.evaluateJavaScript("(() => { const i = document.getElementById('url'); if (i) { window.scrollTo({top: 0}); i.focus(); i.select(); } })()")
    }
    @objc func showSettings(_ s: Any?) {
        web.evaluateJavaScript("document.getElementById('openSettings')?.click()")
    }
    @objc func showLog(_ s: Any?) { NSWorkspace.shared.open(support.appendingPathComponent("server.log")) }

    func buildMenu() {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) {
            let m = NSMenu(title: title); items.forEach(m.addItem)
            let host = NSMenuItem(); host.submenu = m; main.addItem(host)
        }
        func item(_ t: String, _ a: Selector?, _ k: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i
        }
        sub("Media Downloader", [
            item("About Media Downloader", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Settings…", #selector(showSettings(_:)), ","),
            .separator(),
            item("Hide Media Downloader", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Media Downloader", #selector(NSApplication.terminate(_:)), "q"),
        ])
        sub("File", [
            item("New Link", #selector(newLink(_:)), "n"),
            item("Open Downloads Folder", #selector(openDownloads(_:)), "o", [.command, .shift]),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        sub("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        sub("View", [
            item("Reload", #selector(reload(_:)), "r"),
            item("Actual Size", #selector(zoomReset(_:)), "0"),
            item("Zoom In", #selector(zoomIn(_:)), "+"),
            item("Zoom Out", #selector(zoomOut(_:)), "-"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let windowItems = [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
        ]
        sub("Window", windowItems)
        NSApp.windowsMenu = main.items.last?.submenu
        sub("Help", [item("Show Engine Log", #selector(showLog(_:)))])
        NSApp.helpMenu = main.items.last?.submenu
        NSApp.mainMenu = main
    }

    // MARK: Lifecycle

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ s: NSApplication) -> NSApplication.TerminateReply {
        let n = server == nil ? 0 : activeJobs()
        guard n > 0 else { return .terminateNow }
        let a = NSAlert()
        a.messageText = n == 1 ? "A download is still in progress." : "\(n) downloads are still in progress."
        a.informativeText = "Quitting stops them. You can retry them next time from the Downloads list."
        a.addButton(withTitle: "Quit"); a.addButton(withTitle: "Keep Downloading")
        return a.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }

    func applicationWillTerminate(_ n: Notification) {
        guard let p = server, p.isRunning else { return }
        p.terminate()                       // SIGTERM: the server stops yt-dlp/ffmpeg children itself
        let deadline = Date().addingTimeInterval(1.5)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
