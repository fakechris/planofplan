/**
 * 额度阈值告警(INV-922,借鉴 Magpie b0a0165)。
 *
 * 只用已有轮询结果,不发任何额外的供应商请求。规则:
 * - 用量窗口:百分比 ≥ 阈值时提醒一次;新鲜读数回落到阈值以下才重新武装。
 *   重置后用量归零自然低于阈值,所以就是"每窗口每周期一次",也不依赖各家
 *   漂移的 resetAt。
 * - 余额窗口(无百分比、单位是币种):金额 ≤ 阈值时提醒一次;充值回到阈值以上重新武装。
 * - 只看 status=ok 且启用的 plan:过期、失败、凭据失效的读数既不提醒也不重新武装;
 *   百分比未知不当作 0 或 100。
 */
import type { QuotaAlertRecord, Store } from './db.ts';
import type { QuotaWindow } from './types.ts';

export interface AlertSettings {
  /** 用量阈值(1–100),null = 关闭。 */
  usagePercent: number | null;
  /** 余额阈值(该 plan 的币种单位),null = 关闭。 */
  balance: number | null;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = { usagePercent: 80, balance: null };

export interface AlertPlan {
  slug: string;
  name: string;
  enabled: boolean;
  status: string;
  windows: Array<Pick<QuotaWindow, 'window' | 'label' | 'unit' | 'used' | 'total' | 'percentage' | 'resetAt'>>;
}

export interface AlertDecision {
  raise: Omit<QuotaAlertRecord, 'createdAt' | 'deliveredAt'>[];
  clear: string[];
}

const CURRENCY = /^[A-Z]{3}$/;

function fmtAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function fmtReset(resetAt: number | null): string {
  if (resetAt == null) return '';
  return `,${new Date(resetAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置`;
}

export function evaluateQuotaAlerts(plans: AlertPlan[], settings: AlertSettings, alerted: Set<string>): AlertDecision {
  const decision: AlertDecision = { raise: [], clear: [] };
  for (const plan of plans) {
    if (!plan.enabled || plan.status !== 'ok') continue;
    for (const window of plan.windows) {
      if (window.percentage != null) {
        const threshold = settings.usagePercent;
        if (threshold == null) continue;
        const key = `${plan.slug}|${window.window}|usage`;
        if (window.percentage >= threshold) {
          if (!alerted.has(key)) {
            decision.raise.push({
              key, planSlug: plan.slug, window: window.window, kind: 'usage', value: window.percentage, threshold,
              message: `${plan.name} ${window.label} 已用 ${fmtAmount(window.percentage)}%(阈值 ${threshold}%)${fmtReset(window.resetAt)}`,
            });
          }
        } else if (alerted.has(key)) {
          decision.clear.push(key);
        }
      } else if (CURRENCY.test(window.unit)) {
        const threshold = settings.balance;
        const amount = window.used ?? window.total;
        if (threshold == null || amount == null) continue;
        const key = `${plan.slug}|${window.window}|balance`;
        if (amount <= threshold) {
          if (!alerted.has(key)) {
            decision.raise.push({
              key, planSlug: plan.slug, window: window.window, kind: 'balance', value: amount, threshold,
              message: `${plan.name} 余额 ${fmtAmount(amount)} ${window.unit}(阈值 ${fmtAmount(threshold)})`,
            });
          }
        } else if (alerted.has(key)) {
          decision.clear.push(key);
        }
      }
    }
  }
  return decision;
}

/** 按当前读数更新告警状态,返回待菜单栏发送(未确认)的告警。 */
export function checkQuotaAlerts(store: Store, plans: AlertPlan[], settings: AlertSettings, now: number): QuotaAlertRecord[] {
  const decision = evaluateQuotaAlerts(plans, settings, new Set(store.quotaAlertKeys()));
  store.deleteQuotaAlerts(decision.clear);
  store.insertQuotaAlerts(decision.raise.map((alert) => ({ ...alert, createdAt: now })));
  return store.pendingQuotaAlerts();
}
