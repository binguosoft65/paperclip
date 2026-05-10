import { useEffect, useMemo } from "react";
import { Link, Navigate, useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import {
  PluginSlotMount,
  resolveRouteSidebarSlot,
  type ResolvedPluginSlot,
} from "@/plugins/slots";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { NotFoundPage } from "./NotFound";

/**
 * Company-context plugin page. Renders a plugin's `page` slot at
 * `/:companyPrefix/plugins/:pluginId` when the plugin declares a page slot
 * and is enabled for that company.
 *
 * ── 路由解析逻辑 ──
 * 支持两种 URL 模式：
 * 1. /:companyPrefix/plugins/:pluginId — 通过 pluginId 直接匹配。
 * 2. /:companyPrefix/plugins/* — 通过 pluginRoutePath 通配符匹配。
 *
 * ── 为什么需要 routeSidebar ──
 * 当插件提供了 routeSidebar 插槽时，侧边栏提供返回按钮（back affordance），
 * 顶栏只需显示页面标题。否则，顶栏显示面包屑导航（Plugins > 插件名）。
 *
 * @see doc/plugins/PLUGIN_SPEC.md §19.2 — Company-Context Routes
 * @see doc/plugins/PLUGIN_SPEC.md §24.4 — Company-Context Plugin Page
 */
export function PluginPage() {
  const { t } = useTranslation("common");
  const params = useParams<{
    companyPrefix?: string;
    pluginId?: string;
    pluginRoutePath?: string;
    "*": string | undefined;
  }>();
  const { companyPrefix: routeCompanyPrefix, pluginId, pluginRoutePath } = params;
  const pluginRouteSplat = params["*"];
  const { companies, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const routeCompany = useMemo(() => {
    if (!routeCompanyPrefix) return null;
    const requested = routeCompanyPrefix.toUpperCase();
    return companies.find((c) => c.issuePrefix.toUpperCase() === requested) ?? null;
  }, [companies, routeCompanyPrefix]);
  const hasInvalidCompanyPrefix = Boolean(routeCompanyPrefix) && !routeCompany;

  const resolvedCompanyId = useMemo(() => {
    if (routeCompany) return routeCompany.id;
    if (routeCompanyPrefix) return null;
    return selectedCompanyId ?? null;
  }, [routeCompany, routeCompanyPrefix, selectedCompanyId]);

  const companyPrefix = useMemo(
    () => (resolvedCompanyId ? companies.find((c) => c.id === resolvedCompanyId)?.issuePrefix ?? null : null),
    [companies, resolvedCompanyId],
  );

  const { data: contributions } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: !!resolvedCompanyId && (!!pluginId || !!pluginRoutePath),
  });

  const pageSlot = useMemo(() => {
    if (!contributions) return null;
    if (pluginId) {
      const contribution = contributions.find((c) => c.pluginId === pluginId);
      if (!contribution) return null;
      const slot = contribution.slots.find((s) => s.type === "page");
      if (!slot) return null;
      return {
        ...slot,
        pluginId: contribution.pluginId,
        pluginKey: contribution.pluginKey,
        pluginDisplayName: contribution.displayName,
        pluginVersion: contribution.version,
      };
    }
    if (!pluginRoutePath) return null;
    const matches = contributions.flatMap((contribution) => {
      const slot = contribution.slots.find((entry) => entry.type === "page" && entry.routePath === pluginRoutePath);
      if (!slot) return [];
      return [{
        ...slot,
        pluginId: contribution.pluginId,
        pluginKey: contribution.pluginKey,
        pluginDisplayName: contribution.displayName,
        pluginVersion: contribution.version,
      }];
    });
    if (matches.length !== 1) return null;
    return matches[0] ?? null;
  }, [pluginId, pluginRoutePath, contributions]);

  const context = useMemo(
    () => ({
      companyId: resolvedCompanyId ?? null,
      companyPrefix,
    }),
    [resolvedCompanyId, companyPrefix],
  );

  // When the active route has a routeSidebar slot, the sidebar provides the
  // back affordance, but the top bar still needs a route-specific title.
  const routeSidebarActive = useMemo(() => {
    if (!pluginRoutePath || !contributions) return false;
    const flattened: ResolvedPluginSlot[] = contributions.flatMap((contribution) =>
      contribution.slots.map((slot) => ({
        ...slot,
        pluginId: contribution.pluginId,
        pluginKey: contribution.pluginKey,
        pluginDisplayName: contribution.displayName,
        pluginVersion: contribution.version,
      })),
    );
    return resolveRouteSidebarSlot(flattened, pluginRoutePath) !== null;
  }, [contributions, pluginRoutePath]);

  useEffect(() => {
    if (!pageSlot) return;
    if (routeSidebarActive) {
      setBreadcrumbs([{ label: resolveRouteSidebarPageTitle(pageSlot, pluginRouteSplat) }]);
      return;
    }
    setBreadcrumbs([
      { label: t("pluginPage.breadcrumbPlugins"), href: "/instance/settings/plugins" },
      { label: pageSlot.pluginDisplayName },
    ]);
  }, [pageSlot, pluginRouteSplat, setBreadcrumbs, routeSidebarActive]);

  if (!resolvedCompanyId) {
    if (hasInvalidCompanyPrefix) {
      return <NotFoundPage scope="invalid_company_prefix" requestedPrefix={routeCompanyPrefix} />;
    }
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("pluginPage.selectCompany")}</p>
      </div>
    );
  }

  if (!contributions) {
    return <div className="text-sm text-muted-foreground">{t("pluginPage.loading")}</div>;
  }

  if (!pluginId && pluginRoutePath) {
    const duplicateMatches = contributions.filter((contribution) =>
      contribution.slots.some((slot) => slot.type === "page" && slot.routePath === pluginRoutePath),
    );
    if (duplicateMatches.length > 1) {
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <Trans
            i18nKey="pluginPage.multiplePlugins"
            values={{ routePath: pluginRoutePath }}
            components={{ 3: <code /> }}
          />
        </div>
      );
    }
  }

  if (!pageSlot) {
    if (pluginRoutePath) {
      return <NotFoundPage scope="board" />;
    }
    // No page slot: redirect to plugin settings where plugin info is always shown
    const settingsPath = pluginId ? `/instance/settings/plugins/${pluginId}` : "/instance/settings/plugins";
    return <Navigate to={settingsPath} replace />;
  }

  return (
    <div className="space-y-4">
      {!routeSidebarActive && (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to={companyPrefix ? `/${companyPrefix}/dashboard` : "/dashboard"}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              {t("pluginPage.back")}
            </Link>
          </Button>
        </div>
      )}
      <PluginSlotMount
        slot={pageSlot}
        context={context}
        className="min-h-[200px]"
        missingBehavior="placeholder"
      />
    </div>
  );
}

function resolveRouteSidebarPageTitle(pageSlot: ResolvedPluginSlot, routeSplat: string | undefined): string {
  const title = titleFromRouteSplat(routeSplat);
  return title ?? pageSlot.displayName ?? pageSlot.pluginDisplayName;
}

function titleFromRouteSplat(routeSplat: string | undefined): string | null {
  const segments = (routeSplat ?? "")
    .split("/")
    .filter(Boolean)
    .map(decodeRouteSegment);
  if (segments.length === 0) return null;

  if (segments[0] === "page" && segments.length > 1) {
    return titleFromPath(segments.slice(1).join("/"), { preserveCase: true });
  }

  return titleFromPath(segments[0] ?? null);
}

function titleFromPath(path: string | null | undefined, options: { preserveCase?: boolean } = {}): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const basename = trimmed.split("/").filter(Boolean).at(-1) ?? trimmed;
  const withoutNamespace = basename.split("::").at(-1) ?? basename;
  const withoutExtension = withoutNamespace.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension.replace(/[-_]+/g, " ").trim();
  if (!normalized) return null;
  if (options.preserveCase) return normalized;
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function decodeRouteSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
