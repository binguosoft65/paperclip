import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { knowledgeApi, type KnowledgeDraft } from "../api/knowledge";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BookOpen, Check, X, Edit3 } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * LLM-Wiki 知识库 drafts 调试页（Phase 1a/1b-1 配套）。
 *
 * 故意做得简陋——只支持按 status 看 draft 列表 + approve / reject /
 * request-revision 三个动作。无编辑器、无搜索、无详情页（节点 / edges
 * 走数据库直查或后续 phase 的页面）。
 */

type StatusFilter = "pending" | "approved" | "rejected" | "revision_requested";
const STATUS_VALUES: StatusFilter[] = ["pending", "approved", "rejected", "revision_requested"];

type Action = "approve" | "reject" | "request-revision";

const STATUS_LABEL: Record<StatusFilter, string> = {
  pending: "待审",
  approved: "已通过",
  rejected: "已驳回",
  revision_requested: "已要求修改",
};

const TYPE_TONE: Record<KnowledgeDraft["proposedType"], string> = {
  concept: "bg-purple-500/15 text-purple-500",
  lesson: "bg-blue-500/15 text-blue-500",
  rule: "bg-amber-500/15 text-amber-500",
  decision: "bg-emerald-500/15 text-emerald-500",
  fact: "bg-slate-500/15 text-slate-400",
};

const SOURCE_LABEL: Record<KnowledgeDraft["source"], string> = {
  manual: "人工/Agent",
  agent_self_review: "Agent 自评",
  failure_signal: "失败信号",
};

// Phase 3b: Reviewer Agent 初筛 verdict 的中文 label + 配色
const PRE_VERDICT_LABEL: Record<NonNullable<KnowledgeDraft["preVerdict"]>, string> = {
  recommend_approve: "建议通过",
  recommend_reject: "建议驳回",
  needs_human: "需人审",
};

const PRE_VERDICT_TONE: Record<NonNullable<KnowledgeDraft["preVerdict"]>, string> = {
  recommend_approve: "bg-emerald-500/15 text-emerald-500",
  recommend_reject: "bg-rose-500/15 text-rose-500",
  needs_human: "bg-amber-500/15 text-amber-500",
};

