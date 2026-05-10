import { useLocale } from "../context/LocaleContext";
import { supportedLocales, type SupportedLocale } from "../i18n";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const localeLabels: Record<SupportedLocale, string> = {
  en: "English",
  "zh-CN": "中文",
};

export function LanguageSwitcher() {
  const { locale, setLocaleAction } = useLocale();

  return (
    <Select value={locale} onValueChange={(value) => setLocaleAction(value as SupportedLocale)}>
      <SelectTrigger className="w-[160px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {supportedLocales.map((loc) => (
          <SelectItem key={loc} value={loc}>
            {localeLabels[loc]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
