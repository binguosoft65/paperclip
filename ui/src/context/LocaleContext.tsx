import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setLocale, LOCALE_STORAGE_KEY } from "../i18n";
import type { SupportedLocale } from "../i18n";

interface LocaleContextValue {
  locale: SupportedLocale;
  setLocaleAction: (locale: SupportedLocale) => void;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

function resolveLocale(): SupportedLocale {
  if (typeof window === "undefined") return "en";
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "zh-CN") return stored;
  } catch { /* ignore */ }
  const browserLang = navigator.language;
  if (browserLang === "zh-CN" || browserLang.startsWith("zh")) return "zh-CN";
  return "en";
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(resolveLocale);

  const setLocaleAction = useCallback((nextLocale: SupportedLocale) => {
    setLocaleState(nextLocale);
  }, []);

  useEffect(() => {
    setLocale(locale);
  }, [locale]);

  const value = useMemo(
    () => ({ locale, setLocaleAction }),
    [locale, setLocaleAction],
  );

  return (
    <LocaleContext.Provider value={value}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error("useLocale must be used within LocaleProvider");
  }
  return context;
}
