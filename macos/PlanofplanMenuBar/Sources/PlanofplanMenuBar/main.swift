import AppKit
import Foundation
import SweetCookieKit

struct Overview: Decodable {
    let plans: [Plan]
}

struct Plan: Decodable {
    let slug: String
    let name: String
    let adapter: String?
    let status: String
    let authStatus: String?
    let windows: [Window]
    let lastError: String?
    let lastFetchedAt: Double?
    let credentialHint: String?
    let browser: String?
    let browserSupported: Bool?
    /// 上次本地 Claude Code 用 `claude-fable-5` 的 epoch ms；null/缺失表示从未用过。
    let fableLastUsedAt: Double?
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

/// /api/usage 的最小子集：menubar 面板展示 30 天总量、成本、top providers
/// 与按 plan 归属的用量（分页页脚用）。
struct UsageSummary: Decodable {
    struct Totals: Decodable {
        let totalTokens: Double?
        let estimatedCostUsd: Double?
    }
    struct ModelRow: Decodable {
        let provider: String
        let totalTokens: Double?
    }
    struct TopModel: Decodable {
        let model: String
        let totalTokens: Double?
    }
    struct PlanUsageRow: Decodable {
        struct DailyEntry: Decodable {
            let day: String
            let totalTokens: Double
            let estimatedCostUsd: Double?
        }
        struct ProjectEntry: Decodable {
            let project: String
            let totalTokens: Double
            let estimatedCostUsd: Double?
        }
        struct SessionEntry: Decodable {
            let sessionId: String
            let timestamp: Double
            let project: String?
            let url: String?
        }
        let plan: String
        let totalTokens: Double?
        let estimatedCostUsd: Double?
        let topModels: [TopModel]?
        let topProjects: [ProjectEntry]?
        let daily: [DailyEntry]?
        let recentSessions: [SessionEntry]?
    }
    let totals: Totals?
    let models: [ModelRow]?
    let byPlan: [PlanUsageRow]?

    func usage(forPlan slug: String) -> PlanUsageRow? {
        byPlan?.first { $0.plan == slug }
    }

    var providerTotals: [(provider: String, tokens: Double)] {
        let byProvider = Dictionary(grouping: models ?? []) { $0.provider }
        return byProvider.map { (provider: $0.key, tokens: $0.value.compactMap(\.totalTokens).reduce(0, +)) }
            .sorted { $0.tokens > $1.tokens }
    }
}

/// 下拉面板：第一页 index 总览（全部 plan 紧凑行，点行跳转），之后每
/// provider 一张大卡片；‹ › 自绘箭头 + 命中区域切换（NSButton 的 tint
/// 在菜单里不可靠，黑底黑字不可见）。plan 多到一页放不下时自动拆多页
/// 总览。自绘深色卡片、固定配色，不依赖菜单 vibrancy/系统外观。
final class PanelView: NSView {
    private enum Page {
        case index(rows: [Int])
        case provider(Int)
    }

    private let plans: [Plan]
    private var usage: UsageSummary?
    private var pages: [Page] = []
    private var page: Int = 0
    private let onSelect: (Int) -> Void

    private var chevronLeftRect = NSRect.zero
    private var chevronRightRect = NSRect.zero
    private var indexRowRects: [(rect: NSRect, planIndex: Int)] = []
    private var sessionRowRects: [(rect: NSRect, url: URL)] = []

    private let cardBG = NSColor(srgbRed: 0.055, green: 0.075, blue: 0.10, alpha: 1)
    private let cardBorder = NSColor(white: 1, alpha: 0.09)
    private let textPrimary = NSColor(srgbRed: 0.91, green: 0.93, blue: 0.96, alpha: 1)
    private let textSecondary = NSColor(srgbRed: 0.60, green: 0.65, blue: 0.71, alpha: 1)
    private let textTertiary = NSColor(srgbRed: 0.42, green: 0.47, blue: 0.53, alpha: 1)
    private let okColor = NSColor(srgbRed: 0.31, green: 0.80, blue: 0.57, alpha: 1)
    private let warnColor = NSColor(srgbRed: 0.91, green: 0.71, blue: 0.32, alpha: 1)
    private let badColor = NSColor(srgbRed: 0.94, green: 0.44, blue: 0.44, alpha: 1)
    private let accentColor = NSColor(srgbRed: 0.36, green: 0.84, blue: 0.90, alpha: 1)
    private let chevronColor = NSColor(white: 1, alpha: 0.55)

    static let panelWidth: CGFloat = 380
    static let cardInset: CGFloat = 6

    /// 面板固定高度：取 provider 页与总览页的较大者。
    static func height(plans: [Plan]) -> CGFloat {
        let maxWindows = CGFloat(max(1, plans.map { $0.windows.count }.max() ?? 1))
        let providerHeight = 278 + maxWindows * 64
        // 总览页:头部 + 每 plan 一行统一紧凑摘要(全量,上限 760 防失控)
        let indexHeight = 66 + CGFloat(plans.count) * 25 + 46
        let cappedIndex = min(indexHeight, 760)
        return 12 + max(providerHeight, cappedIndex)
    }

