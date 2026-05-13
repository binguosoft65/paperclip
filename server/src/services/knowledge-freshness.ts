/**
 * Knowledge node freshness 计算（PRD §4.4）—— 实时算，不存 DB。
 *
 * 公式：
 *   if valid_until 已过       → 0.0
 *   if valid_until 30 天内    → 0.3
 *   else                       → exp(-age_days / half_life)
 *     half_life: stable=∞ / slow=365 / fast=90
 *     age_days = days_since(verified_at || created_at)
 *
 * 强制降权：metadata.forced_outdated_at 存在时强制 freshness ≤ 0.3。
 * 这个字段由反馈 service 在收到 'outdated' 反馈时写入。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SOON_EXPIRY_DAYS = 30;

const HALF_LIFE_DAYS: Record<string, number | null> = {
  stable: null,    // 不衰减
  slow: 365,
  fast: 90,
};

export interface FreshnessInput {
  volatility: string | null | undefined;
  verifiedAt: Date | string | null | undefined;
  validUntil: Date | string | null | undefined;
  createdAt: Date | string;
  metadata?: Record<string, unknown> | null;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function computeFreshness(input: FreshnessInput, now: Date = new Date()): number {
  const validUntil = toDate(input.validUntil);
  if (validUntil) {
    const diffMs = validUntil.getTime() - now.getTime();
    if (diffMs < 0) return 0.0;
    if (diffMs <= SOON_EXPIRY_DAYS * DAY_MS) return 0.3;
  }

  const volatility = (input.volatility ?? "slow").toLowerCase();
  const halfLife = volatility in HALF_LIFE_DAYS ? HALF_LIFE_DAYS[volatility] : HALF_LIFE_DAYS.slow!;

  let score: number;
  if (halfLife === null) {
    // stable: 不衰减
    score = 1.0;
  } else {
    const ref = toDate(input.verifiedAt) ?? toDate(input.createdAt) ?? now;
    const ageMs = Math.max(0, now.getTime() - ref.getTime());
    const ageDays = ageMs / DAY_MS;
    score = Math.exp(-ageDays / halfLife);
  }

  // 反馈强制 outdated
  const forced = input.metadata?.forced_outdated_at;
  if (forced && typeof forced === "string" && !Number.isNaN(new Date(forced).getTime())) {
    score = Math.min(score, 0.3);
  }

  // clamp [0, 1]
  return Math.max(0, Math.min(1, score));
}

export type FreshnessLabel = "fresh" | "stale_warning" | "outdated";

export function freshnessLabel(score: number): FreshnessLabel {
  if (score >= 0.7) return "fresh";
  if (score >= 0.3) return "stale_warning";
  return "outdated";
}