export function KnowledgeDrafts() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  // path 形如 /knowledge/drafts/pending；末段为状态，缺省 pending
  const pathSegment = location.pathname.split("/").pop() ?? "";
  const statusFilter: StatusFilter = (STATUS_VALUES as readonly string[]).includes(pathSegment)
    ? (pathSegment as StatusFilter)
    : "pending";

  const [actionError, setActionError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<{
    draft: KnowledgeDraft;
    kind: Action;
  } | null>(null);
  const [notesInput, setNotesInput] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "知识库 Drafts" }]);
  }, [setBreadcrumbs]);

  const queryKey = ["knowledge-drafts", selectedCompanyId, statusFilter] as const;

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => knowledgeApi.listDrafts(selectedCompanyId!, statusFilter),
    enabled: !!selectedCompanyId,
  });

  // Tab 计数：一次拉所有 status 的前 100 条用于显示徽章。计数不精确（如有 100+ 条会
  // 显示 100，仍能传递相对量级）；调试场景足够。
  const { data: counts } = useQuery({
    queryKey: ["knowledge-drafts-counts", selectedCompanyId],
    queryFn: () =>
      knowledgeApi.listDrafts(selectedCompanyId!, STATUS_VALUES.join(",")),
    enabled: !!selectedCompanyId,
  });
  const statusCounts: Record<StatusFilter, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
    revision_requested: 0,
  };
  for (const d of counts?.data ?? []) {
    if (d.status in statusCounts) statusCounts[d.status as StatusFilter] += 1;
  }

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["knowledge-drafts", selectedCompanyId] });
    queryClient.invalidateQueries({ queryKey: ["knowledge-drafts-counts", selectedCompanyId] });
  };

  const approveMutation = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      knowledgeApi.approve(id, selectedCompanyId!, notes),
    onSuccess: (res) => {
      setActionError(null);
      setActiveAction(null);
      setNotesInput("");
      invalidate();
      pushToast({
        title: "已批准并物化为节点",
        // ToastInput 只认 body 字段（无 description）；本文件其余 pushToast 均用 body
        body: `node_id: ${res?.data?.node_id?.slice(0, 8)}…`,
        tone: "success",
      });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes?: string }) =>
      knowledgeApi.reject(id, selectedCompanyId!, notes),
    onSuccess: () => {
      setActionError(null);
      setActiveAction(null);
      setNotesInput("");
      invalidate();
      pushToast({ title: "已驳回 draft", tone: "info" });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Reject failed"),
  });

  const requestRevisionMutation = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes: string }) =>
      knowledgeApi.requestRevision(id, selectedCompanyId!, notes),
    onSuccess: () => {
      setActionError(null);
      setActiveAction(null);
      setNotesInput("");
      invalidate();
      pushToast({ title: "已发出修改请求", tone: "info" });
    },
    onError: (err) =>
      setActionError(err instanceof Error ? err.message : "Request revision failed"),
  });

  // Phase 3b: 触发 Reviewer Agent 对当前公司未初筛的 pending draft 跑一轮
  const triggerMutation = useMutation({
    mutationFn: () => knowledgeApi.reviewerRun(selectedCompanyId!),
    onSuccess: (res) => {
      invalidate();
      pushToast({
        title: `Reviewer 已处理 ${res.data.processed} 条 draft`,
        body: res.data.errors.length > 0 ? `失败 ${res.data.errors.length} 条` : undefined,
        tone: res.data.errors.length > 0 ? "warn" : "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "触发 Reviewer 失败",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      }),
  });

  // Phase 3b: 按 verdict 一键批量应用（目前 UI 只暴露 recommend_approve）
  const batchApplyMutation = useMutation({
    mutationFn: ({
      verdict,
      ids,
    }: {
      verdict: "recommend_approve" | "recommend_reject";
      ids: string[];
    }) => knowledgeApi.batchApplyVerdict(selectedCompanyId!, verdict, ids),
    onSuccess: (res) => {
      invalidate();
      const count =
        res.data.verdict === "recommend_approve"
          ? res.data.approved_count
          : res.data.rejected_count;
      pushToast({
        title:
          res.data.verdict === "recommend_approve"
            ? `已批准 ${count ?? 0} 条`
            : `已驳回 ${count ?? 0} 条`,
        body: res.data.failed.length > 0 ? `失败 ${res.data.failed.length} 条` : undefined,
        tone: res.data.failed.length > 0 ? "warn" : "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "批量应用失败",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      }),
  });

  function confirmAction() {
    if (!activeAction) return;
    const { draft, kind } = activeAction;
    const notes = notesInput.trim();
    if (kind === "approve") {
      approveMutation.mutate({ id: draft.id, notes: notes || undefined });
    } else if (kind === "reject") {
      rejectMutation.mutate({ id: draft.id, notes: notes || undefined });
    } else {
      if (!notes) {
        setActionError("请填写修改说明");
        return;
      }
      requestRevisionMutation.mutate({ id: draft.id, notes });
    }
  }

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">请先选择公司</p>;
  }

  const drafts = data?.data ?? [];
  const mutationPending =
    approveMutation.isPending || rejectMutation.isPending || requestRevisionMutation.isPending;

  // pending tab 顶部「一键通过 recommend_approve」按钮的候选 ID 集合
  const recommendApproveIds = drafts
    .filter((d) => d.preVerdict === "recommend_approve")
    .map((d) => d.id);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Tabs
          value={statusFilter}
          onValueChange={(v) => navigate(`/knowledge/drafts/${v}`)}
        >
          <PageTabBar
            items={STATUS_VALUES.map((s) => ({
              value: s,
              label: (
                <>
                  {STATUS_LABEL[s]}
                  {statusCounts[s] > 0 && (
                    <span
                      className={cn(
                        "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                        s === "pending"
                          ? "bg-yellow-500/20 text-yellow-500"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {statusCounts[s]}
                    </span>
                  )}
                </>
              ),
            }))}
          />
        </Tabs>
        <div className="text-xs text-muted-foreground">
          公司: <code className="text-foreground/80">{selectedCompany?.name ?? selectedCompanyId.slice(0, 8)}</code>
        </div>
      </div>

      {statusFilter === "pending" && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={triggerMutation.isPending}
            onClick={() => triggerMutation.mutate()}
          >
            {triggerMutation.isPending ? "Reviewer 跑中…" : "触发 Reviewer 初筛"}
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={batchApplyMutation.isPending || recommendApproveIds.length === 0}
            onClick={() =>
              batchApplyMutation.mutate({
                verdict: "recommend_approve",
                ids: recommendApproveIds,
              })
            }
          >
            {batchApplyMutation.isPending
              ? "应用中…"
              : `一键通过 recommend_approve (${recommendApproveIds.length})`}
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}

      {!isLoading && drafts.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <BookOpen className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            没有 {STATUS_LABEL[statusFilter]} 状态的 draft
          </p>
        </div>
      )}

      {drafts.length > 0 && (
        <div className="rounded-lg border border-border divide-y divide-border bg-card">
          {drafts.map((draft) => (
            <DraftRow
              key={draft.id}
              draft={draft}
              showActions={statusFilter === "pending"}
              disabled={mutationPending}
              onApprove={() => {
                setActiveAction({ draft, kind: "approve" });
                setNotesInput("");
                setActionError(null);
              }}
              onReject={() => {
                setActiveAction({ draft, kind: "reject" });
                setNotesInput("");
                setActionError(null);
              }}
              onRequestRevision={() => {
                setActiveAction({ draft, kind: "request-revision" });
                setNotesInput("");
                setActionError(null);
              }}
            />
          ))}
        </div>
      )}

      <Dialog
        open={activeAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveAction(null);
            setNotesInput("");
            setActionError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {activeAction?.kind === "approve"
                ? "批准 draft"
                : activeAction?.kind === "reject"
                  ? "驳回 draft"
                  : "要求修改"}
            </DialogTitle>
            <DialogDescription>
              {activeAction?.draft.proposedTitle}
              {activeAction?.kind === "request-revision" && (
                <span className="block mt-1 text-destructive">必须填写修改说明</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder={
              activeAction?.kind === "request-revision"
                ? "说明需要修改什么（必填）"
                : "review 备注（可选）"
            }
            value={notesInput}
            onChange={(e) => setNotesInput(e.target.value)}
            rows={4}
            autoFocus
          />
          {actionError && <p className="text-xs text-destructive">{actionError}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setActiveAction(null);
                setNotesInput("");
                setActionError(null);
              }}
              disabled={mutationPending}
            >
              取消
            </Button>
            <Button
              onClick={confirmAction}
              disabled={
                mutationPending ||
                (activeAction?.kind === "request-revision" && notesInput.trim().length === 0)
              }
              variant={activeAction?.kind === "reject" ? "destructive" : "default"}
            >
              {mutationPending ? "处理中…" : "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 单行 draft 展示：类型徽章 + 标题 + 内容截断 + 来源 + 创建时间 + 操作按钮（仅 pending 显示） */
function DraftRow({
  draft,
  showActions,
  disabled,
  onApprove,
  onReject,
  onRequestRevision,
}: {
  draft: KnowledgeDraft;
  showActions: boolean;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRequestRevision: () => void;
}) {
  const createdAt = new Date(draft.createdAt);
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className={cn("font-normal", TYPE_TONE[draft.proposedType])}
          >
            {draft.proposedType}
          </Badge>
          <Badge variant="outline" className="font-normal">
            {draft.proposedLevel}
          </Badge>
          {draft.preVerdict && (
            <Badge
              variant="outline"
              className={cn("text-xs font-normal", PRE_VERDICT_TONE[draft.preVerdict])}
            >
              {PRE_VERDICT_LABEL[draft.preVerdict]}
            </Badge>
          )}
          <span className="text-sm font-medium truncate">{draft.proposedTitle}</span>
        </div>
        <p className="text-sm text-muted-foreground line-clamp-2">{draft.proposedContent}</p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>{SOURCE_LABEL[draft.source]}</span>
          <span>confidence {Number(draft.confidence).toFixed(2)}</span>
          {draft.proposedVolatility && <span>volatility {draft.proposedVolatility}</span>}
          <span>created {createdAt.toLocaleString()}</span>
          {draft.sourceIssueId && (
            <span>issue <code>{draft.sourceIssueId.slice(0, 8)}</code></span>
          )}
          {draft.sourceRunId && (
            <span>run <code>{draft.sourceRunId.slice(0, 8)}</code></span>
          )}
        </div>
        {draft.preVerdictReasoning && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">Reviewer 理由</summary>
            <p className="mt-1 whitespace-pre-wrap">{draft.preVerdictReasoning}</p>
            {draft.detectedConflicts.length > 0 && (
              <p className="mt-1 text-rose-500">
                检测到冲突节点：{draft.detectedConflicts.join(", ")}
              </p>
            )}
          </details>
        )}
        {draft.reviewedAt && (
          <p className="text-xs text-muted-foreground">
            reviewed at {new Date(draft.reviewedAt).toLocaleString()}
            {draft.reviewedBy && <> by <code>{draft.reviewedBy.slice(0, 12)}</code></>}
          </p>
        )}
        {draft.reviewNotes && (
          <p className="text-xs text-muted-foreground italic">备注: {draft.reviewNotes}</p>
        )}
      </div>
      {showActions && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onApprove}
            disabled={disabled}
            title="批准"
          >
            <Check className="h-4 w-4 text-emerald-500" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRequestRevision}
            disabled={disabled}
            title="要求修改"
          >
            <Edit3 className="h-4 w-4 text-amber-500" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onReject}
            disabled={disabled}
            title="驳回"
          >
            <X className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      )}
    </div>
  );
}