    init(plans: [Plan], usage: UsageSummary?, startPage: Int = 0, onSelect: @escaping (Int) -> Void = { _ in }) {
        self.plans = plans
        self.usage = usage
        self.onSelect = onSelect
        super.init(frame: NSRect(x: 0, y: 0, width: PanelView.panelWidth, height: PanelView.height(plans: plans)))
        buildPages()
        page = min(max(startPage, 0), max(pages.count - 1, 0))
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func buildPages() {
        guard !plans.isEmpty else {
            pages = [.index(rows: [])]
            return
        }
        // 总览页只放最紧张的 3 个，其余折叠；不再拆多页总览。
        let indexPages: [Page] = [.index(rows: Array(plans.indices))]
        pages = indexPages + plans.indices.map { .provider($0) }
    }

    private func goPrev() {
        page = (page - 1 + pages.count) % pages.count
        onSelect(page)
        setNeedsDisplay(bounds)
    }

    private func goNext() {
        page = (page + 1) % pages.count
        onSelect(page)
        setNeedsDisplay(bounds)
    }

    private var cardRect: NSRect { bounds.insetBy(dx: PanelView.cardInset, dy: PanelView.cardInset) }

    override func draw(_ dirtyRect: NSRect) {
        cardBG.setFill()
        NSBezierPath(roundedRect: cardRect, xRadius: 12, yRadius: 12).fill()
        cardBorder.setStroke()
        let border = NSBezierPath(roundedRect: cardRect.insetBy(dx: 0.5, dy: 0.5), xRadius: 12, yRadius: 12)
        border.lineWidth = 1
        border.stroke()

        indexRowRects = []
        sessionRowRects = []
        guard !pages.isEmpty else {
            drawText("正在连接本地 daemon…", at: NSPoint(x: 20, y: bounds.midY),
                     font: .systemFont(ofSize: 12), color: textSecondary)
            return
        }
        let contentLeft = cardRect.minX + 16
        let contentWidth = cardRect.width - 32

        // ── 头部：标题 + 序号 + 页点 + 自绘 ‹ ›（命中区域记录）
        let headerBottom = cardRect.maxY - 52
        let chevronSize = NSSize(width: 34, height: 30)
        chevronLeftRect = NSRect(x: cardRect.minX + 8, y: headerBottom + 8, width: chevronSize.width, height: chevronSize.height)
        chevronRightRect = NSRect(x: cardRect.maxX - 8 - chevronSize.width, y: headerBottom + 8, width: chevronSize.width, height: chevronSize.height)
        drawChevron("‹", in: chevronLeftRect)
        drawChevron("›", in: chevronRightRect)

        let title: String
        switch pages[page] {
        case .index: title = "全部 Plans"
        case .provider(let i): title = plans[i].name
        }
        let titleAttr = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .bold),
            .foregroundColor: textPrimary,
        ])
        let indexAttr = NSAttributedString(string: "  \(page + 1)/\(pages.count)", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium),
            .foregroundColor: textTertiary,
        ])
        let titleSize = titleAttr.size()
        let indexSize = indexAttr.size()
        let totalWidth = titleSize.width + indexSize.width
        titleAttr.draw(at: NSPoint(x: bounds.midX - totalWidth / 2, y: cardRect.maxY - 34))
        indexAttr.draw(at: NSPoint(x: bounds.midX - totalWidth / 2 + titleSize.width, y: cardRect.maxY - 31))

        if pages.count > 1 {
            let dotGap: CGFloat = 9
            var dotX = bounds.midX - CGFloat(pages.count - 1) * dotGap / 2
            for i in 0..<pages.count {
                (i == page ? accentColor : NSColor(white: 1, alpha: 0.18)).setFill()
                NSBezierPath(ovalIn: NSRect(x: dotX, y: cardRect.maxY - 48, width: 3.5, height: 3.5)).fill()
                dotX += dotGap
            }
        }

        // ── 页面主体
        switch pages[page] {
        case .index(let rows):
            drawIndexPage(rows: rows, top: headerBottom, contentLeft: contentLeft, contentWidth: contentWidth)
        case .provider(let i):
            drawProviderPage(plans[i], top: headerBottom, contentLeft: contentLeft, contentWidth: contentWidth)
        }

        let footerPlanSlug: String?
        switch pages[page] {
        case .index: footerPlanSlug = nil
        case .provider(let i): footerPlanSlug = plans[i].slug
        }
        drawUsageFooter(contentLeft: contentLeft, contentWidth: contentWidth, planSlug: footerPlanSlug)
    }

    private func drawChevron(_ symbol: String, in rect: NSRect) {
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        let attr = NSAttributedString(string: symbol, attributes: [
            .font: NSFont.systemFont(ofSize: 17, weight: .bold),
            .foregroundColor: pages.count > 1 ? chevronColor : NSColor(white: 1, alpha: 0.15),
            .paragraphStyle: para,
        ])
        attr.draw(in: NSRect(x: rect.minX, y: rect.minY - 2, width: rect.width, height: rect.height))
    }

    /// 总览页：按规范只展示最紧张的 3 个 plan 的完整窗口信息，其余折叠为摘要行。
    /// 总览页:全部 plan 统一紧凑行(状态点 + 名称 + 窗口标签 + 摘要值 +
    /// 倒计时),按最紧窗口排序。不再区分「featured 3 富行 + 其余」,两套
    /// 风格的割裂感比信息密度更伤;富信息在 provider 详情页。
    private func drawIndexPage(rows: [Int], top: CGFloat, contentLeft: CGFloat, contentWidth: CGFloat) {
        var y = top - 14

        let sorted = rows.sorted { a, b in
            let pa = plans[a].windows.compactMap { $0.percentage }.max() ?? 0
            let pb = plans[b].windows.compactMap { $0.percentage }.max() ?? 0
            return pa > pb
        }

        for planIndex in sorted {
            guard y > cardRect.minY + 56 else { break }
            let plan = plans[planIndex]
            let rowTop = y

            indexRowRects.append((rect: NSRect(x: contentLeft, y: rowTop - 24, width: contentWidth, height: 25), planIndex: planIndex))

            // 状态点 + 名称(+禁用弱化)
            color(forStatus: plan.status).setFill()
            NSBezierPath(ovalIn: NSRect(x: contentLeft, y: rowTop - 10, width: 5, height: 5)).fill()
            drawText(plan.name, at: NSPoint(x: contentLeft + 12, y: rowTop - 13),
                     font: .systemFont(ofSize: 11.5, weight: .medium), color: textPrimary)

            // 右侧:摘要值(最右)+ 倒计时(值左侧,灰);余额型无倒计时
            let tight = plan.windows.filter { $0.percentage != nil }
                .max { ($0.percentage ?? 0) < ($1.percentage ?? 0) }
            let balance = plan.windows.first(where: PanelView.isBalanceWindow)
            let unlimited = plan.windows.contains { $0.note == "不限量" && $0.percentage == nil }

            var right = cardRect.maxX - 16
            var value = "--"
            var valueColor = textTertiary
            if let tight {
                value = "\(Int(tight.percentage!.rounded()))%"
                valueColor = color(forRemaining: 100 - tight.percentage!)
                if let resetAt = tight.resetAt {
                    let cd = PanelView.countdownText(until: resetAt)
                    let cdFont = NSFont.systemFont(ofSize: 9.5)
                    let cdWidth = (cd as NSString).size(withAttributes: [.font: cdFont]).width
                    drawText(cd, at: NSPoint(x: right - cdWidth - 46, y: rowTop - 12), font: cdFont, color: textTertiary)
                }
            } else if let balance {
                value = PanelView.windowValueText(balance)
                valueColor = textPrimary
            } else if unlimited {
                value = "∞"
                valueColor = okColor
            }
            drawRightAligned(value, y: y - 13, right: right,
                             font: .monospacedDigitSystemFont(ofSize: 12.5, weight: .semibold), color: valueColor)

            // 窗口小标签(值左侧;余额型是 "Balance")
            let label = tight?.label ?? (balance != nil ? "余额" : nil)
            if let label {
                let labelFont = NSFont.systemFont(ofSize: 9.5)
                let w = (label as NSString).size(withAttributes: [.font: labelFont]).width
                drawText(label, at: NSPoint(x: right - w - 76, y: rowTop - 12), font: labelFont, color: textTertiary)
            }

            // 行分隔线(最后一行也画,收口整齐)
            NSColor(white: 1, alpha: 0.05).setFill()
            NSRect(x: contentLeft, y: rowTop - 24, width: contentWidth, height: 1).fill()
            y -= 25
        }
    }

    /// provider 大卡片页：状态块 + 每窗口富信息块。
    private func drawProviderPage(_ plan: Plan, top: CGFloat, contentLeft: CGFloat, contentWidth: CGFloat) {
        var y = top - 14

        let statusColor = color(forStatus: plan.status)
        statusColor.setFill()
        NSBezierPath(ovalIn: NSRect(x: contentLeft, y: y - 1, width: 7, height: 7)).fill()
        var statusParts = [statusText(plan.status)]
        if let auth = plan.authStatus { statusParts.append(authLabel(auth)) }
        if let browser = plan.browser { statusParts.append(browser) }
        drawText(statusParts.joined(separator: " · "), at: NSPoint(x: contentLeft + 13, y: y - 3),
                 font: .systemFont(ofSize: 11, weight: .medium), color: textSecondary)
        y -= 17
        let updated = plan.lastFetchedAt.map { "更新于 " + PanelView.agoText($0) } ?? "暂无成功数据"
        drawText(updated, at: NSPoint(x: contentLeft, y: y),
                 font: .systemFont(ofSize: 10), color: textTertiary)
        y -= 14

        if let label = PanelView.fableIdleLabel(for: plan, nowMs: Date().timeIntervalSince1970 * 1000) {
            drawText("⚠ fable-5 空闲 \(label)", at: NSPoint(x: contentLeft, y: y),
                     font: .systemFont(ofSize: 11, weight: .semibold), color: warnColor)
            y -= 16
        }

        if plan.windows.isEmpty {
            let message = plan.status == "not_configured"
                ? (plan.credentialHint ?? "暂无数据")
                : (plan.lastError ?? "暂无数据")
            drawText(message, at: NSPoint(x: contentLeft, y: y - 6),
                     font: .systemFont(ofSize: 11),
                     color: (plan.status == "auth_error" || plan.status == "error") ? badColor : textTertiary,
                     maxWidth: contentWidth, maxLines: 2)
        } else {
            for window in plan.windows {
                let pct = window.percentage
                let balance = PanelView.isBalanceWindow(window)
                let remaining = pct.map { 100 - $0 }
                let levelColor = color(forRemaining: remaining)

                drawText(window.label, at: NSPoint(x: contentLeft, y: y),
                         font: .systemFont(ofSize: 11, weight: .semibold), color: textSecondary)
                // 余额型没有「恢复」概念,整行不画(与 dashboard 一致)
                if !balance, let resetAt = window.resetAt {
                    drawRightAligned("恢复 " + PanelView.shortDateTime(resetAt), y: y, right: cardRect.maxX - 16,
                                     font: .systemFont(ofSize: 9.5), color: textTertiary)
                }
                y -= 21

                let unlimited = window.note == "不限量" && pct == nil
                // 余额型:主数字 = 金额本身(大号白字,与 dashboard 的余额强化一致);
                // 百分比型:主数字 = 百分比
                let pctText = balance
                    ? PanelView.windowValueText(window)
                    : (unlimited ? "∞" : (pct == nil ? "--%" : "\(Int(pct!.rounded()))%"))
                let pctAttr = NSAttributedString(string: pctText, attributes: [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 19, weight: .bold),
                    .foregroundColor: (balance || unlimited) ? textPrimary : levelColor,
                ])
                pctAttr.draw(at: NSPoint(x: contentLeft, y: y - 3))
                let pctWidth = pctAttr.size().width

                // 余额型不重复 used / total(金额已在主数字)
                if !balance {
                    var fraction = ""
                    if let used = window.used, let total = window.total {
                        fraction = PanelView.shortNumber(used) + " / " + PanelView.shortNumber(total)
                    } else if let used = window.used {
                        fraction = PanelView.shortNumber(used)
                    }
                    if !fraction.isEmpty {
                        drawText(fraction, at: NSPoint(x: contentLeft + pctWidth + 8, y: y + 2),
                                 font: .systemFont(ofSize: 10), color: textTertiary)
                    }
                }

                if !balance, let countdown = window.resetAt.map({ PanelView.countdownText(until: $0) }) {
                    drawRightAligned(countdown, y: y, right: cardRect.maxX - 16,
                                     font: .monospacedDigitSystemFont(ofSize: 11, weight: .semibold),
                                     color: textPrimary)
                }

                let barRect = NSRect(x: contentLeft, y: y - 12, width: contentWidth, height: 5)
                NSColor(white: 1, alpha: 0.10).setFill()
                NSBezierPath(roundedRect: barRect, xRadius: 2.5, yRadius: 2.5).fill()
                if let pct, pct > 0 {
                    levelColor.setFill()
                    let fillWidth = max(5, contentWidth * min(max(pct, 0), 100) / 100)
                    NSBezierPath(roundedRect: NSRect(x: contentLeft, y: y - 12, width: fillWidth, height: 5),
                                 xRadius: 2.5, yRadius: 2.5).fill()
                }

                if let note = window.note, !note.isEmpty {
                    drawText(note, at: NSPoint(x: contentLeft, y: y - 26),
                             font: .systemFont(ofSize: 9.5), color: textTertiary)
                    y -= 64
                } else {
                    y -= 50
                }
            }
        }
    }

    /** 页脚：总览页显示全局用量，provider 页只显示当页 plan 的用量与 top models。 */
    private func drawUsageFooter(contentLeft: CGFloat, contentWidth: CGFloat, planSlug: String?) {
        let y = cardRect.minY + 14
        NSColor(white: 1, alpha: 0.08).setFill()
        // provider 页的分隔线画在富块顶部；index 页保持原位
        if let planSlug, usage?.usage(forPlan: planSlug) != nil {
            NSRect(x: contentLeft, y: cardRect.minY + 172 + 4, width: contentWidth, height: 1).fill()
        } else {
            NSRect(x: contentLeft, y: y + 40, width: contentWidth, height: 1).fill()
        }

        let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .semibold)
        if let planSlug, let planUsage = usage?.usage(forPlan: planSlug) {
            // 富用量块自上而下排布，全部锚定在页脚区域顶部（148px 高），
            // 旧实现自底向上画导致柱状图/项目行落在卡片外不可见。
            let top = cardRect.minY + 172
            drawText("USAGE · 30 DAYS", at: NSPoint(x: contentLeft, y: top - 12),
                     font: .systemFont(ofSize: 9, weight: .bold), color: textTertiary)

            // 今日 / 30 天双栏
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            let today = formatter.string(from: Date())
            let todayEntry = planUsage.daily?.first { $0.day == today }
            var todayText = "今日 " + PanelView.shortNumber(todayEntry?.totalTokens ?? 0)
            if let cost = todayEntry?.estimatedCostUsd {
                let snapped = (cost * 100).rounded() / 100
                todayText += String(format: " · $%.2f", snapped)
            }
            drawText(todayText, at: NSPoint(x: contentLeft, y: top - 32), font: numberFont, color: textPrimary)
            var monthText = "30天 " + PanelView.shortNumber(planUsage.totalTokens ?? 0)
            if let cost = planUsage.estimatedCostUsd {
                let snapped = (cost * 100).rounded() / 100
                monthText += String(format: " · $%.2f", snapped)
            }
            drawRightAligned(monthText, y: top - 32, right: cardRect.maxX - 16,
                             font: numberFont, color: textPrimary)

            // 最近 14 天迷你柱状图（底部对齐，今日高亮）
            let bars = planUsage.daily?.suffix(14) ?? []
            if bars.count > 1 {
                let chartBottom = top - 72
                let chartHeight: CGFloat = 26
                let gap: CGFloat = 2
                let barWidth = (contentWidth - CGFloat(bars.count - 1) * gap) / CGFloat(bars.count)
                let peak = max(bars.map { $0.totalTokens }.max() ?? 0, 1)
                for (index, entry) in bars.enumerated() {
                    let height = max(2, chartHeight * entry.totalTokens / peak)
                    let rect = NSRect(x: contentLeft + CGFloat(index) * (barWidth + gap),
                                      y: chartBottom,
                                      width: barWidth, height: height)
                    (entry.day == today ? accentColor : NSColor(white: 1, alpha: 0.22)).setFill()
                    NSBezierPath(roundedRect: rect, xRadius: 1, yRadius: 1).fill()
                }
            }

            // Top 项目（路径取最后两段）
            var projectY = top - 92
            for project in planUsage.topProjects?.prefix(3) ?? [] {
                let name = PanelView.projectDisplayName(project.project)
                drawTruncatedRight(name, y: projectY, right: cardRect.maxX - 74, maxWidth: 190,
                                   font: .systemFont(ofSize: 10), color: textSecondary)
                var tokens = PanelView.shortNumber(project.totalTokens)
                if let cost = project.estimatedCostUsd {
                    tokens += String(format: " · $%.1f", cost)
                }
                drawRightAligned(tokens, y: projectY, right: cardRect.maxX - 16,
                                 font: .monospacedDigitSystemFont(ofSize: 10, weight: .medium), color: textTertiary)
                projectY -= 14
            }

            let models = planUsage.topModels?.prefix(3).map { $0.model } ?? []
            if !models.isEmpty {
                drawTruncatedRight("模型 " + models.joined(separator: " · "), y: projectY, right: cardRect.maxX - 16,
                                   maxWidth: contentWidth, font: .systemFont(ofSize: 9.5), color: textTertiary)
            }

            // dsh-track 深链（deep-link-handoff.md）：可点击的最近会话行
            let sessions = (planUsage.recentSessions ?? []).filter { $0.url != nil }.prefix(2)
            var sessionY = cardRect.minY + 30
            sessionRowRects = []
            for session in sessions {
                let name = PanelView.projectDisplayName(session.project ?? session.sessionId)
                drawTruncatedRight("↗ " + name, y: sessionY, right: cardRect.maxX - 66, maxWidth: 200,
                                   font: .systemFont(ofSize: 10), color: accentColor)
                drawRightAligned(PanelView.agoText(session.timestamp), y: sessionY, right: cardRect.maxX - 16,
                                 font: .monospacedDigitSystemFont(ofSize: 9.5, weight: .medium), color: textTertiary)
                sessionRowRects.append((rect: NSRect(x: contentLeft, y: sessionY - 4, width: contentWidth, height: 16),
                                        url: URL(string: session.url!)!))
                sessionY -= 16
            }
        } else if planSlug != nil {
            drawText("THIS PLAN · 30 DAYS", at: NSPoint(x: contentLeft, y: y + 24),
                     font: .systemFont(ofSize: 9, weight: .bold), color: textTertiary)
            drawText("无本地用量记录", at: NSPoint(x: contentLeft, y: y + 6),
                     font: .systemFont(ofSize: 11), color: textTertiary)
        } else {
            drawText("TOKEN USAGE · 30 DAYS", at: NSPoint(x: contentLeft, y: y + 24),
                     font: .systemFont(ofSize: 9, weight: .bold), color: textTertiary)
            var main = "总量 " + PanelView.shortNumber(usage?.totals?.totalTokens ?? 0)
            if let cost = usage?.totals?.estimatedCostUsd {
                let snapped = (cost * 100).rounded() / 100
                main += String(format: " · 估算 $%.2f", snapped)
            }
            drawText(main, at: NSPoint(x: contentLeft, y: y + 6), font: numberFont, color: textPrimary)
            let top = usage?.providerTotals.prefix(3).map { "\($0.provider) \(PanelView.shortNumber($0.tokens))" } ?? []
            if !top.isEmpty {
                drawText(top.joined(separator: " · "), at: NSPoint(x: contentLeft, y: y - 10),
                         font: .systemFont(ofSize: 10), color: textSecondary)
            }
        }
    }

    // ── 交互：自绘箭头的命中区域 + 总览行点击跳转 ─────────────────
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if chevronLeftRect.contains(point) {
            goPrev()
            return
        }
        if chevronRightRect.contains(point) {
            goNext()
            return
        }
        for row in sessionRowRects where row.rect.contains(point) {
            NSWorkspace.shared.open(row.url)
            return
        }
        for row in indexRowRects where row.rect.contains(point) {
            if let pageIndex = pages.firstIndex(where: { page in
                if case .provider(let i) = page { return i == row.planIndex }
                return false
            }) {
                page = pageIndex
                onSelect(page)
                setNeedsDisplay(bounds)
            }
            return
        }
    }

    private func drawText(_ string: String, at point: NSPoint, font: NSFont, color: NSColor,
                          maxWidth: CGFloat? = nil, maxLines: Int = 1) {
        let attr = NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: color])
        if let maxWidth {
            attr.draw(in: NSRect(x: point.x, y: point.y, width: maxWidth, height: CGFloat(maxLines) * (font.pointSize + 4)))
        } else {
            attr.draw(at: point)
        }
    }

    private func drawRightAligned(_ string: String, y: CGFloat, right: CGFloat, font: NSFont, color: NSColor) {
        let attr = NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: color])
        let size = attr.size()
        attr.draw(at: NSPoint(x: right - size.width, y: y))
    }

    private func drawTruncatedRight(_ string: String, y: CGFloat, right: CGFloat, maxWidth: CGFloat,
                                    font: NSFont, color: NSColor) {
        let para = NSMutableParagraphStyle()
        para.alignment = .right
        para.lineBreakMode = .byTruncatingTail
        let attr = NSAttributedString(string: string, attributes: [
            .font: font, .foregroundColor: color, .paragraphStyle: para,
        ])
        attr.draw(in: NSRect(x: right - maxWidth, y: y, width: maxWidth, height: font.pointSize + 4))
    }

    private func color(forStatus status: String) -> NSColor {
        switch status {
        case "ok": return okColor
        case "stale", "not_configured": return warnColor
        case "error", "auth_error": return badColor
        default: return textTertiary
        }
    }

    private func color(forRemaining remaining: Double?) -> NSColor {
        guard let remaining else { return textTertiary }
        if remaining > 50 { return okColor }
        if remaining > 10 { return warnColor }
        return badColor
    }

    private func statusText(_ status: String) -> String {
        [
            "ok": "正常运行", "stale": "数据过期", "error": "拉取失败",
            "not_configured": "待配置", "auth_error": "凭据失效", "unavailable": "未接入",
        ][status] ?? status
    }

    private func authLabel(_ auth: String) -> String {
        ["manual": "手动 key", "auto": "自动凭据", "missing": "无凭据",
         "invalid": "凭据失效", "unknown": "未检测"][auth] ?? auth
    }

    static func projectDisplayName(_ path: String) -> String {
        let parts = path.split(separator: "/").filter { !$0.isEmpty }
        return parts.count > 2 ? parts.suffix(2).joined(separator: "/") : path
    }

    static func shortNumber(_ value: Double) -> String {
        let abs = Swift.abs(value)
        if abs >= 1_000_000_000 { return String(format: "%.1fB", (value / 1_000_000_000 * 10).rounded() / 10) }
        if abs >= 1_000_000 { return String(format: "%.1fM", (value / 1_000_000 * 10).rounded() / 10) }
        if abs >= 1_000 {
            let f = NumberFormatter()
            f.numberStyle = .decimal
            f.usesGroupingSeparator = true
            f.maximumFractionDigits = 0
            return f.string(from: NSNumber(value: value / 1_000)) ?? "\(Int(value / 1_000))K"
        }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.usesGroupingSeparator = true
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: value)) ?? "\(Int(value))"
    }

    // ── 余额型 provider 语义(与 dashboard formatWindowValue 对齐)──────
    // deepseek 等:used == total 且无 percentage → 展示余额本身,不画
    // "--%"、不重复 used/total、不存在「恢复」概念。

    // 纯函数标 nonisolated:要作为谓词传给 first(where:) 等 stdlib 参数
    nonisolated static func isBalanceWindow(_ w: Window) -> Bool {
        guard let used = w.used, let total = w.total, w.percentage == nil else { return false }
        return abs(used - total) < 1e-9
    }

    nonisolated static func currencySymbol(_ unit: String?) -> String? {
        switch (unit ?? "").uppercased() {
        case "CNY", "RMB", "¥": return "¥"
        case "USD", "$": return "$"
        default: return nil
        }
    }

    /// 窗口数值文本(货币带符号两位小数;其余走 shortNumber)。
    static func windowValueText(_ w: Window) -> String {
        guard let used = w.used else { return "--" }
        guard let sym = currencySymbol(w.unit) else { return shortNumber(used) }
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.usesGroupingSeparator = true
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        let body = f.string(from: NSNumber(value: used)) ?? String(format: "%.2f", used)
        return sym + body
    }

    /// 总览紧凑行右侧的摘要值:最紧窗口的百分比 / 余额 / ∞ / --。
    static func indexSummaryValue(for plan: Plan) -> String {
        if let tight = plan.windows.filter({ $0.percentage != nil })
            .max(by: { ($0.percentage ?? 0) < ($1.percentage ?? 0) }) {
            return "\(Int(tight.percentage!.rounded()))%"
        }
        if let balance = plan.windows.first(where: isBalanceWindow) {
            return windowValueText(balance)
        }
        if plan.windows.contains(where: { $0.note == "不限量" && $0.percentage == nil }) {
            return "∞"
        }
        return "--"
    }

    /// Claude Code 闲置超过 24h 时返回 "25h" / "3d"，否则 nil。
    static func fableIdleLabel(for plan: Plan, nowMs: Double) -> String? {
        guard plan.adapter == "claude" else { return nil }
        guard let last = plan.fableLastUsedAt else { return nil }
        let idle = nowMs - last
        if idle < 24 * 3600 * 1000 { return nil }
        if idle < 48 * 3600 * 1000 { return "\(Int((idle / 3600000).rounded()))h" }
        return "\(Int((idle / 86_400_000).rounded()))d"
    }

    static func countdownText(until resetAtMs: Double) -> String {
        let interval = resetAtMs / 1000 - Date().timeIntervalSince1970
        if interval <= 0 { return "已恢复" }
        let minutes = max(1, Int((interval / 60).rounded(.up)))
        if minutes < 60 { return "\(minutes)分钟后" }
        let hours = minutes / 60
        let restMinutes = minutes % 60
        if hours < 24 { return "\(hours)小时\(restMinutes > 0 ? " \(restMinutes)分" : "")后" }
        let days = hours / 24
        let restHours = hours % 24
        return restHours > 0 ? "\(days)天\(restHours)小时后" : "\(days)天后"
    }

    static func shortDateTime(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = "MM/dd HH:mm"
        return formatter.string(from: date)
    }

    static func agoText(_ ms: Double) -> String {
        let seconds = Date().timeIntervalSince1970 - ms / 1000
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        let hours = Int(seconds / 3600)
        if hours < 24 { return "\(hours) 小时前" }
        let days = hours / 24
        let restHours = hours % 24
        return restHours > 0 ? "\(days) 天 \(restHours) 小时前" : "\(days) 天前"
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
    /// PanelView 当前页码（总览页=0..n，之后每 provider 一页）。跨菜单重建保持。
    private var selectedPlanIndex = 0
    private var didBootstrapBrowserSessions = false
    private var safariPermissionState: SafariPermissionState = .unknown
    private var safariPermissionTimer: Timer?
    /// daemon 内部每 60s 刷新 provider，menubar 也按 60s 拉取 /api/overview，
    /// 否则卡片数据停留在启动时（web 每 30s 轮询所以永远是新的）。
    private var pollTimer: Timer?
    private var isMenuOpen = false
    private var pendingMenuRebuild = false

    func applicationDidFinishLaunching(_: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        port = configuredPort()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateMenuBarIcon()
        rebuildMenu()

        ensureDaemon()
        refreshOverview()
        offerAutoLaunchIfNeeded()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshOverview() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.startSafariPermissionOnboardingIfNeeded()
        }
    }

    /// 首次启动：若 LaunchAgent 还没装，弹窗问用户要不要开机自启。
    /// 用户回答过（包括拒绝）就只问一次，记在 UserDefaults。
    private func offerAutoLaunchIfNeeded() {
        let plistPath = "\(NSHomeDirectory())/Library/LaunchAgents/local.planofplan.daemon.plist"
        if FileManager.default.fileExists(atPath: plistPath) { return }
        if UserDefaults.standard.bool(forKey: "planofplan.autoLaunchOffered") { return }
        UserDefaults.standard.set(true, forKey: "planofplan.autoLaunchOffered")

        let alert = NSAlert()
        alert.messageText = "登录时自动启动 planofplan？"
        alert.informativeText = "开启后崩溃/重启会自动拉起 daemon（launchd 守护）。Dashboard 顶部的「开机自启」开关可随时关闭。"
        alert.addButton(withTitle: "开启")
        alert.addButton(withTitle: "暂不")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        installLaunchAgent(plistPath: plistPath)
    }

    private func installLaunchAgent(plistPath: String) {
        let logPath = "\(NSHomeDirectory())/.planofplan/serve.log"
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>local.planofplan.daemon</string>
          <key>ProgramArguments</key>
          <array>
            <string>/Applications/planofplan.app/Contents/MacOS/planofplan-daemon</string>
            <string>serve</string>
            <string>--port</string>
            <string>\(port)</string>
          </array>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <true/>
          <key>ThrottleInterval</key>
          <integer>10</integer>
          <key>StandardOutPath</key>
          <string>\(logPath)</string>
          <key>StandardErrorPath</key>
          <string>\(logPath)</string>
        </dict>
        </plist>
        """
        do {
            let launchAgentsDir = "\(NSHomeDirectory())/Library/LaunchAgents"
            try FileManager.default.createDirectory(atPath: launchAgentsDir, withIntermediateDirectories: true)
            try plist.write(toFile: plistPath, atomically: true, encoding: .utf8)
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            task.arguments = ["bootstrap", "gui/\(getuid())", plistPath]
            try task.run()
            task.waitUntilExit()
        } catch {
            NSLog("planofplan: failed to install LaunchAgent: \(error)")
        }
    }

    func applicationWillTerminate(_: Notification) {
        pollTimer?.invalidate()
        safariPermissionTimer?.invalidate()
        if let daemon, daemon.isRunning {
            daemon.terminate()
        }
    }

    /** 数据到达后的安全刷新：菜单打开时也原地重填，避免用户看到旧数据。 */
    private func refreshUISafely() {
        if isMenuOpen, let menu = statusItem.menu {
            refillMenu(menu)
            updateMenuBarIcon()
            return
        }
        rebuildMenu()
        updateMenuBarIcon()
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

        if let overview, !overview.plans.isEmpty {
            let item = NSMenuItem()
            item.view = PanelView(
                plans: overview.plans,
                usage: usageSummary,
                startPage: selectedPlanIndex
            ) { [weak self] page in
                self?.selectedPlanIndex = page
            }
            item.isEnabled = false
            menu.addItem(item)
        } else {
            let item = NSMenuItem(title: "正在连接本地 daemon…", action: nil, keyEquivalent: "")
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

    // Lumen 规范 menubar icon：18×18pt template，单色随系统反色，不显示数字。
    // 三态：daemon 运行 100% opacity，停止 40%，刷新中脉冲 1.6s。
    private func updateMenuBarIcon() {
        statusItem.button?.image = renderTemplateIcon()
        statusItem.button?.imagePosition = .imageOnly
        statusItem.button?.alphaValue = overview == nil ? 0.4 : 1.0
    }

    private func renderTemplateIcon() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let icon = NSImage(size: size)
        icon.lockFocus()
        NSColor.black.setFill()

        // 图形整体居中：轨道中心放在 canvas 几何中心 (9, 9)，而不是偏上。
        // 半圆轨道：r 5.5 @ (9, 9)，1.8px stroke，顶部 y=14.5，底部 y=3.5。
        let center = NSPoint(x: 9, y: 9)
        let track = NSBezierPath()
        track.appendArc(
            withCenter: center,
            radius: 5.5,
            startAngle: 0,
            endAngle: 180,
            clockwise: false
        )
        track.lineWidth = 1.8
        track.lineCapStyle = .round
        track.stroke()

        // 指针：从圆心到右上 45°，1.6px stroke
        let needle = NSBezierPath()
        needle.move(to: center)
        needle.line(to: NSPoint(x: 12.9, y: 5.1))
        needle.lineWidth = 1.6
        needle.lineCapStyle = .round
        needle.stroke()

        // 中心轴环
        let hub = NSBezierPath(ovalIn: NSRect(x: 7.2, y: 7.2, width: 3.6, height: 3.6))
        hub.lineWidth = 1.4
        hub.stroke()

        icon.unlockFocus()
        icon.isTemplate = true
        return icon
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
        let binary = bundleDaemonURL()
        guard FileManager.default.isExecutableFile(atPath: binary.path) else {
            NSLog("planofplan: bundled daemon missing at \(binary.path)")
            return
        }

        let process = Process()
        process.executableURL = binary
        process.arguments = ["serve", "--port", String(port)]
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
            NSLog("planofplan: failed to start bundled daemon: \(error)")
        }
    }

    /// Path to the standalone daemon compiled into the bundle by build-menubar.sh.
    /// Falls back to the installed app location for dev runs outside /Applications.
    private func bundleDaemonURL() -> URL {
        if let url = Bundle.main.url(forResource: "planofplan-daemon", withExtension: nil, subdirectory: "MacOS") {
            return url
        }
        return URL(fileURLWithPath: "/Applications/planofplan.app/Contents/MacOS/planofplan-daemon")
    }

    private func findExecutable(candidates: [String?]) -> String? {
        for candidate in candidates.compactMap({ $0 }) where FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
        return nil
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
            self.refreshUISafely()
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
            self.refreshUISafely()
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

    func menuWillOpen(_ menu: NSMenu) {
        isMenuOpen = true
        Task { @MainActor in self.refreshOverview() }
    }

    func menuDidClose(_ menu: NSMenu) {
        isMenuOpen = false
        if pendingMenuRebuild {
            pendingMenuRebuild = false
            rebuildMenu()
            updateMenuBarIcon()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
