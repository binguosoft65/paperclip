import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import common_en from "./resources/en/common.json";
import status_en from "./resources/en/status.json";
import activity_en from "./resources/en/activity.json";
import time_en from "./resources/en/time.json";
import auth_en from "./resources/en/auth.json";
import settings_en from "./resources/en/settings.json";
import issues_en from "./resources/en/issues.json";
import keyboard_en from "./resources/en/keyboard.json";
import company_en from "./resources/en/company.json";

import common_zhCN from "./resources/zh-CN/common.json";
import status_zhCN from "./resources/zh-CN/status.json";
import activity_zhCN from "./resources/zh-CN/activity.json";
import time_zhCN from "./resources/zh-CN/time.json";
import auth_zhCN from "./resources/zh-CN/auth.json";
import settings_zhCN from "./resources/zh-CN/settings.json";
import issues_zhCN from "./resources/zh-CN/issues.json";
import keyboard_zhCN from "./resources/zh-CN/keyboard.json";
import company_zhCN from "./resources/zh-CN/company.json";

const LOCALE_STORAGE_KEY = "paperclip.locale";

i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    initAsync: false,
    resources: {
      en: { common: common_en, status: status_en, activity: activity_en, time: time_en, auth: auth_en, settings: settings_en, issues: issues_en, keyboard: keyboard_en, company: company_en },
      "zh-CN": { common: common_zhCN, status: status_zhCN, activity: activity_zhCN, time: time_zhCN, auth: auth_zhCN, settings: settings_zhCN, issues: issues_zhCN, keyboard: keyboard_zhCN, company: company_zhCN },
    },
    fallbackLng: "en",
    defaultNS: "common",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      convertDetectedLanguage: (lng: string) =>
        lng.startsWith("zh") ? "zh-CN" : lng,
    },
  });

export { useTranslation } from "react-i18next";

export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

export function getLocale(): string {
  return i18next.language ?? "en";
}

export function setLocale(locale: string): void {
  i18next.changeLanguage(locale);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch { /* ignore */ }
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export const supportedLocales = ["en", "zh-CN"] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export function isChineseLocale(locale: string): boolean {
  return locale === "zh-CN" || locale.startsWith("zh");
}

export { LOCALE_STORAGE_KEY };
export default i18next;
