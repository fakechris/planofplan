import AppKit
import Foundation
import SweetCookieKit

struct Overview: Decodable {
    let plans: [Plan]
}

struct Plan: Decodable {
    let slug: String
    let name: String
    let status: String
    let windows: [Window]
    let lastError: String?
    let browser: String?
    let browserSupported: Bool?
}

struct Window: Decodable {
    let label: String
    let percentage: Double?
}

struct BrowserCookiePayload: Encodable {
    let domain: String
    let name: String
    let value: String
    let path: String
}

struct BrowserSessionPayload: Encodable {
    let planSlug: String
    let browser: String
    let cookies: [BrowserCookiePayload]
    let workos: BrowserWorkOSPayload?
}

struct BrowserWorkOSPayload: Encodable {
    let accessToken: String?
    let refreshToken: String?
}

struct BuildMetadata {
    let commitSHA: String
    let shortCommitSHA: String
    let buildTimestamp: String
    let appVersion: String
    let bundlePath: String
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var port = 9288
    private let selectedBrowserKey = "planofplan.selectedBrowser"
    private let explicitBrowserKey = "planofplan.selectedBrowser.explicit"
    private let fullDiskAccessSettingsURL = URL(
        string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    )!
    private var statusItem: NSStatusItem!
    private var daemon: Process?
    private var overview: Overview?
    private var didBootstrapBrowserSessions = false
    private var safariPermissionState: SafariPermissionState = .unknown
    private var safariPermissionTimer: Timer?

