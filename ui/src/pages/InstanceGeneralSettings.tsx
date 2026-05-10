import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatchInstanceGeneralSettings, BackupRetentionPolicy } from "@paperclipai/shared";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
} from "@paperclipai/shared";
import { LogOut, SlidersHorizontal } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { ModeBadge } from "@/components/access/ModeBadge";
import { Button } from "../components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { Trans, useTranslation } from "react-i18next";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const { t } = useTranslation("settings");

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t('general.signOutFailed'));
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: t('breadcrumb.instanceSettings') },
      { label: t('breadcrumb.general') },
    ]);
  }, [setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t('general.updateGeneralError'));
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t('general.loading')}</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : t('general.error')}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";
  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t('general.title')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('general.description')}
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{t('general.deploymentAndAuth')}</h2>
            <ModeBadge
              deploymentMode={healthQuery.data?.deploymentMode}
              deploymentExposure={healthQuery.data?.deploymentExposure}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? t('general.localTrustedDesc')
              : healthQuery.data?.deploymentExposure === "public"
                ? t('general.authenticatedPublicDesc')
                : t('general.authenticatedPrivateDesc')}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label={t('general.authReadiness')}
              value={healthQuery.data?.authReady ? t('general.ready') : t('general.notReady')}
            />
            <StatusBox
              label={t('general.bootstrapStatus')}
              value={healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? t('general.setupRequired') : t('general.ready')}
            />
            <StatusBox
              label={t('general.bootstrapInvite')}
              value={healthQuery.data?.bootstrapInviteActive ? t('general.active') : t('general.none')}
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t('general.censorUsernameTitle')}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('general.censorUsernameDesc')}
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending}
            aria-label={t('general.toggleCensorAria')}
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t('general.keyboardShortcutsTitle')}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('general.keyboardShortcutsDesc')}
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending}
            aria-label={t('general.toggleKeyboardAria')}
          />
        </div>
      </section>

      {/* 数据库备份保留策略配置区。
          保留策略分为日备、周备、月备三个层级，分别对应不同的保留时长。
          设计权衡：预设值而非自由输入，是为了避免管理员设置不合理值导致磁盘爆满
          或数据过早被清理；同时降低输入校验的复杂度。 */}
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t('general.backupRetentionTitle')}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('general.backupRetentionDesc')}
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('general.daily')}</h3>
            <div className="flex flex-wrap gap-2">
              {DAILY_RETENTION_PRESETS.map((days) => {
                const active = backupRetention.dailyDays === days;
                return (
                  <button
                    key={days}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, dailyDays: days },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{t('general.days', { count: days })}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('general.weekly')}</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = t('general.weeks', { count: weeks });
                return (
                  <button
                    key={weeks}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, weeklyWeeks: weeks },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('general.monthly')}</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = t('general.months', { count: months });
                return (
                  <button
                    key={months}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, monthlyMonths: months },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* 用户反馈数据共享偏好设置。
           默认为"prompt"（每次询问），管理员可统一设为"allowed"（始终允许）
           或"not_allowed"（禁止）。这是隐私合规（如 GDPR）要求的用户控制机制，
           所有团队成员的新反馈会话将继承此实例级默认值。 */}
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t('general.feedbackTitle')}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('general.feedbackDesc')}
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {t('general.readTerms')}
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              {t('general.feedbackPrompt')}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: t('general.alwaysAllow'),
                description: t('general.alwaysAllowDesc'),
              },
              {
                value: "not_allowed",
                label: t('general.dontAllow'),
                description: t('general.dontAllowDesc'),
              },
            ].map((option) => {
              const active = feedbackDataSharingPreference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={updateGeneralMutation.isPending}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border bg-background hover:bg-accent/50",
                  )}
                  onClick={() =>
                    updateGeneralMutation.mutate({
                      feedbackDataSharingPreference: option.value as
                        | "allowed"
                        | "not_allowed",
                    })
                  }
                >
                  <div className="text-sm font-medium">{option.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            <Trans i18nKey="settings:general.feedbackResetTip" components={{ 1: <code />, 3: <code />, 5: <code />, 7: <code /> }} />
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t('general.language')}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('general.languageDesc')}
            </p>
          </div>
          <LanguageSwitcher />
        </div>
      </section>

      {/* 退出登录入口。虽然放在通用设置页面中，但该操作影响的是当前用户会话，
           而非全局设置。放置于此是为了方便管理员在一个统一的管理界面完成所有操作。 */}
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{t('general.signOutTitle')}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('general.signOutDesc')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? t('general.signingOut') : t('general.signOut')}
          </Button>
        </div>
      </section>
    </div>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-medium">{value}</div>
    </div>
  );
}
