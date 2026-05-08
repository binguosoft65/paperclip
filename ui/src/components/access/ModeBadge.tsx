import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";

export function ModeBadge({
  deploymentMode,
  deploymentExposure,
}: {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
}) {
  const { t } = useTranslation("common");
  if (!deploymentMode) return null;

  const label =
    deploymentMode === "local_trusted"
      ? t("modeBadge.localTrusted")
      : t("modeBadge.authenticated", { exposure: deploymentExposure ?? "private" });

  return <Badge variant="outline">{label}</Badge>;
}
