import AppKit
import WebKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    var window: NSWindow!
    var web: WKWebView!
    var server: LocalServer!
    var files: NativeFiles!
    let player = NativePlayer()
    let io = DispatchQueue(label: "io.github.jaysonsheyue.diyfm.files")
    var busy = false
    var language = "en"
    var appMenu: NSMenu!
    var editMenu: NSMenu!
    var windowsMenu: NSMenu!
    var editMenuItem: NSMenuItem!
    var windowsMenuItem: NSMenuItem!
    func text(_ en: String, _ ja: String, _ zh: String) -> String { language == "ja" ? ja : language == "zh-CN" ? zh : en }
    func applicationDidFinishLaunching(_ note: Notification) {
        do {
            let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("DIYFM", isDirectory: true)
            files = try NativeFiles(root: root)
            let content = WKUserContentController(); content.addScriptMessageHandler(self, contentWorld: .page, name: "diyfm")
            let configuration = WKWebViewConfiguration(); configuration.userContentController = content; configuration.websiteDataStore = .default(); configuration.mediaTypesRequiringUserActionForPlayback = []
            web = WKWebView(frame: .zero, configuration: configuration); web.navigationDelegate = self; web.uiDelegate = self
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1160, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "DIYFM"; window.minSize = NSSize(width: 390, height: 600); window.contentView = web; window.delegate = self; window.center(); window.setFrameAutosaveName("DIYFM.Main")
            let menu = NSMenu(); let appItem = NSMenuItem(); menu.addItem(appItem); appMenu = NSMenu(); appItem.submenu = appMenu
            appMenu.addItem(withTitle: "About DIYFM", action: #selector(about), keyEquivalent: "").target = self
            appMenu.addItem(withTitle: "Download App Updates…", action: #selector(updates), keyEquivalent: "").target = self
            appMenu.addItem(.separator()); appMenu.addItem(withTitle: "Hide DIYFM", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
            appMenu.addItem(withTitle: "Quit DIYFM", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            let editItem = NSMenuItem(); editItem.title = "Edit"; menu.addItem(editItem); let edit = NSMenu(title: "Edit"); editItem.submenu = edit; editMenu = edit; editMenuItem = editItem
            for (title, selector, key) in [("Undo", Selector(("undo:")), "z"), ("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: title, action: selector, keyEquivalent: key) }
            let windowItem = NSMenuItem(); windowItem.title = "Window"; menu.addItem(windowItem)
            let windowMenu = NSMenu(title: "Window"); windowItem.submenu = windowMenu; windowsMenu = windowMenu; windowsMenuItem = windowItem
            windowMenu.addItem(withTitle: "Show DIYFM", action: #selector(showMain), keyEquivalent: "0").target = self
            NSApp.mainMenu = menu
            guard let resources = Bundle.main.resourceURL else { throw NSError(domain: "DIYFM.Resources", code: 1) }
            server = LocalServer(root: resources.appendingPathComponent("web"))
            server.start { [weak self] error in
                guard let self = self else { return }
                if error != nil { self.fail("DIYFM could not start its private local web server. Port 24618 may already be in use. Quit the other DIYFM instance and reopen."); return }
                self.web.load(URLRequest(url: URL(string: LocalServer.origin + "/")!)); self.window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
            }
        } catch { fail("DIYFM could not open its local application data. Existing programs have not been removed.") }
    }
    func fail(_ message: String) { let alert = NSAlert(); alert.messageText = "DIYFM"; alert.informativeText = message; alert.runModal(); NSApp.terminate(nil) }
    @objc func showMain() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func localizeMenus() {
        guard let application = appMenu, let edit = editMenu, let windows = windowsMenu else { return }
        let labels = [text("About DIYFM", "DIYFMについて", "关于 DIYFM"), text("Download App Updates…", "アプリの更新をダウンロード…", "下载客户端更新…"), "", text("Hide DIYFM", "DIYFMを隠す", "隐藏 DIYFM"), text("Quit DIYFM", "DIYFMを終了", "退出 DIYFM")]
        for (i,label) in labels.enumerated() where i < application.items.count && !label.isEmpty { application.items[i].title = label }
        editMenuItem.title = text("Edit", "編集", "编辑"); edit.title = editMenuItem.title
        let edits = [text("Undo", "取り消す", "撤销"), text("Cut", "カット", "剪切"), text("Copy", "コピー", "复制"), text("Paste", "ペースト", "粘贴"), text("Select All", "すべてを選択", "全选")]
        for (i,label) in edits.enumerated() where i < edit.items.count { edit.items[i].title = label }
        windowsMenuItem.title = text("Window", "ウインドウ", "窗口"); windows.title = windowsMenuItem.title; windows.items[0].title = text("Show DIYFM", "DIYFMを表示", "显示 DIYFM")
    }
    @objc func about() { NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "DIYFM", .applicationVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "", .credits: NSAttributedString(string: "Letter Radio · English / 日本語 / 中文\nLocal library · Bring your own Google AI Studio key")]) }
    @objc func updates() { NSWorkspace.shared.open(URL(string: "https://github.com/jayson-sheyue/DIYFM/releases")!) }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if busy { let alert = NSAlert(); alert.messageText = text("Production is still running", "番組を制作中です", "节目仍在制作中"); alert.informativeText = text("Quitting interrupts production. Saved scripts and audio remain available for retry.", "終了すると制作が中断されます。保存済みの台本と音声は再試行に利用できます。", "退出会中断制作，已保存的台本和音频可供重试。"); alert.addButton(withTitle: text("Keep Running", "続ける", "继续运行")); alert.addButton(withTitle: text("Quit", "終了", "退出")); if alert.runModal() == .alertFirstButtonReturn { return .terminateCancel } }
        return .terminateNow
    }
    func applicationWillTerminate(_ note: Notification) { server?.stop() }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "http", origin.host == "127.0.0.1", origin.port == Int(LocalServer.port), let request = message.body as? [String: Any], let command = request["command"] as? String else { replyHandler(nil, "Unavailable"); return }
        let data = request["data"] as? [String: Any] ?? [:]
        let failed: (Error) -> Void = { _ in DispatchQueue.main.async { replyHandler(nil, "The action could not be completed. Your programs are safe.") } }
        if command == "app.info" { replyHandler(["platform": "macOS", "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "", "generation": player.revision, "state": player.state()], nil); return }
        if command == "app.busy" { busy = data["busy"] as? Bool ?? false; let next = data["locale"] as? String ?? "en"; if next != language { language = next; localizeMenus() }; replyHandler([:], nil); return }
        if command == "app.updates" { updates(); replyHandler([:], nil); return }
        if command.hasPrefix("player.") { do {replyHandler(try player.route(command, data: data, files: files), nil)} catch {failed(error)}; return }
        if command == "media.prune" { let keep = player.activeKeys; io.async { self.files.prune(keep: keep); DispatchQueue.main.async { replyHandler([:], nil) } }; return }
        if command == "file.begin", data["kind"] as? String == "export" {
            guard let raw = data["name"] as? String, raw.hasSuffix(".mp3") || raw.hasSuffix(".zip") else { replyHandler(nil, "Invalid file"); return }
            let panel = NSSavePanel(); panel.nameFieldStringValue = String(raw.replacingOccurrences(of: "/", with: "_").prefix(180)); panel.allowedContentTypes = [raw.hasSuffix(".mp3") ? .mp3 : .zip]; panel.canCreateDirectories = true
            panel.beginSheetModal(for: window) { result in
                guard result == .OK, let destination = panel.url else { replyHandler(["cancelled": true], nil); return }
                self.io.async { do { let value = try self.files.begin(data, destination: destination); DispatchQueue.main.async { replyHandler(value, nil) } } catch {failed(error)} }
            }; return
        }
        io.async {
            do {
                let value: [String: Any]
                switch command {
                case "file.begin": guard data["kind"] as? String == "media" else { throw NSError(domain: "DIYFM", code: 1) }; value = try self.files.begin(data)
                case "file.chunk": value = try self.files.chunk(data)
                case "file.commit": guard let ticket = data["ticket"] as? String else { throw NSError(domain: "DIYFM", code: 1) }; value = try self.files.commit(ticket)
                case "file.abort": value = self.files.abort(data["ticket"] as? String ?? "")
                default: throw NSError(domain: "DIYFM", code: 1)
                }
                DispatchQueue.main.async { replyHandler(value, nil) }
            } catch {failed(error)}
        }
    }
    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "http", url.host == "127.0.0.1", url.port == Int(LocalServer.port) { decisionHandler(.allow); return }
        if action.targetFrame?.isMainFrame != false, url.scheme == "https", action.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { if let url = action.request.url, url.scheme == "https" { NSWorkspace.shared.open(url) }; return nil }
    func webView(_ view: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.zip]; panel.allowsMultipleSelection = false; panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ view: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "DIYFM"; alert.informativeText = message; alert.addButton(withTitle: text("Cancel", "キャンセル", "取消")); alert.addButton(withTitle: text("Confirm", "確認", "确认")); alert.beginSheetModal(for: window) { result in completionHandler(result == .alertSecondButtonReturn) }
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
