import { describe, it, expect } from "vitest";
import common_en from "../i18n/resources/en/common.json";
import status_en from "../i18n/resources/en/status.json";
import activity_en from "../i18n/resources/en/activity.json";
import time_en from "../i18n/resources/en/time.json";
import auth_en from "../i18n/resources/en/auth.json";
import settings_en from "../i18n/resources/en/settings.json";
import issues_en from "../i18n/resources/en/issues.json";
import keyboard_en from "../i18n/resources/en/keyboard.json";

import common_zh from "../i18n/resources/zh-CN/common.json";
import status_zh from "../i18n/resources/zh-CN/status.json";
import activity_zh from "../i18n/resources/zh-CN/activity.json";
import time_zh from "../i18n/resources/zh-CN/time.json";
import auth_zh from "../i18n/resources/zh-CN/auth.json";
import settings_zh from "../i18n/resources/zh-CN/settings.json";
import issues_zh from "../i18n/resources/zh-CN/issues.json";
import keyboard_zh from "../i18n/resources/zh-CN/keyboard.json";

function collectKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...collectKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

const namespaces = [
  { ns: "common", en: common_en, zh: common_zh },
  { ns: "status", en: status_en, zh: status_zh },
  { ns: "activity", en: activity_en, zh: activity_zh },
  { ns: "time", en: time_en, zh: time_zh },
  { ns: "auth", en: auth_en, zh: auth_zh },
  { ns: "settings", en: settings_en, zh: settings_zh },
  { ns: "issues", en: issues_en, zh: issues_zh },
  { ns: "keyboard", en: keyboard_en, zh: keyboard_zh },
];

describe("Translation key symmetry", () => {
  for (const { ns, en, zh } of namespaces) {
    it(`${ns}: en and zh-CN have matching keys`, () => {
      const enKeys = collectKeys(en).sort();
      const zhKeys = collectKeys(zh).sort();
      const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
      const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
      expect(missingInZh).toEqual([]);
      expect(missingInEn).toEqual([]);
    });
  }
});
