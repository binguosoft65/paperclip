import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { useTranslation } from "react-i18next";

/**
 * CLI 认证页面 —— 用户在浏览器中审批 CLI 工具认证挑战。
 *
 * 工作流程：
 * 1. CLI 发起挑战，生成 challengeId 和 token
 * 2. 用户打开此页面（URL 包含 challengeId 和 token）
 * 3. 页面加载挑战详情并检查登录状态
 * 4. 已登录用户可以批准或取消挑战
 * 5. 批准后挑战状态变为 "approved"，CLI 侧检测到后完成认证
 * 6. 未登录用户被引导到登录页，登录后返回此页面继续审批
 *
 * 状态机：pending -> approved（用户批准）/ cancelled（用户取消）/ expired（超时）
 */
export function CliAuthPage() {
  const { t } = useTranslation("common");
  const queryClient = useQueryClient();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const challengeId = (params.id ?? "").trim();
  const token = (searchParams.get("token") ?? "").trim();
  // 构建当前 URL 用于登录后的回跳（next 参数）
  const currentPath = useMemo(
    () => `/cli-auth/${encodeURIComponent(challengeId)}${token ? `?token=${encodeURIComponent(token)}` : ""}`,
    [challengeId, token],
  );

  // 同时检查登录 session 和挑战详情，需要两者都就绪才能展示审批界面
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const challengeQuery = useQuery({
    queryKey: ["cli-auth-challenge", challengeId, token],
    queryFn: () => accessApi.getCliAuthChallenge(challengeId, token),
    // 只有 challengeId 和 token 都存在时才发起查询
    enabled: challengeId.length > 0 && token.length > 0,
    retry: false,
  });

  const approveMutation = useMutation({
    mutationFn: () => accessApi.approveCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await challengeQuery.refetch();
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => accessApi.cancelCliAuthChallenge(challengeId, token),
    onSuccess: async () => {
      await challengeQuery.refetch();
    },
  });

  // 缺少 challengeId 或 token，URL 格式无效
  if (!challengeId || !token) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("cliAuth.invalidUrl")}</div>;
  }

  // 任一查询还在加载中时不展示内容
  if (sessionQuery.isLoading || challengeQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("cliAuth.loadingChallenge")}</div>;
  }

  // 挑战查询出错（如已删除、token 无效）
  if (challengeQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">{t("cliAuth.challengeUnavailable")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {challengeQuery.error instanceof Error ? challengeQuery.error.message : t("cliAuth.challengeInvalidOrExpired")}
          </p>
        </div>
      </div>
    );
  }

  const challenge = challengeQuery.data;
  if (!challenge) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("cliAuth.challengeUnavailable")}</div>;
  }

  // 根据挑战状态展示不同 UI：approved / cancelled / expired / pending
  if (challenge.status === "approved") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">{t("cliAuth.approved")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("cliAuth.approvedDesc")}
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            {t("cliAuth.command", { command: challenge.command })}
          </p>
        </div>
      </div>
    );
  }

  if (challenge.status === "cancelled" || challenge.status === "expired") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">
            {challenge.status === "expired" ? t("cliAuth.expired") : t("cliAuth.cancelled")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("cliAuth.expiredCancelledDesc")}
          </p>
        </div>
      </div>
    );
  }

  if (challenge.requiresSignIn || !sessionQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">{t("cliAuth.signInRequired")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("cliAuth.signInDesc")}
          </p>
          <Button asChild className="mt-4">
            <Link to={`/auth?next=${encodeURIComponent(currentPath)}`}>{t("cliAuth.signInAction")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{t("cliAuth.approveAccess")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("cliAuth.approveAccessDesc")}
        </p>

        <div className="mt-5 space-y-3 text-sm">
          <div>
            <div className="text-muted-foreground">{t("cliAuth.commandLabel")}</div>
            <div className="font-mono text-foreground">{challenge.command}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("cliAuth.clientLabel")}</div>
            <div className="text-foreground">{challenge.clientName ?? "paperclipai cli"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("cliAuth.requestedAccessLabel")}</div>
            <div className="text-foreground">
              {challenge.requestedAccess === "instance_admin_required" ? t("cliAuth.accessInstanceAdmin") : t("cliAuth.accessBoard")}
            </div>
          </div>
          {challenge.requestedCompanyName && (
            <div>
              <div className="text-muted-foreground">{t("cliAuth.requestedCompanyLabel")}</div>
              <div className="text-foreground">{challenge.requestedCompanyName}</div>
            </div>
          )}
        </div>

        {(approveMutation.error || cancelMutation.error) && (
          <p className="mt-4 text-sm text-destructive">
            {(approveMutation.error ?? cancelMutation.error) instanceof Error
              ? ((approveMutation.error ?? cancelMutation.error) as Error).message
              : t("cliAuth.failedUpdate")}
          </p>
        )}

        {!challenge.canApprove && (
          <p className="mt-4 text-sm text-destructive">
            {t("cliAuth.cannotApprove")}
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={!challenge.canApprove || approveMutation.isPending || cancelMutation.isPending}
          >
            {approveMutation.isPending ? t("cliAuth.approving") : t("cliAuth.approveCliAccess")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => cancelMutation.mutate()}
            disabled={approveMutation.isPending || cancelMutation.isPending}
          >
            {cancelMutation.isPending ? t("cliAuth.cancelling") : t("cliAuth.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
