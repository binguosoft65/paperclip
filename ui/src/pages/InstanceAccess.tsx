import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, ShieldCheck } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";

export function InstanceAccess() {
  const { t } = useTranslation("common");
  const { companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setBreadcrumbs([
      { label: t("instanceSettings.breadcrumbSettings"), href: "/instance/settings/general" },
      { label: t("instanceAccess.breadcrumbAccess") },
    ]);
  }, [setBreadcrumbs]);

  const usersQuery = useQuery({
    queryKey: queryKeys.access.adminUsers(search),
    queryFn: () => accessApi.searchAdminUsers(search),
  });

  // 从搜索结果中匹配当前选中的用户对象，用于展示用户详情。
  const selectedUser = useMemo(
    () => usersQuery.data?.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, usersQuery.data],
  );

  // 查询选中用户在所有公司中的访问权限。
  // enabled: !!selectedUserId 确保了未选择用户时不会发起无效请求。
  const userAccessQuery = useQuery({
    queryKey: queryKeys.access.userCompanyAccess(selectedUserId ?? ""),
    queryFn: () => accessApi.getUserCompanyAccess(selectedUserId!),
    enabled: !!selectedUserId,
  });

  // 默认选中搜索结果中的第一个用户，减少用户操作步骤。
  // 当 selectedUserId 已被清空但搜索结果不为空时自动回填第一个用户 ID。
  useEffect(() => {
    if (!selectedUserId && usersQuery.data?.[0]) {
      setSelectedUserId(usersQuery.data[0].id);
    }
  }, [selectedUserId, usersQuery.data]);

  // 当选中的用户发生变更时，同步更新已选公司集合（仅 active 状态的成员关系），
  // 确保未保存的本地修改不会遗留在旧用户的数据上。
  useEffect(() => {
    if (!userAccessQuery.data) return;
    setSelectedCompanyIds(
      new Set(
        userAccessQuery.data.companyAccess
          .filter((membership) => membership.status === "active")
          .map((membership) => membership.companyId),
      ),
    );
  }, [userAccessQuery.data]);

  // 批量更新用户对公司（Company）的访问权限。
  // selectedCompanyIds 集合表示用户应有权限的公司 ID 集合，
  // 后端会据此自动增删对应的成员关系记录。这是一个全量替换而非增量更新操作。
  const updateCompanyAccessMutation = useMutation({
    mutationFn: () => accessApi.setUserCompanyAccess(selectedUserId!, [...selectedCompanyIds]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(selectedUserId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      pushToast({ title: t("instanceAccess.toast.companyAccessUpdated"), tone: "success" });
    },
  });

  // 实例级管理员（Instance Admin）的授予与撤销。
  // Instance Admin 拥有全局管理权限（访问所有公司的设置和配置），
  // 因此操作需谨慎，UI 中通过明确的"提升/移除"按钮区分两种操作意图。
  const setAdminMutation = useMutation({
    mutationFn: async (makeAdmin: boolean) => {
      if (!selectedUserId) throw new Error("No user selected");
      if (makeAdmin) return accessApi.promoteInstanceAdmin(selectedUserId);
      return accessApi.demoteInstanceAdmin(selectedUserId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      if (selectedUserId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(selectedUserId) });
      }
      pushToast({ title: t("instanceAccess.toast.instanceRoleUpdated"), tone: "success" });
    },
  });

  if (usersQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("instanceAccess.loadingUsers")}</div>;
  }

  if (usersQuery.error) {
    const message =
      usersQuery.error instanceof ApiError && usersQuery.error.status === 403
        ? t("instanceAccess.forbidden")
        : usersQuery.error instanceof Error
          ? usersQuery.error.message
          : t("instanceAccess.failedToLoad");
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("instanceAccess.title")}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("instanceAccess.description")}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section className="space-y-4 rounded-xl border border-border bg-card p-4">
          <label className="block space-y-2 text-sm">
            <span className="font-medium">{t("instanceAccess.searchUsers")}</span>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("placeholder.searchByNameOrEmail")}
            />
          </label>
          <div className="space-y-2">
            {(usersQuery.data ?? []).map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelectedUserId(user.id)}
                className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                  user.id === selectedUserId
                    ? "border-foreground bg-accent"
                    : "border-border hover:bg-accent/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{user.name || user.email || user.id}</div>
                    <div className="truncate text-sm text-muted-foreground">{user.email || user.id}</div>
                  </div>
                  {user.isInstanceAdmin ? (
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  ) : null}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {t("instanceAccess.activeMemberships", { count: user.activeCompanyMembershipCount })}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-border bg-card p-5">
          {!selectedUserId ? (
            <div className="text-sm text-muted-foreground">{t("instanceAccess.selectUser")}</div>
          ) : userAccessQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">{t("instanceAccess.loadingUserAccess")}</div>
          ) : userAccessQuery.error ? (
            <div className="text-sm text-destructive">
              {userAccessQuery.error instanceof Error ? userAccessQuery.error.message : t("instanceAccess.failedToLoadAccess")}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-semibold">
                    {selectedUser?.name || selectedUser?.email || selectedUserId}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {selectedUser?.email || selectedUserId}
                  </div>
                </div>
                <Button
                  variant={selectedUser?.isInstanceAdmin ? "outline" : "default"}
                  onClick={() => setAdminMutation.mutate(!(selectedUser?.isInstanceAdmin ?? false))}
                  disabled={setAdminMutation.isPending}
                >
                  {selectedUser?.isInstanceAdmin ? t("instanceAccess.removeInstanceAdmin") : t("instanceAccess.promoteToInstanceAdmin")}
                </Button>
              </div>

              <div className="space-y-3">
                <div>
                  <h2 className="text-sm font-semibold">{t("instanceAccess.companyAccess")}</h2>
                  <p className="text-sm text-muted-foreground">
                    {t("instanceAccess.companyAccessDesc")}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {companies.map((company) => (
                    <label
                      key={company.id}
                      className="flex items-start gap-3 rounded-lg border border-border px-3 py-3"
                    >
                      <Checkbox
                        checked={selectedCompanyIds.has(company.id)}
                        onCheckedChange={(checked) => {
                          setSelectedCompanyIds((current) => {
                            const next = new Set(current);
                            if (checked) next.add(company.id);
                            else next.delete(company.id);
                            return next;
                          });
                        }}
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">{company.name}</span>
                        <span className="block text-xs text-muted-foreground">{company.issuePrefix}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={() => updateCompanyAccessMutation.mutate()}
                    disabled={updateCompanyAccessMutation.isPending}
                  >
                    {updateCompanyAccessMutation.isPending ? t("instanceAccess.saving") : t("instanceAccess.saveCompanyAccess")}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <h2 className="text-sm font-semibold">{t("instanceAccess.currentMemberships")}</h2>
                <div className="space-y-2">
                  {(userAccessQuery.data?.companyAccess ?? []).map((membership) => (
                    <div
                      key={membership.id}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <div>
                        <div className="font-medium">{membership.companyName || membership.companyId}</div>
                        <div className="text-muted-foreground">
                          {(membership.membershipRole || t("instanceAccess.roleUnset"))} • {membership.status}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(membership.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