    func applicationDidFinishLaunching(_: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        port = configuredPort()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "PF"
        rebuildMenu()

        ensureDaemon()
        refreshOverview()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.startSafariPermissionOnboardingIfNeeded()
        }
    }

    func applicationWillTerminate(_: Notification) {
        safariPermissionTimer?.invalidate()
        if let daemon, daemon.isRunning {
            daemon.terminate()
        }
    }

    private func rebuildMenu() {
        let menu = NSMenu()

        let title = NSMenuItem(title: "planofplan", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        let build = NSMenuItem(
            title: "Build \(buildMetadata.shortCommitSHA)（复制 SHA）",
            action: #selector(copyBuildIdentity),
            keyEquivalent: ""
        )
        build.target = self
        build.toolTip = "\(buildMetadata.commitSHA) · \(buildMetadata.buildTimestamp)"
        menu.addItem(build)
        menu.addItem(.separator())

        let refresh = NSMenuItem(title: "刷新全部", action: #selector(refreshAll), keyEquivalent: "r")
        refresh.target = self
        menu.addItem(refresh)

        let browser = NSMenuItem(title: "按 provider 读取浏览器会话", action: nil, keyEquivalent: "")
        let browserMenu = NSMenu()
        for (slug, name) in browserProviders() {
            let provider = NSMenuItem(title: "\(name) · \(selectedBrowser(for: slug))", action: nil, keyEquivalent: "")
            let providerMenu = NSMenu()
            for (id, label) in browserChoices(for: slug) {
                let item = NSMenuItem(title: label, action: #selector(readBrowserSession(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = BrowserSelection(planSlug: slug, browser: id)
                item.state = (selectedBrowser(for: slug) == id) ? .on : .off
                providerMenu.addItem(item)
            }
            provider.submenu = providerMenu
            browserMenu.addItem(provider)
        }
        browser.submenu = browserMenu
        menu.addItem(browser)

        if safariPermissionState == .denied {
            let permission = NSMenuItem(
                title: "自动申请 Safari 完全磁盘访问权限…",
                action: #selector(openFullDiskAccessSettings),
                keyEquivalent: ""
            )
            permission.target = self
            permission.toolTip = "系统设置打开后，授权完成会自动继续读取 Kimi 会话"
            menu.addItem(permission)
        }

        menu.addItem(.separator())

        if let overview {
            for plan in overview.plans {
                let line = plan.windows.isEmpty
                    ? "\(statusMark(plan.status)) \(plan.name): \(shortError(plan.lastError))"
                    : "\(statusMark(plan.status)) \(plan.name)  " + plan.windows
                        .map { "\($0.label) \($0.percentage.map { "\(Int($0))%" } ?? "--")" }
                        .joined(separator: " · ")
                let item = NSMenuItem(title: line, action: nil, keyEquivalent: "")
                item.toolTip = plan.lastError
                menu.addItem(item)
            }
        } else {
            let item = NSMenuItem(title: "正在连接本地 daemon…", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        menu.addItem(.separator())

        let dashboard = NSMenuItem(title: "打开 Dashboard", action: #selector(openDashboard), keyEquivalent: "o")
        dashboard.target = self
        menu.addItem(dashboard)

        let quit = NSMenuItem(title: "退出 planofplan", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        statusItem.menu = menu
    }

    private func statusMark(_ status: String) -> String {
        switch status {
        case "ok": return "●"
        case "stale": return "◐"
        case "error", "auth_error": return "!"
        default: return "○"
        }
    }

    private func shortError(_ error: String?) -> String {
        guard let error, !error.isEmpty else { return "暂无数据" }
        return String(error.prefix(22))
    }

    private func ensureDaemon() {
        request(path: "/api/overview", method: "GET") { [weak self] result, _ in
            guard let self else { return }
            if result == nil {
                self.startDaemon()
            }
        }
    }

    private func startDaemon() {
        guard daemon == nil || daemon?.isRunning == false else { return }
        guard let bun = findExecutable(
            candidates: [
                ProcessInfo.processInfo.environment["PLANOFPLAN_BUN_PATH"],
                ProcessInfo.processInfo.environment["BUN_INSTALL"].map { "\($0)/bin/bun" },
                "\(NSHomeDirectory())/.bun/bin/bun",
                "/opt/homebrew/bin/bun",
                "/usr/local/bin/bun",
            ]
        ) else {
            NSLog("planofplan: Bun not found; set PLANOFPLAN_BUN_PATH")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: bun)
        process.arguments = ["src/cli.ts", "serve", "--port", String(port)]
        process.currentDirectoryURL = URL(fileURLWithPath: projectRoot())
        var environment = ProcessInfo.processInfo.environment
        environment["PLANOFPPLAN_BUILD_COMMIT"] = buildMetadata.commitSHA
        environment["PLANOFPPLAN_BUILD_SHORT"] = buildMetadata.shortCommitSHA
        environment["PLANOFPPLAN_BUILD_TIMESTAMP"] = buildMetadata.buildTimestamp
        environment["PLANOFPPLAN_APP_VERSION"] = buildMetadata.appVersion
        environment["PLANOFPPLAN_BUNDLE_PATH"] = buildMetadata.bundlePath
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            daemon = process
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
                self?.refreshOverview()
            }
        } catch {
            NSLog("planofplan: failed to start Bun daemon: \(error)")
        }
    }

    private func findExecutable(candidates: [String?]) -> String? {
        for candidate in candidates.compactMap({ $0 }) where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return nil
    }

    private func projectRoot() -> String {
        if let file = Bundle.main.url(forResource: "project-root", withExtension: nil),
           let root = try? String(contentsOf: file, encoding: .utf8)
        {
            return root.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return ProcessInfo.processInfo.environment["PLANOFPPLAN_ROOT"] ?? FileManager.default.currentDirectoryPath
    }

    private func configuredPort() -> Int {
        if let file = Bundle.main.url(forResource: "port", withExtension: nil),
           let raw = try? String(contentsOf: file, encoding: .utf8),
           let value = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           (1...65535).contains(value)
        {
            return value
        }
        if let raw = ProcessInfo.processInfo.environment["PLANOFPPLAN_MENUBAR_PORT"],
           let value = Int(raw),
           (1...65535).contains(value)
        {
            return value
        }
        return 9288
    }

    private var buildMetadata: BuildMetadata {
        let info = Bundle.main.infoDictionary ?? [:]
        return BuildMetadata(
            commitSHA: (info["PlanofplanCommitSHA"] as? String) ?? "dev",
            shortCommitSHA: (info["PlanofplanCommitShortSHA"] as? String) ?? "dev",
            buildTimestamp: (info["PlanofplanBuildTimestamp"] as? String) ?? "development",
            appVersion: (info["CFBundleShortVersionString"] as? String) ?? "0.1.0",
            bundlePath: Bundle.main.bundlePath
        )
    }

    private func browserProviders() -> [(String, String)] {
        let providers: [(String, String)] = overview?.plans.compactMap { plan in
            guard plan.browserSupported == true else { return nil }
            return (plan.slug, plan.name)
        } ?? []
        return providers.isEmpty ? [("kimi", "Kimi Code")] : providers
    }

    private func browserChoices(for planSlug: String) -> [(String, String)] {
        if planSlug == "kimi" {
            return [("safari", "Safari（Full Disk Access）")]
        }
        return [
            ("firefox", "Firefox（不需要 Keychain）"),
            ("chrome", "Chrome（Keychain）"),
            ("comet", "Comet（Keychain）"),
            ("dia", "Dia（Keychain）"),
            ("safari", "Safari（Full Disk Access）"),
            ("brave", "Brave（Keychain）"),
            ("arc", "Arc（Keychain）"),
            ("chromium", "Chromium（Keychain）"),
        ]
    }

    private func selectedBrowser(for planSlug: String) -> String {
        if planSlug == "kimi" {
            return "safari"
        }
        let stored = UserDefaults.standard.string(forKey: "\(selectedBrowserKey).\(planSlug)")
        let explicitlySelected = UserDefaults.standard.bool(forKey: "\(explicitBrowserKey).\(planSlug)")
        if planSlug == "factory",
           !explicitlySelected,
           let factoryBrowser = preferredFactoryBrowser()
        {
            return factoryBrowser
        }
        return stored ?? overview?.plans.first(where: { $0.slug == planSlug })?.browser ?? "safari"
    }

    private func preferredFactoryBrowser() -> String? {
        for browser in ["comet", "chrome", "brave", "arc", "chromium", "safari", "firefox"] {
            guard let nativeBrowser = nativeBrowser(for: browser),
                  !BrowserCookieClient().stores(for: nativeBrowser).isEmpty
            else { continue }
            return browser
        }
        return nil
    }

    private func bootstrapBrowserSessions() {
        guard !didBootstrapBrowserSessions, let overview else { return }
        didBootstrapBrowserSessions = true
        for plan in overview.plans where plan.browserSupported == true {
            let selection = BrowserSelection(
                planSlug: plan.slug,
                browser: selectedBrowser(for: plan.slug)
            )
            NSLog("planofplan browser bootstrap \(selection.planSlug): \(selection.browser)")
            readBrowserSession(for: selection)
        }
    }

    private func refreshOverview() {
        request(path: "/api/overview", method: "GET") { [weak self] data, _ in
            guard let self, let data else {
                self?.rebuildMenu()
                return
            }
            do {
                self.overview = try JSONDecoder().decode(Overview.self, from: data)
            } catch {
                NSLog("planofplan: invalid overview response: \(error)")
            }
            self.rebuildMenu()
            self.startSafariPermissionOnboardingIfNeeded()
            self.bootstrapBrowserSessions()
        }
    }

    private func beginSafariPermissionOnboarding() {
        guard safariPermissionState != .granted, safariPermissionTimer == nil else { return }
        safariPermissionState = .denied
        rebuildMenu()

        // macOS intentionally does not expose a public API to silently grant
        // Full Disk Access. Open the exact system pane instead of asking users
        // to find the app or the setting themselves.
        openFullDiskAccessSettings()
        safariPermissionTimer = Timer.scheduledTimer(
            timeInterval: 2,
            target: self,
            selector: #selector(pollSafariPermission(_:)),
            userInfo: nil,
            repeats: true
        )
    }

    private func startSafariPermissionOnboardingIfNeeded() {
        guard safariPermissionTimer == nil else { return }
        guard overview?.plans.contains(where: {
            $0.browserSupported == true && selectedBrowser(for: $0.slug) == "safari"
        }) == true else {
            return
        }
        switch probeSafariPermission() {
        case .denied:
            beginSafariPermissionOnboarding()
        case .granted:
            safariPermissionState = .granted
            rebuildMenu()
        case .notRequired, .unknown:
            break
        }
    }

    @objc private func pollSafariPermission(_ timer: Timer) {
        switch probeSafariPermission() {
        case .granted:
            timer.invalidate()
            safariPermissionTimer = nil
            safariPermissionState = .granted
            rebuildMenu()
            for plan in overview?.plans ?? [] where
                plan.browserSupported == true && selectedBrowser(for: plan.slug) == "safari"
            {
                readBrowserSession(for: BrowserSelection(planSlug: plan.slug, browser: "safari"))
            }
        case .denied:
            break
        case .notRequired:
            timer.invalidate()
            safariPermissionTimer = nil
            safariPermissionState = .unknown
            rebuildMenu()
        case .unknown:
            break
        }
    }

    private func probeSafariPermission() -> SafariPermissionState {
        let client = BrowserCookieClient()
        let query = BrowserCookieQuery(
            domains: ["www.kimi.com", "kimi.com"],
            domainMatch: .suffix,
            includeExpired: true
        )
        do {
            _ = try client.records(matching: query, in: .safari)
            return .granted
        } catch let error as BrowserCookieError {
            switch error {
            case let .accessDenied(browser, _) where browser == .safari:
                return .denied
            case let .notFound(browser, _) where browser == .safari:
                return .notRequired
            default:
                // A readable but malformed/empty store is not a TCC denial.
                return .granted
            }
        } catch {
            return .granted
        }
    }

    private func request(
        path: String,
        method: String,
        body: Data? = nil,
        completion: @escaping (Data?, Int) -> Void
    ) {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else {
            completion(nil, 0)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if method == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body ?? Data("{}".utf8)
        }
        Task { @MainActor in
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                completion((200..<300).contains(status) ? data : nil, status)
            } catch {
                completion(nil, 0)
            }
        }
    }

    @objc private func refreshAll() {
        request(path: "/api/refresh", method: "POST") { [weak self] _, _ in
            self?.refreshOverview()
        }
    }

    @objc private func readBrowserSession(_ sender: NSMenuItem) {
        guard let selection = sender.representedObject as? BrowserSelection else { return }
        readBrowserSession(for: selection, persistSelection: true)
    }

    private func readBrowserSession(
        for selection: BrowserSelection,
        persistSelection: Bool = false,
        preferWorkOS: Bool = true
    ) {
        let browser = selection.browser
        if persistSelection {
            UserDefaults.standard.set(browser, forKey: "\(selectedBrowserKey).\(selection.planSlug)")
            UserDefaults.standard.set(true, forKey: "\(explicitBrowserKey).\(selection.planSlug)")
        }
        guard let nativeBrowser = nativeBrowser(for: browser) else { return }

        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let client = BrowserCookieClient()
                let query = BrowserCookieQuery(
                    domains: self.cookieDomains(for: selection.planSlug),
                    domainMatch: .suffix,
                    includeExpired: false
                )
                let workos = preferWorkOS && selection.planSlug == "factory"
                    ? self.workOSCredentials(in: nativeBrowser)
                    : nil
                if let workos {
                    NSLog("planofplan browser \(browser) factory: submitting WorkOS session")
                    let payload = BrowserSessionPayload(
                        planSlug: selection.planSlug,
                        browser: browser,
                        cookies: [],
                        workos: workos
                    )
                    let body = try JSONEncoder().encode(payload)
                    self.request(path: "/api/browser-session", method: "POST", body: body) { [weak self] _, status in
                        NSLog("planofplan browser \(browser) \(selection.planSlug): session POST status \(status)")
                        guard let self else { return }
                        if (200..<300).contains(status) {
                            self.refreshOverview()
                        } else {
                            NSLog("planofplan browser \(browser) factory: WorkOS failed, falling back to cookies")
                            self.readBrowserSession(
                                for: selection,
                                persistSelection: false,
                                preferWorkOS: false
                            )
                        }
                    }
                    return
                }
                let sources = try client.records(matching: query, in: nativeBrowser)
                NSLog(
                    "planofplan browser \(browser) \(selection.planSlug): found \(sources.reduce(0) { $0 + $1.records.count }) cookie records"
                )
                let grouped = Dictionary(grouping: sources, by: { $0.store.profile.id })
                let sortedGroups = grouped.values.sorted {
                    self.mergedBrowserLabel(for: $0) < self.mergedBrowserLabel(for: $1)
                }
                var selectedCookies: [BrowserCookiePayload]?
                for group in sortedGroups where !group.isEmpty {
                    let mergedRecords = self.mergeBrowserRecords(group)
                    let cookies = BrowserCookieClient.makeHTTPCookies(mergedRecords, origin: query.origin)
                    guard cookies.contains(where: {
                        self.isSessionCookie($0.name, for: selection.planSlug)
                    }) else { continue }
                    selectedCookies = cookies.map {
                        BrowserCookiePayload(
                            domain: $0.domain,
                            name: $0.name,
                            value: $0.value,
                            path: $0.path
                        )
                    }
                    break
                }
                guard let cookies = selectedCookies else {
                    throw BrowserSessionError.noSessionCookie
                }
                let payload = BrowserSessionPayload(
                    planSlug: selection.planSlug,
                    browser: browser,
                    cookies: cookies,
                    workos: workos
                )
                let body = try JSONEncoder().encode(payload)
                self.request(path: "/api/browser-session", method: "POST", body: body) { [weak self] _, status in
                    NSLog("planofplan browser \(browser) \(selection.planSlug): session POST status \(status)")
                    self?.refreshOverview()
                }
            } catch {
                if browser == "safari",
                   (selection.planSlug == "kimi" || selection.planSlug == "factory"),
                   let browserError = error as? BrowserCookieError,
                   browserError.browser == .safari,
                   browserError.accessDeniedHint != nil
                {
                    self.beginSafariPermissionOnboarding()
                }
                NSLog("planofplan browser \(browser) failed: \(error)")
                self.refreshOverview()
            }
        }
    }

    private func workOSCredentials(in browser: Browser) -> BrowserWorkOSPayload? {
        let client = BrowserCookieClient()
        var seenLevelDB = Set<String>()
        var refreshToken: String?
        var accessToken: String?

        for store in client.stores(for: browser) {
            guard let databaseURL = store.databaseURL else { continue }
            var profileURL = databaseURL.deletingLastPathComponent()
            if profileURL.lastPathComponent == "Network" {
                profileURL = profileURL.deletingLastPathComponent()
            }
            let levelDBURL = profileURL
                .appendingPathComponent("Local Storage")
                .appendingPathComponent("leveldb")
            guard seenLevelDB.insert(levelDBURL.path).inserted else { continue }

            let entries = ChromiumLocalStorageReader.readTextEntries(in: levelDBURL)
            for entry in entries where
                refreshToken == nil && entry.key.hasSuffix("workos:refresh-token")
            {
                refreshToken = entry.value
            }
            for entry in entries where
                accessToken == nil && entry.key.hasSuffix("workos:access-token")
            {
                accessToken = entry.value
            }
        }

        guard refreshToken?.isEmpty == false || accessToken?.isEmpty == false else {
            return nil
        }
        NSLog(
            "planofplan browser \(browser.displayName) factory: found WorkOS tokens "
                + "access=\(accessToken?.count ?? 0) refresh=\(refreshToken?.count ?? 0)"
        )
        return BrowserWorkOSPayload(accessToken: accessToken, refreshToken: refreshToken)
    }

    private func cookieDomains(for planSlug: String) -> [String] {
        switch planSlug {
        case "factory":
            return ["factory.ai", "app.factory.ai", "auth.factory.ai"]
        default:
            return ["www.kimi.com", "kimi.com"]
        }
    }

    private func isSessionCookie(_ name: String, for planSlug: String) -> Bool {
        switch planSlug {
        case "factory":
            return [
                "wos-session",
                "__Secure-next-auth.session-token",
                "next-auth.session-token",
                "__Secure-authjs.session-token",
                "__Host-authjs.csrf-token",
                "authjs.session-token",
                "session",
                "access-token",
            ].contains(name)
        default:
            return name == "kimi-auth"
        }
    }

    private func mergedBrowserLabel(for sources: [BrowserCookieStoreRecords]) -> String {
        guard let base = sources.map(\.label).min() else { return "Unknown" }
        if base.hasSuffix(" (Network)") {
            return String(base.dropLast(" (Network)".count))
        }
        return base
    }

    private func mergeBrowserRecords(_ sources: [BrowserCookieStoreRecords]) -> [BrowserCookieRecord] {
        let sortedSources = sources.sorted {
            self.browserStorePriority($0.store.kind) < self.browserStorePriority($1.store.kind)
        }
        var merged: [String: BrowserCookieRecord] = [:]
        for source in sortedSources {
            for record in source.records {
                let key = "\(record.name)|\(record.domain)|\(record.path)"
                if let existing = merged[key] {
                    if self.shouldReplaceBrowserRecord(existing: existing, candidate: record) {
                        merged[key] = record
                    }
                } else {
                    merged[key] = record
                }
            }
        }
        return Array(merged.values)
    }

    private func browserStorePriority(_ kind: BrowserCookieStoreKind) -> Int {
        switch kind {
        case .network: return 0
        case .primary: return 1
        case .safari: return 2
        }
    }

    private func shouldReplaceBrowserRecord(
        existing: BrowserCookieRecord,
        candidate: BrowserCookieRecord
    ) -> Bool {
        switch (existing.expires, candidate.expires) {
        case let (lhs?, rhs?): return rhs > lhs
        case (nil, .some): return true
        case (.some, nil): return false
        case (nil, nil): return false
        }
    }

    private func nativeBrowser(for id: String) -> Browser? {
        switch id {
        case "chrome": return .chrome
        case "brave": return .brave
        case "arc": return .arc
        case "chromium": return .chromium
        case "comet": return .comet
        case "dia": return .dia
        case "firefox": return .firefox
        case "safari": return .safari
        default: return nil
        }
    }

    @objc private func openDashboard() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)")!)
    }

    @objc private func openFullDiskAccessSettings() {
        NSWorkspace.shared.open(fullDiskAccessSettingsURL)
    }

    @objc private func copyBuildIdentity() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(buildMetadata.commitSHA, forType: .string)
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }
}

struct BrowserSelection {
    let planSlug: String
    let browser: String
}

enum BrowserSessionError: LocalizedError {
    case noSessionCookie

    var errorDescription: String? {
        switch self {
        case .noSessionCookie:
            return "No supported session cookie found in the selected browser."
        }
    }
}

enum SafariPermissionState {
    case unknown
    case denied
    case granted
    case notRequired
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
