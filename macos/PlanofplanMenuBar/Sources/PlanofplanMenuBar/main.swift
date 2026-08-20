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
    let authStatus: String?
    let windows: [Window]
    let lastError: String?
    let browser: String?
    let browserSupported: Bool?
}

struct Window: Decodable {
    let label: String
    let used: Double?
    let total: Double?
    let unit: String?
    let percentage: Double?
    let resetAt: Double?
    let note: String?
}

/// /api/usage 的最小子集：menubar 面板只展示 30 天总量、成本与 top providers。
struct UsageSummary: Decodable {
    struct Totals: Decodable {
        let totalTokens: Double?
        let estimatedCostUsd: Double?
    }
    struct ModelRow: Decodable {
        let provider: String
        let totalTokens: Double?
    }
    let totals: Totals?
    let models: [ModelRow]?

    var providerTotals: [(provider: String, tokens: Double)] {
        let byProvider = Dictionary(grouping: models ?? []) { $0.provider }
        return byProvider.map { (provider: $0.key, tokens: $0.value.compactMap(\.totalTokens).reduce(0, +)) }
            .sorted { $0.tokens > $1.tokens }
    }
}

/// 下拉面板里单个 plan 的卡片：名称/状态行 + 每个配额窗口一行
/// （label · 百分比 · 迷你用量条 · used/total · 恢复倒计时）。纯 draw 绘制。
final class PlanCardView: NSView {
    private let plan: Plan
    private let now: Date
    static let width: CGFloat = 320
    static let sidePadding: CGFloat = 12

    init(plan: Plan, now: Date) {
        self.plan = plan
        self.now = now
        let height = PlanCardView.height(for: plan)
        super.init(frame: NSRect(x: 0, y: 0, width: PlanCardView.width, height: height))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    static func height(for plan: Plan) -> CGFloat {
        let nameRow: CGFloat = 22
        let windowRows = CGFloat(max(plan.windows.count, 1)) * 20
        let errorRow: CGFloat = plan.windows.isEmpty && plan.lastError != nil ? 30 : 0
        return nameRow + windowRows + errorRow + 8
    }

    override func draw(_ dirtyRect: NSRect) {
        let contentWidth = bounds.width - PlanCardView.sidePadding * 2
        var y = bounds.height - 17

        // 名称行：状态 pip + 名称 +（右侧）凭据/浏览器标识
        let statusColor = PlanCardView.statusColor(plan.status)
        statusColor.setFill()
        NSBezierPath(ovalIn: NSRect(x: PlanCardView.sidePadding, y: y - 2, width: 7, height: 7)).fill()

        let nameAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12.5, weight: .semibold),
            .foregroundColor: NSColor.labelColor,
        ]
        let name = NSAttributedString(string: plan.name, attributes: nameAttrs)
        name.draw(at: NSPoint(x: PlanCardView.sidePadding + 13, y: y - 3))

