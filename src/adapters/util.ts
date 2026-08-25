/** Adapter 数值格式化帮手。
 *
 * 历史上 `(used / total) * 100` 这种浮点算式常把
 * `44 / 500 * 100 = 8.800000000000001` 漏到 UI。
 * 所有 adapter 都通过这里 clamp 到 [0, 100] 并截到两位小数。
 */

export function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(0, Math.min(100, value));
  return Math.round(clamped * 100) / 100;
}

/** 任意小数最多保留两位（不强制 0-100，用于 USD 之类的绝对值）。 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

/** 货币格式化:千分位 + 2 位小数 + 币种符号。币种代码大小写不敏感,未知币种
 * 走 ISO 前缀方案（如 `XYZ 1,861.52`）。无值/null/NaN 走 '--'。 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  HKD: 'HK$',
  TWD: 'NT$',
  KRW: '₩',
};

export function formatMoney(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return '--';
  const code = (currency || '').toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const formatted = round2(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return symbol ? `${symbol}${formatted}` : `${code} ${formatted}`;
}