import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { useTranslation } from "react-i18next";

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation("status");
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {t(`issueStatus.${status}`, status.replace(/_/g, " "))}
    </span>
  );
}