        var badges: [String] = []
        if let browser = plan.browser { badges.append(browser) }
        if let auth = plan.authStatus, auth != "auto" { badges.append(auth) }
        if !badges.isEmpty {
            let badgeAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 9.5),
                .foregroundColor: NSColor.tertiaryLabelColor,
            ]
            let badge = NSAttributedString(string: badges.prefix(2).joined(separator: " · "), attributes: badgeAttrs)
            let size = badge.size()
            badge.draw(at: NSPoint(x: bounds.width - PlanCardView.sidePadding - size.width, y: y))
        }
        y -= 24

        // 窗口行
        let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .semibold)
        let secondaryFont = NSFont.systemFont(ofSize: 10)
        let countdownFont = NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
        for window in plan.windows {
            let pct = window.percentage
            let remaining = pct.map { 100 - $0 } ?? nil
            let levelColor = PlanCardView.levelColor(remaining: remaining)

            let labelAttr = NSAttributedString(string: window.label, attributes: [
                .font: secondaryFont, .foregroundColor: NSColor.secondaryLabelColor,
            ])
            labelAttr.draw(at: NSPoint(x: PlanCardView.sidePadding, y: y))

            let pctText = pct == nil ? "--" : "\(Int((pct!).rounded()))%"
            let pctAttr = NSAttributedString(string: pctText, attributes: [
                .font: numberFont, .foregroundColor: levelColor,
            ])
            let pctSize = pctAttr.size()
            let pctX = PlanCardView.sidePadding + 58
            pctAttr.draw(at: NSPoint(x: pctX + 40 - pctSize.width, y: y - 1))

            // 迷你用量条
            let barX = pctX + 48
            let barWidth: CGFloat = 84
            let barRect = NSRect(x: barX, y: y + 3, width: barWidth, height: 4)
            NSColor.quaternaryLabelColor.setFill()
            NSBezierPath(roundedRect: barRect, xRadius: 2, yRadius: 2).fill()
            if let pct, pct > 0 {
                levelColor.setFill()
                let fillWidth = max(4, barWidth * min(max(pct, 0), 100) / 100)
                NSBezierPath(roundedRect: NSRect(x: barX, y: y + 3, width: fillWidth, height: 4), xRadius: 2, yRadius: 2).fill()
            }

            // used/total
            var fraction = ""
            if let used = window.used, let total = window.total {
                fraction = PlanCardView.shortNumber(used) + "/" + PlanCardView.shortNumber(total)
            } else if let used = window.used {
                fraction = PlanCardView.shortNumber(used)
            }
            if !fraction.isEmpty {
                NSAttributedString(string: fraction, attributes: [
                    .font: secondaryFont, .foregroundColor: NSColor.tertiaryLabelColor,
                ]).draw(at: NSPoint(x: barX + barWidth + 6, y: y))
            }

            // 倒计时（右对齐）
            if let countdown = window.resetAt.map({ PlanCardView.countdownText(until: $0, now: now) }) {
                let attr = NSAttributedString(string: countdown, attributes: [
                    .font: countdownFont, .foregroundColor: NSColor.labelColor,
                ])
                let size = attr.size()
                attr.draw(at: NSPoint(x: bounds.width - PlanCardView.sidePadding - size.width, y: y))
            }
            y -= 20
        }

        // 无窗口：错误/提示文案
        if plan.windows.isEmpty {
            let text = plan.lastError ?? "暂无数据"
            let attr = NSAttributedString(string: text, attributes: [
                .font: secondaryFont,
                .foregroundColor: plan.status == "auth_error" || plan.status == "error"
                    ? NSColor.systemRed
                    : NSColor.tertiaryLabelColor,
            ])
            attr.draw(in: NSRect(x: PlanCardView.sidePadding, y: y - 6, width: contentWidth - 8, height: 30))
        }
    }

    static func statusColor(_ status: String) -> NSColor {
        switch status {
        case "ok": return NSColor.systemGreen
        case "stale", "not_configured": return NSColor.systemOrange
        case "error", "auth_error": return NSColor.systemRed
        default: return NSColor.tertiaryLabelColor
        }
    }

    static func levelColor(remaining: Double?) -> NSColor {
        guard let remaining else { return NSColor.tertiaryLabelColor }
        if remaining > 50 { return NSColor.systemGreen }
        if remaining > 10 { return NSColor.systemOrange }
        return NSColor.systemRed
    }

    static func shortNumber(_ value: Double) -> String {
        if value >= 1_000_000_000 { return String(format: "%.1fB", value / 1_000_000_000) }
        if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
        if value >= 1_000 { return String(format: "%.0fK", value / 1_000) }
        return String(format: "%.0f", value)
    }

    static func countdownText(until resetAtMs: Double, now: Date) -> String {
        let interval = resetAtMs / 1000 - now.timeIntervalSince1970
        if interval <= 0 { return "已恢复" }
        let minutes = max(1, Int((interval / 60).rounded(.up)))
        if minutes < 60 { return "\(minutes)分钟后" }
        return "\(minutes / 60)小时\(minutes % 60 > 0 ? " \(minutes % 60)分" : "")后"
    }
}

/// 下拉面板的 Usage & Spend 汇总卡：30 天总量、估算成本、top providers。
final class UsageCardView: NSView {
    private let usage: UsageSummary
    static let width: CGFloat = 320

    init(usage: UsageSummary) {
        self.usage = usage
        super.init(frame: NSRect(x: 0, y: 0, width: UsageCardView.width, height: 62))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        let x = PlanCardView.sidePadding
        var y = bounds.height - 14

        NSAttributedString(string: "TOKEN USAGE · 30 DAYS", attributes: [
            .font: NSFont.systemFont(ofSize: 9, weight: .bold),
            .foregroundColor: NSColor.tertiaryLabelColor,
        ]).draw(at: NSPoint(x: x, y: y))
        y -= 18

        let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .semibold)
        var main = "总量 \(PlanCardView.shortNumber(usage.totals?.totalTokens ?? 0))"
        if let cost = usage.totals?.estimatedCostUsd {
            main += String(format: " · 估算 $%.2f", cost)
        }
        NSAttributedString(string: main, attributes: [
            .font: numberFont, .foregroundColor: NSColor.labelColor,
        ]).draw(at: NSPoint(x: x, y: y))
        y -= 17

