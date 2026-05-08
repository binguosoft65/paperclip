import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import type { AgentAdapterType, JoinRequest } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { useCompany } from "@/context/CompanyContext";
import { Link, useNavigate, useParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { companiesApi } from "../api/companies";
import { healthApi } from "../api/health";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { clearPendingInviteToken, rememberPendingInviteToken } from "../lib/invite-memory";
import { queryKeys } from "../lib/queryKeys";
import { formatDate } from "../lib/utils";
import { useTranslation } from "react-i18next";

type AuthMode = "sign_in" | "sign_up";
type AuthFeedback = { tone: "error" | "info"; message: string };

const joinAdapterOptions: AgentAdapterType[] = [...AGENT_ADAPTER_TYPES];
const ENABLED_INVITE_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
]);

function readNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

const fieldClassName =
  "w-full border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500";
const panelClassName = "border border-zinc-800 bg-zinc-950/95 p-6";
const modeButtonBaseClassName =
  "flex-1 border px-3 py-2 text-sm transition-colors";

function formatHumanRole(role: string | null | undefined) {
  if (!role) return null;
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function getAuthErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}

function getAuthErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return null;
  const message = error.message.trim();
  return message.length > 0 ? message : null;
}

function mapInviteAuthFeedback(
  error: unknown,
  authMode: AuthMode,
  email: string,
): AuthFeedback {
  const code = getAuthErrorCode(error);
  const message = getAuthErrorMessage(error);
  const emailLabel = email.trim().length > 0 ? email.trim() : "that email";

  if (code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
    return {
      tone: "info",
      message: `An account already exists for ${emailLabel}. Sign in below to continue with this invite.`,
    };
  }

  if (code === "INVALID_EMAIL_OR_PASSWORD") {
    return {
      tone: "error",
      message:
        "That email and password did not match an existing Paperclip account. Check both fields, or create an account first if you are new here.",
    };
  }

  if (authMode === "sign_in" && message === "Request failed: 401") {
    return {
      tone: "error",
      message:
        "That email and password did not match an existing Paperclip account. Check both fields, or create an account first if you are new here.",
    };
  }

  if (authMode === "sign_up" && message === "Request failed: 422") {
    return {
      tone: "info",
      message: `An account may already exist for ${emailLabel}. Try signing in instead.`,
    };
  }

  return {
    tone: "error",
    message: message ?? "Authentication failed",
  };
}

function isBootstrapAcceptancePayload(payload: unknown) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "bootstrapAccepted" in (payload as Record<string, unknown>),
  );
}

function isApprovedHumanJoinPayload(payload: unknown, showsAgentForm: boolean) {
  if (!payload || typeof payload !== "object" || showsAgentForm) return false;
  const status = (payload as { status?: unknown }).status;
  return status === "approved";
}

type AwaitingJoinApprovalPanelProps = {
  companyDisplayName: string;
  companyLogoUrl: string | null;
  companyBrandColor: string | null;
  invitedByUserName: string | null;
  claimSecret?: string | null;
  claimApiKeyPath?: string | null;
  onboardingTextUrl?: string | null;
};

function InviteCompanyLogo({
  companyDisplayName,
  companyLogoUrl,
  companyBrandColor,
  className,
}: {
  companyDisplayName: string;
  companyLogoUrl: string | null;
  companyBrandColor: string | null;
  className?: string;
}) {
  return (
    <CompanyPatternIcon
      companyName={companyDisplayName}
      logoUrl={companyLogoUrl}
      brandColor={companyBrandColor}
      logoFit="contain"
      className={className}
    />
  );
}

