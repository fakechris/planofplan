import AppKit
import Foundation
import ServiceManagement
@preconcurrency import UserNotifications
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
    /// 上次本地 Claude Code 用 fable 系模型（claude-fable 前缀，由 daemon 计算）的 epoch ms；null/缺失表示从未用过。
    let fableLastUsedAt: Double?
    /// 限流冷却截止 epoch ms；null/缺失=不在冷却（INV-466：限流是预期态不是故障）。
    let cooldownUntil: Double?
}

struct Window: Decodable {
    let label: String
    let used: Double?
    let total: Double?
    let unit: String?
    let percentage: Double?
    let resetAt: Double?
    let note: String?

    var isReset: Bool {
        guard let resetAt else { return false }
        return resetAt <= Date().timeIntervalSince1970 * 1000
    }

    var effectivePercentage: Double? {
        guard let percentage else { return nil }
        return isReset ? 0 : percentage
    }

    var effectiveUsed: Double? {
        guard let used else { return nil }
        return isReset ? 0 : used
    }
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

/// provider 页用量页脚的内容：柱状图开关 + 明细行（Top 项目 ≤3 → 模型 →
/// 最近会话 ≤2）。卡片高度和绘制共用这一份——两边各算各的，卡片就和实际
/// 画出来的内容对不上（旧实现固定按 177pt 预留，行数少时底部整块空白）。
struct PlanUsageFooterContent {
    typealias PlanUsageRow = UsageSummary.PlanUsageRow

    static let rowPitch: CGFloat = 14
    static let rowBoxHeight: CGFloat = 13.5

    let planUsage: PlanUsageRow
    let hasChart: Bool
    let projects: [PlanUsageRow.ProjectEntry]
    let models: [String]
    let sessions: [PlanUsageRow.SessionEntry]

    init(_ planUsage: PlanUsageRow) {
        self.planUsage = planUsage
        hasChart = (planUsage.daily ?? []).count > 1
        projects = Array((planUsage.topProjects ?? []).prefix(3))
        models = (planUsage.topModels ?? []).prefix(3).map(\.model)
        sessions = Array((planUsage.recentSessions ?? []).filter { $0.url != nil }.prefix(2))
    }

    var rowCount: Int {
        projects.count + (models.isEmpty ? 0 : 1) + sessions.count
    }