        let top = usage.providerTotals.prefix(4).map { "\($0.provider) \(PlanCardView.shortNumber($0.tokens))" }
        if !top.isEmpty {
            NSAttributedString(string: top.joined(separator: " · "), attributes: [
                .font: NSFont.systemFont(ofSize: 10),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]).draw(in: NSRect(x: x, y: y - 2, width: bounds.width - x * 2, height: 16))
        }
    }
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
    let organizationId: String?
    let cookies: [BrowserCookiePayload]
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
    private var usageSummary: UsageSummary?
    private var didBootstrapBrowserSessions = false
    private var safariPermissionState: SafariPermissionState = .unknown
    private var safariPermissionTimer: Timer?

    func applicationDidFinishLaunching(_: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        port = configuredPort()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateMenuBarIcon()
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
        menu.delegate = self
        refillMenu(menu)
        statusItem.menu = menu
    }

    /** 面板内容：build 头 → 每 plan 一张卡片 → usage 汇总 → 操作区。 */
    private func refillMenu(_ menu: NSMenu) {
        menu.removeAllItems()

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

        if let overview {
            for plan in overview.plans {
                let item = NSMenuItem()
                item.view = PlanCardView(plan: plan, now: Date())
                item.isEnabled = false
                item.toolTip = plan.lastError
                menu.addItem(item)
            }
        } else {
            let item = NSMenuItem(title: "正在连接本地 daemon…", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        if let usageSummary {
            menu.addItem(.separator())
            let item = NSMenuItem()
            item.view = UsageCardView(usage: usageSummary)
            item.isEnabled = false
            menu.addItem(item)
        }

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

        let dashboard = NSMenuItem(title: "打开 Dashboard", action: #selector(openDashboard), keyEquivalent: "o")
        dashboard.target = self
        menu.addItem(dashboard)

        let quit = NSMenuItem(title: "退出 planofplan", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    // CodexBar 风格的 menubar 用量表：全 plan 最紧张的两个配额窗口画成
    // 迷你分段条，填充比例 = 已用百分比，颜色按余量分级；无数据时灰化。
    private func updateMenuBarIcon() {
        statusItem.button?.image = renderUsageMeterIcon(for: overview)
        statusItem.button?.imagePosition = .imageOnly
    }

    private func renderUsageMeterIcon(for overview: Overview?) -> NSImage {
        let meters = tightUsageMeters(from: overview)
        let size = NSSize(width: 20, height: meters.isEmpty ? 8 : 11)
        let icon = NSImage(size: size)
        icon.lockFocus()
        let trackColor = NSColor.systemGray.withAlphaComponent(0.32)
        NSColor.clear.setFill()

        func color(level: Int) -> NSColor {
            switch level {
            case 0: return NSColor(srgbRed: 0.31, green: 0.80, blue: 0.57, alpha: 1)
            case 1: return NSColor(srgbRed: 0.91, green: 0.71, blue: 0.32, alpha: 1)
            default: return NSColor(srgbRed: 0.94, green: 0.44, blue: 0.44, alpha: 1)
            }
        }
        func drawRoundedRect(_ rect: NSRect) {
            NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2).fill()
        }

        if meters.isEmpty {
            // 无数据：两条空轨道
            for row in 0..<2 {
                trackColor.setFill()
                drawRoundedRect(NSRect(x: 1, y: CGFloat(3 - row * 4), width: 18, height: 3))
            }
        } else {
            let barHeight: CGFloat = 3
            let gap: CGFloat = 2
            let width: CGFloat = 18
            for (index, meter) in meters.prefix(2).enumerated() {
                let y = size.height - barHeight - CGFloat(index) * (barHeight + gap)
                trackColor.setFill()
                drawRoundedRect(NSRect(x: 1, y: y - 1, width: width, height: barHeight))
                color(level: meter.level).setFill()
                drawRoundedRect(NSRect(x: 1, y: y - 1, width: max(barHeight, width * meter.fraction), height: barHeight))
            }
        }
        icon.unlockFocus()
        icon.isTemplate = false
        return icon
    }

    /// 余量最紧张的两个窗口（已用百分比最高），按 (fraction, level) 返回。
    private func tightUsageMeters(from overview: Overview?) -> [(fraction: CGFloat, level: Int)] {
        guard let overview else { return [] }
        let percentages = overview.plans
            .filter { $0.status == "ok" || $0.status == "stale" }
            .flatMap { plan in
                plan.windows.compactMap { window -> Double? in
                    guard let percentage = window.percentage else { return nil }
                    return min(max(percentage, 0), 100)
                }
            }
            .sorted(by: >)
        return percentages.prefix(2).map { percentage in
            let remaining = 100 - percentage
            let level = remaining > 50 ? 0 : (remaining > 10 ? 1 : 2)
            return (fraction: CGFloat(percentage / 100), level: level)
        }
    }

    private func ensureDaemon() {        request(path: "/api/overview", method: "GET") { [weak self] result, _ in
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

    private func fetchUsageSummary() {
        request(path: "/api/usage?days=30", method: "GET") { [weak self] data, _ in
            guard let self, let data else { return }
            self.usageSummary = try? JSONDecoder().decode(UsageSummary.self, from: data)
            self.rebuildMenu()
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
            self.updateMenuBarIcon()
            self.fetchUsageSummary()
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
                completion(data, status)
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
                let workosCookiePayloads: [BrowserCookiePayload] = if workos != nil {
                    (try? self.browserCookiePayloads(
                        client: client,
                        query: BrowserCookieQuery(
                            domains: ["workos.com"],
                            domainMatch: .suffix,
                            includeExpired: false
                        ),
                        nativeBrowser: nativeBrowser,
                        planSlug: selection.planSlug,
                        requireSessionCookie: false
                    )) ?? []
                } else {
                    []
                }
                let cookiePayloads = if workos != nil {
                    (try? self.browserCookiePayloads(
                        client: client,
                        query: query,
                        nativeBrowser: nativeBrowser,
                        planSlug: selection.planSlug
                    )) ?? []
                } else {
                    try self.browserCookiePayloads(
                        client: client,
                        query: query,
                        nativeBrowser: nativeBrowser,
                        planSlug: selection.planSlug
                    )
                }
                if let workos {
                    NSLog("planofplan browser \(browser) factory: submitting WorkOS session")
                    let payload = BrowserSessionPayload(
                        planSlug: selection.planSlug,
                        browser: browser,
                        cookies: cookiePayloads,
                        workos: BrowserWorkOSPayload(
                            accessToken: workos.accessToken,
                            refreshToken: workos.refreshToken,
                            organizationId: workos.organizationId,
                            cookies: workosCookiePayloads
                        )
                    )
                    let body = try JSONEncoder().encode(payload)
                    self.request(path: "/api/browser-session", method: "POST", body: body) { [weak self] data, status in
                        NSLog("planofplan browser \(browser) \(selection.planSlug): session POST status \(status)")
                        if let data, let response = String(data: data, encoding: .utf8) {
                            NSLog(
                                "planofplan browser \(browser) \(selection.planSlug): "
                                    + "session response \(String(response.prefix(600)))"
                            )
                        }
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
                let payload = BrowserSessionPayload(
                    planSlug: selection.planSlug,
                    browser: browser,
                    cookies: cookiePayloads,
                    workos: workos
                )
                let body = try JSONEncoder().encode(payload)
                self.request(path: "/api/browser-session", method: "POST", body: body) { [weak self] data, status in
                    NSLog("planofplan browser \(browser) \(selection.planSlug): session POST status \(status)")
                    if let data, let response = String(data: data, encoding: .utf8) {
                        NSLog(
                            "planofplan browser \(browser) \(selection.planSlug): "
                                + "session response \(String(response.prefix(600)))"
                        )
                    }
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

    private func browserCookiePayloads(
        client: BrowserCookieClient,
        query: BrowserCookieQuery,
        nativeBrowser: Browser,
        planSlug: String,
        requireSessionCookie: Bool = true
    ) throws -> [BrowserCookiePayload] {
        let sources = try client.records(matching: query, in: nativeBrowser)
        let recordNames = sources
            .flatMap(\.records)
            .map(\.name)
            .joined(separator: ",")
        NSLog(
            "planofplan browser \(nativeBrowser.displayName) \(planSlug): found "
                + "\(sources.reduce(0) { $0 + $1.records.count }) cookie records [\(recordNames)]"
        )
        let grouped = Dictionary(grouping: sources, by: { $0.store.profile.id })
        let sortedGroups = grouped.values.sorted {
            self.mergedBrowserLabel(for: $0) < self.mergedBrowserLabel(for: $1)
        }
        for group in sortedGroups where !group.isEmpty {
            let mergedRecords = self.mergeBrowserRecords(group)
            let cookies = BrowserCookieClient.makeHTTPCookies(mergedRecords, origin: query.origin)
            if requireSessionCookie {
                guard cookies.contains(where: {
                    self.isSessionCookie($0.name, for: planSlug)
                }) else { continue }
            }
            return cookies.map {
                BrowserCookiePayload(
                    domain: $0.domain,
                    name: $0.name,
                    value: $0.value,
                    path: $0.path
                )
            }
        }
        throw BrowserSessionError.noSessionCookie
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
        return BrowserWorkOSPayload(
            accessToken: accessToken,
            refreshToken: refreshToken,
            organizationId: organizationID(in: accessToken),
            cookies: []
        )
    }

    private func organizationID(in token: String?) -> String? {
        guard let token else { return nil }
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 {
            payload.append("=")
        }
        guard let data = Data(base64Encoded: payload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let organizationID = json["org_id"] as? String,
              !organizationID.isEmpty
        else {
            return nil
        }
        return organizationID
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
                "__recent_auth",
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

extension AppDelegate: NSMenuDelegate {
    /// 每次打开下拉都重填：倒计时/状态取打开瞬间的实时值。
    func menuNeedsUpdate(_ menu: NSMenu) {
        refillMenu(menu)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