function AwaitingJoinApprovalPanel({
  companyDisplayName,
  companyLogoUrl,
  companyBrandColor,
  invitedByUserName,
  claimSecret = null,
  claimApiKeyPath = null,
  onboardingTextUrl = null,
}: AwaitingJoinApprovalPanelProps) {
  const { t } = useTranslation("common");
  const approvalUrl = `${window.location.origin}/company/settings/access`;
  const approverLabel = invitedByUserName ?? t("invite.aCompanyAdmin");

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-md border border-zinc-800 bg-zinc-950 p-6" data-testid="invite-pending-approval">
        <div className="flex items-center gap-3">
          <InviteCompanyLogo
            companyDisplayName={companyDisplayName}
            companyLogoUrl={companyLogoUrl}
            companyBrandColor={companyBrandColor}
            className="h-12 w-12 border border-zinc-800 rounded-none"
          />
          <h1 className="text-lg font-semibold">{t("invite.requestToJoin", { company: companyDisplayName })}</h1>
        </div>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-zinc-400">
            {t("invite.awaitingApproval", { approver: approverLabel })}
          </p>
          <div className="border border-zinc-800 p-3">
            <p className="text-xs text-zinc-500 mb-1">{t("invite.approvalPage")}</p>
            <a
              href={approvalUrl}
              className="text-sm text-zinc-200 underline underline-offset-2 hover:text-zinc-100"
            >
              {t("invite.companySettingsAccess")}
            </a>
          </div>
          <p className="text-sm text-zinc-400">
            {t("invite.askApprover", { url: approvalUrl })}
          </p>
          <p className="text-xs text-zinc-500">
            {t("invite.refreshAfterApproval")}
          </p>
        </div>
        {claimSecret && claimApiKeyPath ? (
          <div className="mt-4 space-y-1 border border-zinc-800 p-3 text-xs text-zinc-400">
            <div className="text-zinc-200">{t("invite.claimSecret")}</div>
            <div className="font-mono break-all">{claimSecret}</div>
            <div className="font-mono break-all">POST {claimApiKeyPath}</div>
          </div>
        ) : null}
        {onboardingTextUrl ? (
          <div className="mt-4 text-xs text-zinc-400">
            {t("invite.onboarding", { url: onboardingTextUrl })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function InviteLandingPage() {
  const { t } = useTranslation("common");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { setSelectedCompanyId } = useCompany();
  const params = useParams();
  const token = (params.token ?? "").trim();
  const [authMode, setAuthMode] = useState<AuthMode>("sign_up");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agentName, setAgentName] = useState("");
  const [adapterType, setAdapterType] = useState<AgentAdapterType>("claude_local");
  const [capabilities, setCapabilities] = useState("");
  const [result, setResult] = useState<{ kind: "bootstrap" | "join"; payload: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authFeedback, setAuthFeedback] = useState<AuthFeedback | null>(null);
  const [autoAcceptStarted, setAutoAcceptStarted] = useState(false);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const inviteQuery = useQuery({
    queryKey: queryKeys.access.invite(token),
    queryFn: () => accessApi.getInvite(token),
    enabled: token.length > 0,
    retry: false,
  });

  const companiesQuery = useQuery({
    queryKey: queryKeys.companies.all,
    queryFn: () => companiesApi.list(),
    enabled: !!sessionQuery.data && !!inviteQuery.data?.companyId,
    retry: false,
  });

  useEffect(() => {
    if (token) rememberPendingInviteToken(token);
  }, [token]);

  useEffect(() => {
    setAutoAcceptStarted(false);
  }, [token]);

  useEffect(() => {
    if (!companiesQuery.data || !inviteQuery.data?.companyId) return;
    const isMember = companiesQuery.data.some(
      (c) => c.id === inviteQuery.data!.companyId
    );
    if (isMember) {
      clearPendingInviteToken(token);
      navigate("/", { replace: true });
    }
  }, [companiesQuery.data, inviteQuery.data, token, navigate]);

  const invite = inviteQuery.data;
  const isCheckingExistingMembership =
    Boolean(sessionQuery.data) &&
    Boolean(invite?.companyId) &&
    companiesQuery.isLoading;
  const isCurrentMember =
    Boolean(invite?.companyId) &&
    Boolean(
      companiesQuery.data?.some((company) => company.id === invite?.companyId),
    );
  const companyName = invite?.companyName?.trim() || null;
  const companyDisplayName = companyName || t("invite.thisPaperclipCompany");
  const companyLogoUrl = invite?.companyLogoUrl?.trim() || null;
  const companyBrandColor = invite?.companyBrandColor?.trim() || null;
  const invitedByUserName = invite?.invitedByUserName?.trim() || null;
  const inviteMessage = invite?.inviteMessage?.trim() || null;
  const requestedHumanRole = formatHumanRole(invite?.humanRole);
  const inviteJoinRequestStatus = invite?.joinRequestStatus ?? null;
  const inviteJoinRequestType = invite?.joinRequestType ?? null;
  const requiresHumanAccount =
    healthQuery.data?.deploymentMode === "authenticated" &&
    !sessionQuery.data &&
    invite?.allowedJoinTypes !== "agent";
  const showsAgentForm = invite?.inviteType !== "bootstrap_ceo" && invite?.allowedJoinTypes === "agent";
  const shouldAutoAcceptHumanInvite =
    Boolean(sessionQuery.data) &&
    !showsAgentForm &&
    invite?.inviteType !== "bootstrap_ceo" &&
    !inviteJoinRequestStatus &&
    !isCheckingExistingMembership &&
    !isCurrentMember &&
    !result &&
    error === null;
  const sessionLabel =
    sessionQuery.data?.user.name?.trim() ||
    sessionQuery.data?.user.email?.trim() ||
    t("invite.thisAccountFallback");

  const authCanSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (authMode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  const acceptMutation = useMutation({
    mutationFn: async () => {
      if (!invite) throw new Error(t("invite.inviteNotFound"));
      if (isCheckingExistingMembership) {
        throw new Error(t("invite.checkAccessTryAgain"));
      }
      if (isCurrentMember) {
        throw new Error(t("invite.alreadyBelongsToCompany"));
      }
      if (invite.inviteType === "bootstrap_ceo" || invite.allowedJoinTypes !== "agent") {
        return accessApi.acceptInvite(token, { requestType: "human" });
      }
      return accessApi.acceptInvite(token, {
        requestType: "agent",
        agentName: agentName.trim(),
        adapterType,
        capabilities: capabilities.trim() || null,
      });
    },
    onSuccess: async (payload) => {
      setError(null);
      clearPendingInviteToken(token);
      const asBootstrap = isBootstrapAcceptancePayload(payload);
      setResult({ kind: asBootstrap ? "bootstrap" : "join", payload });
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      if (invite?.companyId && isApprovedHumanJoinPayload(payload, showsAgentForm)) {
        setSelectedCompanyId(invite.companyId, { source: "manual" });
        navigate("/", { replace: true });
      }
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : t("invite.failedToAcceptInvite"));
    },
  });

  useEffect(() => {
    if (!shouldAutoAcceptHumanInvite || autoAcceptStarted || acceptMutation.isPending) return;
    setAutoAcceptStarted(true);
    setError(null);
    acceptMutation.mutate();
  }, [acceptMutation, autoAcceptStarted, shouldAutoAcceptHumanInvite]);

  const authMutation = useMutation({
    mutationFn: async () => {
      if (authMode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setAuthFeedback(null);
      rememberPendingInviteToken(token);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      const companies = await queryClient.fetchQuery({
        queryKey: queryKeys.companies.all,
        queryFn: () => companiesApi.list(),
        retry: false,
      });

      if (invite?.companyId && companies.some((company) => company.id === invite.companyId)) {
        clearPendingInviteToken(token);
        setSelectedCompanyId(invite.companyId, { source: "manual" });
        navigate("/", { replace: true });
        return;
      }

      if (!invite || invite.inviteType !== "bootstrap_ceo") {
        return;
      }

      try {
        const payload = await acceptMutation.mutateAsync();
        if (isBootstrapAcceptancePayload(payload)) {
          navigate("/", { replace: true });
        }
      } catch {
        return;
      }
    },
    onError: (err) => {
      const nextFeedback = mapInviteAuthFeedback(err, authMode, email);
      if (getAuthErrorCode(err) === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
        setAuthMode("sign_in");
        setPassword("");
      }
      setAuthFeedback(nextFeedback);
    },
  });

  const joinButtonLabel = useMemo(() => {
    if (!invite) return t("invite.continue");
    if (invite.inviteType === "bootstrap_ceo") return t("invite.acceptInvite");
    if (showsAgentForm) return t("invite.submitRequest");
    return sessionQuery.data ? t("invite.acceptInvite") : t("invite.continue");
  }, [invite, sessionQuery.data, showsAgentForm, t]);

  if (!token) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("invite.invalidToken")}</div>;
  }

  if (inviteQuery.isLoading || healthQuery.isLoading || sessionQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("invite.loadingInvite")}</div>;
  }

  if (isCheckingExistingMembership) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("invite.checkingAccess")}</div>;
  }

  if (inviteQuery.error || !invite) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="border border-border bg-card p-6" data-testid="invite-error">
          <h1 className="text-lg font-semibold">{t("invite.inviteNotAvailable")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("invite.inviteExpiredOrUsed")}
          </p>
        </div>
      </div>
    );
  }

  if (
    inviteJoinRequestStatus === "approved" &&
    inviteJoinRequestType === "human" &&
    isCurrentMember
  ) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("invite.openingCompany")}</div>;
  }

  if (inviteJoinRequestStatus === "pending_approval") {
    return (
      <AwaitingJoinApprovalPanel
        companyDisplayName={companyDisplayName}
        companyLogoUrl={companyLogoUrl}
        companyBrandColor={companyBrandColor}
        invitedByUserName={invitedByUserName}
      />
    );
  }

  if (inviteJoinRequestStatus) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="border border-border bg-card p-6" data-testid="invite-error">
          <h1 className="text-lg font-semibold">{t("invite.inviteNotAvailable")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {inviteJoinRequestStatus === "rejected"
              ? t("invite.rejectedDesc")
              : t("invite.alreadyUsedDesc")}
          </p>
        </div>
      </div>
    );
  }

  if (result?.kind === "bootstrap") {
    return (
      <div className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
        <div className="mx-auto max-w-md border border-zinc-800 bg-zinc-950 p-6">
          <h1 className="text-lg font-semibold">{t("invite.bootstrapComplete")}</h1>
          <div className="mt-4">
            <Button asChild className="rounded-none">
              <Link to="/">{t("invite.openBoard")}</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (result?.kind === "join") {
    const payload = result.payload as JoinRequest & {
      claimSecret?: string;
      claimApiKeyPath?: string;
      onboarding?: Record<string, unknown>;
    };
    const claimSecret = typeof payload.claimSecret === "string" ? payload.claimSecret : null;
    const claimApiKeyPath = typeof payload.claimApiKeyPath === "string" ? payload.claimApiKeyPath : null;
    const onboardingTextUrl = readNestedString(payload.onboarding, ["textInstructions", "url"]);
    const joinedNow = !showsAgentForm && payload.status === "approved";

    return (
      joinedNow ? (
        <div className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
          <div className="mx-auto max-w-md border border-zinc-800 bg-zinc-950 p-6">
            <div className="flex items-center gap-3">
              <InviteCompanyLogo
                companyDisplayName={companyDisplayName}
                companyLogoUrl={companyLogoUrl}
                companyBrandColor={companyBrandColor}
                className="h-12 w-12 border border-zinc-800 rounded-none"
              />
              <h1 className="text-lg font-semibold">{t("invite.youJoined")}</h1>
            </div>
            <div className="mt-4">
              <Button asChild className="w-full rounded-none">
                <Link to="/">{t("invite.openBoard")}</Link>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <AwaitingJoinApprovalPanel
          companyDisplayName={companyDisplayName}
          companyLogoUrl={companyLogoUrl}
          companyBrandColor={companyBrandColor}
          invitedByUserName={invitedByUserName}
          claimSecret={claimSecret}
          claimApiKeyPath={claimApiKeyPath}
          onboardingTextUrl={onboardingTextUrl}
        />
      )
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-12 text-zinc-100">
      <div className="mx-auto max-w-5xl">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <section className={`${panelClassName} space-y-6`}>
            <div className="flex items-start gap-4">
              <InviteCompanyLogo
                companyDisplayName={companyDisplayName}
                companyLogoUrl={companyLogoUrl}
                companyBrandColor={companyBrandColor}
                className="h-16 w-16 rounded-none border border-zinc-800"
              />
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">
                  {t("invite.invitedToJoin")}
                </p>
                <h1 className="mt-2 text-2xl font-semibold">
                  {invite.inviteType === "bootstrap_ceo" ? t("invite.pageTitle") : t("invite.joinTitle", { company: companyDisplayName })}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">
                  {showsAgentForm
                    ? t("invite.agentInviteDesc")
                    : requiresHumanAccount
                      ? t("invite.humanAuthDesc")
                      : t("invite.humanReadyDesc")}
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border border-zinc-800 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">{t("invite.company")}</div>
                <div className="mt-1 text-sm text-zinc-100">{companyDisplayName}</div>
              </div>
              <div className="border border-zinc-800 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">{t("invite.invitedBy")}</div>
                <div className="mt-1 text-sm text-zinc-100">{invitedByUserName ?? t("invite.boardInvitedBy")}</div>
              </div>
              <div className="border border-zinc-800 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">{t("invite.requestedAccess")}</div>
                <div className="mt-1 text-sm text-zinc-100">
                  {showsAgentForm ? t("invite.agentJoinRequest") : requestedHumanRole ?? t("invite.companyAccess")}
                </div>
              </div>
              <div className="border border-zinc-800 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">{t("invite.inviteExpires")}</div>
                <div className="mt-1 text-sm text-zinc-100">{formatDate(invite.expiresAt)}</div>
              </div>
            </div>

            {inviteMessage ? (
              <div className="border border-amber-500/40 bg-amber-500/10 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-amber-200/80">{t("invite.messageFromInviter")}</div>
                <p className="mt-2 text-sm leading-6 text-amber-50">{inviteMessage}</p>
              </div>
            ) : null}

            {sessionQuery.data ? (
              <div className="border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-50">
                {t("invite.signedInAs", { label: sessionLabel })}
              </div>
            ) : null}
          </section>

          <section className={`${panelClassName} h-fit`}>
            {showsAgentForm ? (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">{t("invite.submitAgentDetails")}</h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    {t("invite.agentDetailsDesc", { company: companyDisplayName })}
                  </p>
                </div>
                <label className="block text-sm">
                  <span className="mb-1 block text-zinc-400">{t("invite.agentName")}</span>
                  <input
                    className={fieldClassName}
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-zinc-400">{t("invite.adapterType")}</span>
                  <select
                    className={fieldClassName}
                    value={adapterType}
                    onChange={(event) => setAdapterType(event.target.value as AgentAdapterType)}
                  >
                    {joinAdapterOptions.map((type) => (
                      <option key={type} value={type} disabled={!ENABLED_INVITE_ADAPTERS.has(type)}>
                        {getAdapterLabel(type)}{!ENABLED_INVITE_ADAPTERS.has(type) ? t("invite.adapterComingSoon") : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-zinc-400">{t("invite.capabilities")}</span>
                  <textarea
                    className={fieldClassName}
                    rows={4}
                    value={capabilities}
                    onChange={(event) => setCapabilities(event.target.value)}
                  />
                </label>
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
                <Button
                  className="w-full rounded-none"
                  disabled={acceptMutation.isPending || agentName.trim().length === 0}
                  onClick={() => acceptMutation.mutate()}
                >
                  {acceptMutation.isPending ? t("invite.working") : joinButtonLabel}
                </Button>
              </div>
            ) : requiresHumanAccount ? (
              <div className="space-y-5">
                <div>
                  <h2 className="text-lg font-semibold">
                    {authMode === "sign_up" ? t("invite.createAccount") : t("invite.signInToContinue")}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    {authMode === "sign_up"
                      ? t("invite.createAccountDesc", { company: companyDisplayName })
                      : t("invite.signInDesc")}
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    className={`${modeButtonBaseClassName} ${
                      authMode === "sign_up"
                        ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                        : "border-zinc-800 text-zinc-300 hover:border-zinc-600"
                    }`}
                    onClick={() => {
                      setAuthFeedback(null);
                      setAuthMode("sign_up");
                    }}
                  >
                    {t("invite.createAccountTab")}
                  </button>
                  <button
                    type="button"
                    className={`${modeButtonBaseClassName} ${
                      authMode === "sign_in"
                        ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                        : "border-zinc-800 text-zinc-300 hover:border-zinc-600"
                    }`}
                    onClick={() => {
                      setAuthFeedback(null);
                      setAuthMode("sign_in");
                    }}
                  >
                    {t("invite.iHaveAccount")}
                  </button>
                </div>

                <form
                  className="space-y-4"
                  method="post"
                  action={authMode === "sign_up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email"}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (authMutation.isPending) return;
                    if (!authCanSubmit) {
                      setAuthFeedback({ tone: "error", message: t("invite.fillRequired") });
                      return;
                    }
                    authMutation.mutate();
                  }}
                  data-testid="invite-inline-auth"
                >
                  {authMode === "sign_up" ? (
                    <label className="block text-sm">
                      <span className="mb-1 block text-zinc-400">{t("invite.name")}</span>
                      <input
                        name="name"
                        className={fieldClassName}
                        value={name}
                        onChange={(event) => {
                          setName(event.target.value);
                          setAuthFeedback(null);
                        }}
                        autoComplete="name"
                        autoFocus
                      />
                    </label>
                  ) : null}
                  <label className="block text-sm">
                    <span className="mb-1 block text-zinc-400">{t("invite.email")}</span>
                    <input
                      name="email"
                      type="email"
                      className={fieldClassName}
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        setAuthFeedback(null);
                      }}
                      autoComplete="email"
                      autoFocus={authMode === "sign_in"}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block text-zinc-400">{t("invite.password")}</span>
                    <input
                      name="password"
                      type="password"
                      className={fieldClassName}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setAuthFeedback(null);
                      }}
                      autoComplete={authMode === "sign_in" ? "current-password" : "new-password"}
                    />
                  </label>
                  {authFeedback ? (
                    <p
                      className={`text-xs ${
                        authFeedback.tone === "info" ? "text-amber-300" : "text-red-400"
                      }`}
                    >
                      {authFeedback.message}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    className="w-full rounded-none"
                    disabled={authMutation.isPending}
                    aria-disabled={!authCanSubmit || authMutation.isPending}
                  >
                    {authMutation.isPending
                      ? t("invite.working")
                      : authMode === "sign_in"
                        ? t("invite.signInContinue")
                        : t("invite.createAccountContinue")}
                  </Button>
                </form>

                <p className="text-xs leading-5 text-zinc-500">
                  {authMode === "sign_up"
                    ? t("invite.signUpTip")
                    : t("invite.signInTip")}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">
                    {shouldAutoAcceptHumanInvite
                      ? t("invite.submittingJoin")
                      : invite.inviteType === "bootstrap_ceo"
                        ? t("invite.acceptingInvite")
                        : t("invite.acceptingCompanyInvite")}
                  </h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    {shouldAutoAcceptHumanInvite
                      ? t("invite.submittingJoinDesc", { company: companyDisplayName })
                      : isCurrentMember
                      ? t("invite.alreadyMemberDesc", { company: companyDisplayName })
                      : t("invite.acceptDesc", { action: invite.inviteType === "bootstrap_ceo" ? t("invite.acceptDescBootstrap") : t("invite.acceptDescCompany", { company: companyDisplayName }) })}
                  </p>
                </div>
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
                {shouldAutoAcceptHumanInvite ? (
                  <div className="text-sm text-zinc-400">
                    {acceptMutation.isPending ? t("invite.submittingRequest") : t("invite.finishingSignIn")}
                  </div>
                ) : (
                  <Button
                    className="w-full rounded-none"
                    disabled={acceptMutation.isPending || isCurrentMember}
                    onClick={() => acceptMutation.mutate()}
                  >
                    {acceptMutation.isPending ? t("invite.working") : joinButtonLabel}
                  </Button>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
