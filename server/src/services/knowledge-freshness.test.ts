import { describe, it, expect } from "vitest";
import { computeFreshness, freshnessLabel } from "./knowledge-freshness.js";

const day = 24 * 60 * 60 * 1000;

function dateAgo(days: number) {
  return new Date(Date.now() - days * day);
}

describe("computeFreshness", () => {
  it("stable + 无 verified_at → 1.0", () => {
    expect(
      computeFreshness({ volatility: "stable", verifiedAt: null, validUntil: null, createdAt: dateAgo(100) }),
    ).toBe(1.0);
  });

  it("valid_until 已过 → 0.0", () => {
    expect(
      computeFreshness({
        volatility: "fast",
        verifiedAt: dateAgo(10),
        validUntil: dateAgo(1),
        createdAt: dateAgo(20),
      }),
    ).toBe(0.0);
  });

  it("valid_until 30 天内 → 0.3", () => {
    const fifteenDaysAhead = new Date(Date.now() + 15 * day);
    expect(
      computeFreshness({
        volatility: "slow",
        verifiedAt: dateAgo(10),
        validUntil: fifteenDaysAhead,
        createdAt: dateAgo(20),
      }),
    ).toBe(0.3);
  });

  it("fast volatility + 0 天龄 → ~1.0（exp(0)=1）", () => {
    const v = computeFreshness({
      volatility: "fast",
      verifiedAt: new Date(),
      validUntil: null,
      createdAt: new Date(),
    });
    expect(v).toBeGreaterThan(0.99);
  });

  it("fast volatility + 90 天龄 → ~0.368（exp(-1)）", () => {
    const v = computeFreshness({
      volatility: "fast",
      verifiedAt: dateAgo(90),
      validUntil: null,
      createdAt: dateAgo(90),
    });
    expect(v).toBeGreaterThan(0.35);
    expect(v).toBeLessThan(0.40);
  });

  it("slow volatility + 365 天龄 → ~0.368", () => {
    const v = computeFreshness({
      volatility: "slow",
      verifiedAt: dateAgo(365),
      validUntil: null,
      createdAt: dateAgo(365),
    });
    expect(v).toBeGreaterThan(0.35);
    expect(v).toBeLessThan(0.40);
  });

  it("verified_at 缺 fallback createdAt", () => {
    const v = computeFreshness({
      volatility: "fast",
      verifiedAt: null,
      validUntil: null,
      createdAt: dateAgo(30),
    });
    // exp(-30/90) ≈ 0.716
    expect(v).toBeGreaterThan(0.7);
    expect(v).toBeLessThan(0.73);
  });

  it("metadata.forced_outdated_at 强制 ≤ 0.3", () => {
    const v = computeFreshness({
      volatility: "stable",
      verifiedAt: new Date(),
      validUntil: null,
      createdAt: new Date(),
      metadata: { forced_outdated_at: new Date().toISOString() },
    });
    expect(v).toBeLessThanOrEqual(0.3);
  });
});

describe("freshnessLabel", () => {
  it("≥ 0.7 → fresh", () => {
    expect(freshnessLabel(0.7)).toBe("fresh");
    expect(freshnessLabel(0.85)).toBe("fresh");
    expect(freshnessLabel(1.0)).toBe("fresh");
  });

  it("0.3 - 0.7 → stale_warning", () => {
    expect(freshnessLabel(0.3)).toBe("stale_warning");
    expect(freshnessLabel(0.5)).toBe("stale_warning");
    expect(freshnessLabel(0.69)).toBe("stale_warning");
  });

  it("< 0.3 → outdated", () => {
    expect(freshnessLabel(0.0)).toBe("outdated");
    expect(freshnessLabel(0.29)).toBe("outdated");
  });
});