    // 以下是各锚点距分隔线顶边向下的 pt；文本的锚点是行盒底边。
    var labelPoint: CGFloat { 17 }
    var totalsPoint: CGFloat { 37 }
    /// 柱状图底边；不足 2 根不画，直接接到今日 / 30 天行
    var chartBottom: CGFloat { totalsPoint + (hasChart ? 26 : 0) }
    /// 首个明细行的行盒底边；柱状图与明细行之间留 20
    var firstRowPoint: CGFloat { chartBottom + (rowCount > 0 ? 20 + Self.rowBoxHeight : 0) }
    /// 整块高度：到末行行盒底边，再留 4pt 到卡片底边
    var height: CGFloat {
        firstRowPoint + CGFloat(max(rowCount - 1, 0)) * Self.rowPitch + 4
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

    /// 页脚分隔线上方留白：provider 页最后一个窗口块（或提示文案）到页脚分隔线。
    static let footerGap: CGFloat = 16

    /// 面板高度按当前页内容自适应：总览页与 provider 页各自按实际要画的
    /// 内容计算，不再取全页最大值（短页会被撑到最高 provider 页的高度，
    /// 下方留一大块空白）。翻页时由 refillMenu 原地重填切换到新页高度。
    static func height(plans: [Plan], usage: UsageSummary?, startPage: Int) -> CGFloat {
        let page = min(max(startPage, 0), plans.count)
        let card = page == 0
            ? indexCardHeight(planCount: plans.count)
            : providerCardHeight(plans[page - 1], usage: usage)
        // 高度取整点：卡片边框按 0.5 内缩描边，半点高度在非 Retina 屏上发虚
        return 12 + card.rounded(.up)
    }

    /// 总览页卡片高度。视图坐标原点在左下角，draw(at:) 的点是行盒底边，
    /// 下面的数都按「距卡片顶边向下」计：头部 66 + 每 plan 一行 25（行
    /// 内分隔线在 rowTop 下 23）+ 页脚 55（分隔线在 cardRect.minY + 54）。
    /// 末行不画自己的分隔线，页脚分隔线就是列表的收口线。上限 760 防失控。
    static func indexCardHeight(planCount: Int) -> CGFloat {
        let rowsBottom = 66 + CGFloat(planCount - 1) * 25 + 23
        return min(rowsBottom + 55, 760)
    }

    /// provider 页卡片高度：与 drawProviderPage 的光标推进逐项对齐——
    /// 状态区 97（头部 66 + 状态行 17 + 更新时间行 14），fable / 限流冷却
    /// 警示行各 16，窗口块 71（带 note 85），再接页脚：用量块按实际明细行数
    /// 算（PlanUsageFooterContent），无用量记录 39。每个窗口块自带 38pt
    /// 尾部留白，末块换成 footerGap；页脚高度都从分隔线顶边算到卡片底边。
    static func providerCardHeight(_ plan: Plan, usage: UsageSummary?) -> CGFloat {
        let nowMs = Date().timeIntervalSince1970 * 1000
        var contentBottom: CGFloat = 97
        if fableIdleLabel(for: plan, nowMs: nowMs) != nil { contentBottom += 16 }
        if let cooldown = plan.cooldownUntil, cooldown > nowMs { contentBottom += 16 }
        if plan.windows.isEmpty {
            // 提示文案块的顶边在光标下方 6
            contentBottom += 6 + emptyWindowsMessageHeight(plan)
        } else {
            for window in plan.windows {
                contentBottom += (window.note?.isEmpty == false) ? 85 : 71
            }
            contentBottom -= 38
        }
        let footer: CGFloat
        if let planUsage = usage?.usage(forPlan: plan.slug) {
            footer = PlanUsageFooterContent(planUsage).height
        } else {
            footer = 39
        }
        return contentBottom + footerGap + footer
    }

    /// provider 页没有任何窗口时显示的提示文案：未配置给配置指引，否则给
    /// 上次错误。绘制与 providerCardHeight 共用。
    static func emptyWindowsMessage(_ plan: Plan) -> String {
        plan.status == "not_configured" ? (plan.credentialHint ?? "暂无数据") : (plan.lastError ?? "暂无数据")
    }

    /// 这段文案在页内宽度下占的高度：最多两行，每行按 pointSize + 4 算，
    /// 与 drawBlock 的矩形一致（一行不到 15，两行不小于 26）。
    static func emptyWindowsMessageHeight(_ plan: Plan) -> CGFloat {
        let message = NSAttributedString(
            string: emptyWindowsMessage(plan),
            attributes: [.font: NSFont.systemFont(ofSize: 11)]
        )
        let laidOut = message.boundingRect(
            with: NSSize(width: panelWidth - cardInset * 2 - 32, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        return CGFloat(laidOut.height > 20 ? 2 : 1) * 15
    }

    init(plans: [Plan], usage: UsageSummary?, startPage: Int = 0, onSelect: @escaping (Int) -> Void = { _ in }) {
        self.plans = plans
        self.usage = usage
        self.onSelect = onSelect
        super.init(frame: NSRect(x: 0, y: 0, width: PanelView.panelWidth,
                                 height: PanelView.height(plans: plans, usage: usage, startPage: startPage)))
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
        showPage((page - 1 + pages.count) % pages.count)
    }

    private func goNext() {
        showPage((page + 1) % pages.count)
    }

    /// 切页：这个视图自己把高度切到新页，再让所在的菜单项重新排版。
    ///
    /// 必须是屏幕上这个视图就地改，不能靠重填 statusItem.menu：菜单打开期间
    /// rebuildMenu() 会把 statusItem.menu 换成另一个 NSMenu 对象，重填的是不在
    /// 屏幕上的那个；屏幕上的视图若只是重绘，新页内容会挤在旧 frame 里——窗口
    /// 块自上而下、页脚自下而上，高度不够时两头的文字就叠在一起。
    private func showPage(_ newPage: Int) {
        page = newPage
        onSelect(page)
        let newHeight = PanelView.height(plans: plans, usage: usage, startPage: page)
        if abs(newHeight - frame.height) > 0.5 {
            frame.size.height = newHeight
            // 菜单不会自己察觉自定义视图的 frame 变了
            if let item = enclosingMenuItem {
                item.menu?.itemChanged(item)
            }
        }
        needsDisplay = true
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
            let pa = plans[a].windows.compactMap { $0.effectivePercentage }.max() ?? 0
            let pb = plans[b].windows.compactMap { $0.effectivePercentage }.max() ?? 0
            return pa > pb
        }

        for (position, planIndex) in sorted.enumerated() {
            // 行下方的分隔线必须落在页脚分隔线（cardRect.minY + 54）之上，
            // 否则这一行会压进页脚；plan 多到撞高度上限时在此截断
            guard y - 23 >= cardRect.minY + 54 else { break }
            let plan = plans[planIndex]
            let rowTop = y

            indexRowRects.append((rect: NSRect(x: contentLeft, y: rowTop - 24, width: contentWidth, height: 25), planIndex: planIndex))

            // 右侧三段(值/倒计时/窗口小标签)先算内容与实测宽度,从右往左堆叠;
            // 名称列最后按剩余宽度截断。旧实现用固定像素偏移(-46/-76)摆倒计时
            // 与标签,中文倒计时("19 小时 25 分后")或长标签("Standard 1M")一长
            // 就互相叠印(INV-2013)。
            let tight = plan.windows.filter { $0.effectivePercentage != nil }
                .max { ($0.effectivePercentage ?? 0) < ($1.effectivePercentage ?? 0) }
            let balance = plan.windows.first(where: PanelView.isBalanceWindow)
            let unlimited = plan.windows.contains { $0.note == "不限量" && $0.effectivePercentage == nil }

            let valueFont = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .semibold)
            let smallFont = NSFont.systemFont(ofSize: 9.5)
            let segmentGap: CGFloat = 8

            var value = "--"
            var valueColor = textTertiary
            if let tight {
                value = "\(Int(tight.effectivePercentage!.rounded()))%"
                valueColor = color(forRemaining: 100 - tight.effectivePercentage!)
            } else if let balance {
                value = PanelView.windowValueText(balance)
                valueColor = textPrimary
            } else if unlimited {
                value = "∞"
                valueColor = okColor
            }
            let valueAttr = NSAttributedString(string: value, attributes: [.font: valueFont, .foregroundColor: valueColor])
            let countdown = tight?.resetAt.map { PanelView.countdownText(until: $0) } ?? nil
            let label = tight?.label ?? (balance != nil ? "余额" : nil)
            let valueWidth = valueAttr.size().width
            let countdownWidth = countdown.map { ($0 as NSString).size(withAttributes: [.font: smallFont]).width } ?? 0
            let labelWidth = label.map { ($0 as NSString).size(withAttributes: [.font: smallFont]).width } ?? 0

            let rightEdge = cardRect.maxX - 16
            let valueX = rightEdge - valueWidth
            var cursor = valueX - segmentGap
            let countdownX = countdown.map { _ -> CGFloat in
                let x = cursor - countdownWidth
                cursor = x - segmentGap
                return x
            }
            // 标签优先级最低:空间挤到名称列时直接省略,不与名称/倒计时叠印
            let nameRightLimit = contentLeft + 12 + 72
            let labelX: CGFloat? = label.flatMap { _ in
                let x = cursor - labelWidth
                return x >= nameRightLimit ? x : nil
            }

            // 状态点 + 名称(按剩余宽度截断;禁用弱化由状态点颜色承担)
            color(forStatus: plan.status).setFill()
            NSBezierPath(ovalIn: NSRect(x: contentLeft, y: rowTop - 10, width: 5, height: 5)).fill()
            let nameLeft = min(valueX, countdownX ?? .greatestFiniteMagnitude, labelX ?? .greatestFiniteMagnitude)
            drawText(plan.name, at: NSPoint(x: contentLeft + 12, y: rowTop - 13),
                     font: .systemFont(ofSize: 11.5, weight: .medium), color: textPrimary,
                     maxWidth: max(48, nameLeft - (contentLeft + 12) - 10))

            if let label, let labelX {
                drawText(label, at: NSPoint(x: labelX, y: rowTop - 12), font: smallFont, color: textTertiary)
            }
            if let countdown, let countdownX {
                drawText(countdown, at: NSPoint(x: countdownX, y: rowTop - 12), font: smallFont, color: textTertiary)
            }
            valueAttr.draw(at: NSPoint(x: valueX, y: y - 13))

            // 行分隔线。末行不画：它和页脚分隔线落在同一位置（见
            // indexCardHeight），画两次会叠出一条更亮的线
            if position < sorted.count - 1 {
                NSColor(white: 1, alpha: 0.05).setFill()
                NSRect(x: contentLeft, y: rowTop - 24, width: contentWidth, height: 1).fill()
            }
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
            drawText("⚠ fable 空闲 \(label)", at: NSPoint(x: contentLeft, y: y),
                     font: .systemFont(ofSize: 11, weight: .semibold), color: warnColor)
            y -= 16
        }

        if let cooldown = plan.cooldownUntil,
           cooldown > Date().timeIntervalSince1970 * 1000 {
            let remainSec = Int((cooldown - Date().timeIntervalSince1970 * 1000) / 1000)
            let remain = remainSec >= 60 ? "\(remainSec / 60) 分 \(remainSec % 60) 秒" : "\(remainSec) 秒"
            drawText("⏸ 限流冷却中 \(remain)", at: NSPoint(x: contentLeft, y: y),
                     font: .systemFont(ofSize: 11, weight: .semibold), color: warnColor)
            y -= 16
        }

        if plan.windows.isEmpty {
            // 文案块的顶边放在光标下方 6，自上往下排。旧实现把这里的 y 当
            // 矩形底边交给 drawText，而 draw(in:) 从矩形顶边起排，整块文案
            // 上移 30pt，压在「更新于」行上。
            drawBlock(PanelView.emptyWindowsMessage(plan), top: y - 6, x: contentLeft, maxWidth: contentWidth,
                      maxLines: 2, font: .systemFont(ofSize: 11),
                      color: (plan.status == "auth_error" || plan.status == "error") ? badColor : textTertiary)
        } else {
            for window in plan.windows {
                let pct = window.effectivePercentage
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
                    if let used = window.effectiveUsed, let total = window.total {
                        fraction = PanelView.shortNumber(used) + " / " + PanelView.shortNumber(total)
                    } else if let used = window.effectiveUsed {
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
        let planFooter = planSlug.flatMap { usage?.usage(forPlan: $0) }.map { PlanUsageFooterContent($0) }
        // 三种页脚的分隔线都在各自内容块的顶部，锚点一律从卡片底边（cardRect.minY）
        // 往上数。无用量记录的 provider 页脚只有两行，比总览页少一行，不再沿用
        // 总览页的锚点白留一行的高度。
        let footerHeight = planFooter?.height ?? (planSlug != nil ? 39 : 55)
        NSColor(white: 1, alpha: 0.08).setFill()
        NSRect(x: contentLeft, y: cardRect.minY + footerHeight - 1, width: contentWidth, height: 1).fill()

        let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .semibold)
        if let planFooter {
            // 用量块自上而下排布，锚点都在 PlanUsageFooterContent 里
            // （分隔线顶边 − 偏移）。
            let planUsage = planFooter.planUsage
            let separatorTop = cardRect.minY + planFooter.height
            drawText("USAGE · 30 DAYS", at: NSPoint(x: contentLeft, y: separatorTop - planFooter.labelPoint),
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
            drawText(todayText, at: NSPoint(x: contentLeft, y: separatorTop - planFooter.totalsPoint),
                     font: numberFont, color: textPrimary)
            var monthText = "30天 " + PanelView.shortNumber(planUsage.totalTokens ?? 0)
            if let cost = planUsage.estimatedCostUsd {
                let snapped = (cost * 100).rounded() / 100
                monthText += String(format: " · $%.2f", snapped)
            }
            drawRightAligned(monthText, y: separatorTop - planFooter.totalsPoint, right: cardRect.maxX - 16,
                             font: numberFont, color: textPrimary)

            // 最近 14 天迷你柱状图（底部对齐，今日高亮）
            let bars = planUsage.daily?.suffix(14) ?? []
            if planFooter.hasChart {
                let chartBottom = separatorTop - planFooter.chartBottom
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

            // 明细行自上而下：Top 项目（路径取最后两段）→ 模型 → 最近会话。
            // 旧实现把项目名称右对齐到数值旁、给数值固定留 74pt，长金额
            // （"6.19B · $1222.4"）会压到名称上；模型行也被画成右对齐。
            var rowY = separatorTop - planFooter.firstRowPoint
            for project in planFooter.projects {
                let name = PanelView.projectDisplayName(project.project)
                var tokens = PanelView.shortNumber(project.totalTokens)
                if let cost = project.estimatedCostUsd {
                    tokens += String(format: " · $%.1f", cost)
                }
                drawUsageRow(name, value: tokens, y: rowY, contentLeft: contentLeft, contentWidth: contentWidth,
                             nameFont: .systemFont(ofSize: 10), nameColor: textSecondary,
                             valueFont: .monospacedDigitSystemFont(ofSize: 10, weight: .medium), valueColor: textTertiary)
                rowY -= PlanUsageFooterContent.rowPitch
            }

            if !planFooter.models.isEmpty {
                drawTruncated("模型 " + planFooter.models.joined(separator: " · "), x: contentLeft, y: rowY,
                              maxWidth: contentWidth, font: .systemFont(ofSize: 9.5), color: textTertiary)
                rowY -= PlanUsageFooterContent.rowPitch
            }

            // dsh-track 深链（deep-link-handoff.md）：可点击的最近会话行
            for session in planFooter.sessions {
                let name = PanelView.projectDisplayName(session.project ?? session.sessionId)
                drawUsageRow("↗ " + name, value: PanelView.agoText(session.timestamp), y: rowY,
                             contentLeft: contentLeft, contentWidth: contentWidth,
                             nameFont: .systemFont(ofSize: 10), nameColor: accentColor,
                             valueFont: .monospacedDigitSystemFont(ofSize: 9.5, weight: .medium), valueColor: textTertiary)
                sessionRowRects.append((rect: NSRect(x: contentLeft, y: rowY - 4, width: contentWidth, height: 16),
                                        url: URL(string: session.url!)!))
                rowY -= PlanUsageFooterContent.rowPitch
            }
        } else if planSlug != nil {
            drawText("THIS PLAN · 30 DAYS", at: NSPoint(x: contentLeft, y: cardRect.minY + 22),
                     font: .systemFont(ofSize: 9, weight: .bold), color: textTertiary)
            drawText("无本地用量记录", at: NSPoint(x: contentLeft, y: cardRect.minY + 4),
                     font: .systemFont(ofSize: 11), color: textTertiary)
        } else {
            drawText("TOKEN USAGE · 30 DAYS", at: NSPoint(x: contentLeft, y: cardRect.minY + 38),
                     font: .systemFont(ofSize: 9, weight: .bold), color: textTertiary)
            var main = "总量 " + PanelView.shortNumber(usage?.totals?.totalTokens ?? 0)
            if let cost = usage?.totals?.estimatedCostUsd {
                let snapped = (cost * 100).rounded() / 100
                main += String(format: " · 估算 $%.2f", snapped)
            }
            drawText(main, at: NSPoint(x: contentLeft, y: cardRect.minY + 20), font: numberFont, color: textPrimary)
            let top = usage?.providerTotals.prefix(3).map { "\($0.provider) \(PanelView.shortNumber($0.tokens))" } ?? []
            if !top.isEmpty {
                drawText(top.joined(separator: " · "), at: NSPoint(x: contentLeft, y: cardRect.minY + 4),
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
                showPage(pageIndex)
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

    /// 多行文本块：从 top（view 坐标里块的顶边）往下排，最多 maxLines 行。
    /// drawText 的 maxWidth 版本把点当矩形底边、文字却从矩形顶边起排，只适合
    /// 单行。
    private func drawBlock(_ string: String, top: CGFloat, x: CGFloat, maxWidth: CGFloat, maxLines: Int,
                           font: NSFont, color: NSColor) {
        let attr = NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: color])
        let height = CGFloat(maxLines) * (font.pointSize + 4)
        attr.draw(in: NSRect(x: x, y: top - height, width: maxWidth, height: height))
    }

    /// 用量明细行：名称左对齐，数值右对齐；先量数值宽度，名称按左侧剩余
    /// 宽度截断。
    private func drawUsageRow(_ name: String, value: String, y: CGFloat, contentLeft: CGFloat, contentWidth: CGFloat,
                              nameFont: NSFont, nameColor: NSColor, valueFont: NSFont, valueColor: NSColor) {
        let valueAttr = NSAttributedString(string: value, attributes: [.font: valueFont, .foregroundColor: valueColor])
        let valueWidth = valueAttr.size().width
        valueAttr.draw(at: NSPoint(x: contentLeft + contentWidth - valueWidth, y: y))
        drawTruncated(name, x: contentLeft, y: y, maxWidth: contentWidth - valueWidth - 12,
                      font: nameFont, color: nameColor)
    }

    /// 单行文本，超出 maxWidth 时尾部换成省略号。和 drawText 一样用 draw(at:)，
    /// 同一行里与数值共用行盒底边，基线对齐。
    private func drawTruncated(_ string: String, x: CGFloat, y: CGFloat, maxWidth: CGFloat, font: NSFont, color: NSColor) {
        func attributed(_ text: String) -> NSAttributedString {
            NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        }
        var text = attributed(string)
        guard text.size().width > maxWidth else {
            text.draw(at: NSPoint(x: x, y: y))
            return
        }
        var kept = Substring(string)
        while !kept.isEmpty {
            kept = kept.dropLast()
            text = attributed(kept + "…")
            if text.size().width <= maxWidth { break }
        }
        text.draw(at: NSPoint(x: x, y: y))
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
        guard let used = w.effectiveUsed, let total = w.total, w.effectivePercentage == nil else { return false }
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
        guard let used = w.effectiveUsed else { return "--" }
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
        if let tight = plan.windows.filter({ $0.effectivePercentage != nil })
            .max(by: { ($0.effectivePercentage ?? 0) < ($1.effectivePercentage ?? 0) }) {
            return "\(Int(tight.effectivePercentage!.rounded()))%"
        }
        if let balance = plan.windows.first(where: isBalanceWindow) {
            return windowValueText(balance)
        }
        if plan.windows.contains(where: { $0.note == "不限量" && $0.effectivePercentage == nil }) {
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

enum AutoLaunchManager {
    static let appPath = "/Applications/planofplan.app"
    static let appName = "planofplan"
    static let daemonLabel = "local.planofplan.daemon"

    static var isEnabled: Bool {
        if #available(macOS 13.0, *) {
            if SMAppService.mainApp.status == .enabled {
                return true
            }
        }
        let plistPath = "\(NSHomeDirectory())/Library/LaunchAgents/\(daemonLabel).plist"
        if FileManager.default.fileExists(atPath: plistPath) {
            return true
        }
        return isLoginItemRegistered()
    }

    static func setEnabled(_ enabled: Bool, port: Int) {
        if #available(macOS 13.0, *) {
            do {
                if enabled {
                    if SMAppService.mainApp.status != .enabled {
                        try SMAppService.mainApp.register()
                    }
                } else {
                    if SMAppService.mainApp.status == .enabled {
                        try SMAppService.mainApp.unregister()
                    }
                }
            } catch {
                NSLog("planofplan: SMAppService error: \(error)")
            }
        }

        if enabled {
            addLoginItem()
            installDaemonLaunchAgent(port: port)
        } else {
            removeLoginItem()
            removeDaemonLaunchAgent()
        }
    }

    private static func isLoginItemRegistered() -> Bool {
        let script = """
        tell application "System Events"
            return exists (login items whose name is "\(appName)" or path is "\(appPath)")
        end tell
        """
        guard let appleScript = NSAppleScript(source: script) else { return false }
        var error: NSDictionary?
        let result = appleScript.executeAndReturnError(&error)
        if let error {
            NSLog("planofplan: check login item error: \(error)")
            return false
        }
        return result.booleanValue
    }

    private static func addLoginItem() {
        let script = """
        tell application "System Events"
            if not (exists (login items whose name is "\(appName)" or path is "\(appPath)")) then
                make login item at end with properties {path:"\(appPath)", hidden:false, name:"\(appName)"}
            end if
        end tell
        """
        if let appleScript = NSAppleScript(source: script) {
            var error: NSDictionary?
            appleScript.executeAndReturnError(&error)
            if let error {
                NSLog("planofplan: add login item error: \(error)")
            }
        }
    }

    private static func removeLoginItem() {
        let script = """
        tell application "System Events"
            delete (every login item whose name is "\(appName)" or path is "\(appPath)")
        end tell
        """
        if let appleScript = NSAppleScript(source: script) {
            var error: NSDictionary?
            appleScript.executeAndReturnError(&error)
            if let error {
                NSLog("planofplan: remove login item error: \(error)")
            }
        }
    }

    static func installDaemonLaunchAgent(port: Int) {
        let plistPath = "\(NSHomeDirectory())/Library/LaunchAgents/\(daemonLabel).plist"
        let logPath = "\(NSHomeDirectory())/.planofplan/serve.log"
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(daemonLabel)</string>
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

    static func removeDaemonLaunchAgent() {
        let plistPath = "\(NSHomeDirectory())/Library/LaunchAgents/\(daemonLabel).plist"
        try? FileManager.default.removeItem(atPath: plistPath)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["bootout", "gui/\(getuid())/\(daemonLabel)"]
        try? task.run()
        task.waitUntilExit()
    }
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
        setUpQuotaAlertNotifications()
        refreshOverview()
        offerAutoLaunchIfNeeded()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshOverview() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.startSafariPermissionOnboardingIfNeeded()
        }
    }

    /// 首次启动：若开机自启还没装，弹窗问用户要不要开机自启。
    /// 用户回答过（包括拒绝）就只问一次，记在 UserDefaults。
    private func offerAutoLaunchIfNeeded() {
        if AutoLaunchManager.isEnabled { return }
        if UserDefaults.standard.bool(forKey: "planofplan.autoLaunchOffered") { return }
        UserDefaults.standard.set(true, forKey: "planofplan.autoLaunchOffered")

        let alert = NSAlert()
        alert.messageText = "登录时自动启动 planofplan？"
        alert.informativeText = "开启后登录时会自动启动菜单栏应用与本地后台服务。菜单栏与 Dashboard 中的「开机自启」开关可随时切换。"
        alert.addButton(withTitle: "开启")
        alert.addButton(withTitle: "暂不")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        AutoLaunchManager.setEnabled(true, port: port)
        refreshUISafely()
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

        // 一键复制 MCP 接入配置(sourcebot 接入漏斗实践):三种主流客户端的
        // 配置片段 + 通用端点,端口动态取 configuredPort(),不硬编码
        let mcp = NSMenuItem(title: "接入 Agent (MCP)", action: nil, keyEquivalent: "")
        let mcpMenu = NSMenu()
        for (label, text) in mcpConfigSnippets() {
            let item = NSMenuItem(title: label, action: #selector(copyMcpConfig(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = McpCopyPayload(label: label, text: text)
            item.toolTip = String(text.prefix(200))
            mcpMenu.addItem(item)
        }
        mcp.submenu = mcpMenu
        menu.addItem(mcp)

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

        let autoLaunch = NSMenuItem(
            title: "开机自启",
            action: #selector(toggleLaunchAtLogin),
            keyEquivalent: ""
        )
        autoLaunch.target = self
        autoLaunch.state = AutoLaunchManager.isEnabled ? .on : .off
        menu.addItem(autoLaunch)

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

    private func ensureDaemon() {
        // 启动竞速防御（INV-1243）：launchd label / 上一个 daemon 可能还没完成绑定。
        // 连续探测失败才考虑 spawn，避免与 KeepAlive 的 launchd 实例抢端口。
        probeDaemonThenStart(attempt: 0)
    }

    private func probeDaemonThenStart(attempt: Int) {
        request(path: "/api/overview", method: "GET") { [weak self] result, _ in
            guard let self else { return }
            if result != nil { return }
            if attempt >= 2 {
                self.startDaemon()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                self?.probeDaemonThenStart(attempt: attempt + 1)
            }
        }
    }

    private func startDaemon() {
        guard daemon == nil || daemon?.isRunning == false else { return }
        // LaunchAgent（KeepAlive=true）与直启子进程互斥：label 已加载时 daemon 归
        // launchd 管，menubar 只消费 API，不再 spawn 第二个实例抢端口（INV-1243）。
        if launchdLabelLoaded() {
            NSLog("planofplan: daemon managed by launchd label \(AutoLaunchManager.daemonLabel), skip direct spawn")
            return
        }
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

    /// launchd label 是否已加载（plist 存在且 launchctl print 成功）。
    /// 只看 plist 不够：用户可能手动 bootout 了但 plist 还在，此时仍需直启兜底。
    private func launchdLabelLoaded() -> Bool {
        let plistPath = "\(NSHomeDirectory())/Library/LaunchAgents/\(AutoLaunchManager.daemonLabel).plist"
        guard FileManager.default.fileExists(atPath: plistPath) else { return false }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["print", "gui/\(getuid())/\(AutoLaunchManager.daemonLabel)"]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
        } catch {
            return false
        }
        task.waitUntilExit()
        return task.terminationStatus == 0
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
            self.checkQuotaAlerts()
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

    @objc private func toggleLaunchAtLogin() {
        let next = !AutoLaunchManager.isEnabled
        AutoLaunchManager.setEnabled(next, port: port)
        refreshUISafely()
    }

    @objc private func openFullDiskAccessSettings() {
        NSWorkspace.shared.open(fullDiskAccessSettingsURL)
    }

    @objc private func copyBuildIdentity() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(buildMetadata.commitSHA, forType: .string)
    }

    /** 当前部署的 MCP 端点(端口来自 Bundle Resources/port)。 */
    private func mcpEndpoint() -> String {
        "http://localhost:\(port)/mcp"
    }

    /** 各客户端的接入配置片段:标题 → 待复制文本。 */
    private func mcpConfigSnippets() -> [(String, String)] {
        let endpoint = mcpEndpoint()
        return [
            ("复制 Claude Code 命令", "claude mcp add --transport http planofplan \(endpoint)"),
            ("复制 Cursor mcp.json 片段", "{\"mcpServers\":{\"planofplan\":{\"type\":\"http\",\"url\":\"\(endpoint)\"}}}"),
            ("复制 Codex config.toml 片段", "[mcp_servers.planofplan]\nurl = \"\(endpoint)\""),
            ("复制 MCP 端点 URL", endpoint),
        ]
    }

    @objc private func copyMcpConfig(_ sender: NSMenuItem) {
        guard let payload = sender.representedObject as? McpCopyPayload else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(payload.text, forType: .string)
        sender.title = "✓ 已复制"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak sender] in
            sender?.title = payload.label
        }
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }
}

struct BrowserSelection {
    let planSlug: String
    let browser: String
}

/// 「接入 Agent (MCP)」子菜单的复制载荷:label 用于复制成功后恢复标题。
struct McpCopyPayload {
    let label: String
    let text: String
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

// ── 额度告警通知(INV-922)──────────────────────────────────────────
// daemon 判定"该不该提醒"(每窗口每周期一次、过期读数不提醒),这里只负责发系统
// 通知:每次轮询 POST /api/alerts/check 报告通知权限并取待发告警,发出后 ack。
// 未授权时不 ack,告警留在 daemon 里,设置页显示为"待通知"。
private struct PendingQuotaAlert: Decodable {
    let key: String
    let message: String
}

private struct QuotaAlertCheck: Decodable {
    let pending: [PendingQuotaAlert]
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    /// UNUserNotificationCenter 只能在 .app bundle 里用(裸二进制会崩)。
    private var notificationsAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    fileprivate func setUpQuotaAlertNotifications() {
        guard notificationsAvailable else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        Task { @MainActor in
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
        }
    }

    fileprivate func checkQuotaAlerts() {
        guard notificationsAvailable else {
            postAlertCheck(notifier: "unavailable")
            return
        }
        Task { @MainActor in
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            let status: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: status = "authorized"
            case .denied: status = "denied"
            case .notDetermined: status = "not_determined"
            @unknown default: status = "unavailable"
            }
            postAlertCheck(notifier: status)
        }
    }

    private func postAlertCheck(notifier: String) {
        let body = try? JSONSerialization.data(withJSONObject: ["notifier": notifier])
        request(path: "/api/alerts/check", method: "POST", body: body) { [weak self] data, status in
            guard let self, status == 200, notifier == "authorized", let data,
                  let check = try? JSONDecoder().decode(QuotaAlertCheck.self, from: data),
                  !check.pending.isEmpty else { return }
            Task { @MainActor in await self.deliverQuotaAlerts(check.pending) }
        }
    }

    private func deliverQuotaAlerts(_ alerts: [PendingQuotaAlert]) async {
        var delivered: [String] = []
        for alert in alerts {
            let content = UNMutableNotificationContent()
            content.title = "planofplan 额度告警"
            content.body = alert.message
            content.sound = .default
            content.userInfo = ["url": "http://127.0.0.1:\(port)/#plans"]
            let request = UNNotificationRequest(identifier: "planofplan.alert.\(alert.key)", content: content, trigger: nil)
            do {
                try await UNUserNotificationCenter.current().add(request)
                delivered.append(alert.key)
            } catch {
                NSLog("planofplan: quota alert notification failed: \(error)")
            }
        }
        guard !delivered.isEmpty, let body = try? JSONSerialization.data(withJSONObject: ["keys": delivered]) else { return }
        request(path: "/api/alerts/ack", method: "POST", body: body) { _, _ in }
    }

    /// accessory app 常被视为前台:仍然弹横幅。
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// 点击告警打开 Dashboard 的额度页。
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let raw = response.notification.request.content.userInfo["url"] as? String,
              let url = URL(string: raw) else { return }
        await MainActor.run { _ = NSWorkspace.shared.open(url) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
