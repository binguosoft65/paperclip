import { api } from "./client";

/**
 * LLM-Wiki 知识引擎 API 客户端（Phase 1a/1b-1）。
 * 当前调试 UI 仅用到 drafts 子集；nodes/edges/search 待后续 phase。
 */

export interface KnowledgeDraft {
  id: string;
  targetNodeId: string | null;
  proposedTitle: string;
  proposedContent: string;
  proposedType: "concept" | "lesson" | "rule" | "decision" | "fact";
  proposedLevel: "personal" | "project" | "company";
  proposedBusinessDomainId: string;
  proposedMetadata: Record<string, unknown>;
  proposedVolatility: "stable" | "slow" | "fast" | null;
  proposedValidUntil: string | null;
  source: "manual" | "agent_self_review" | "failure_signal";
  sourceAgentId: string | null;
  sourceRunId: string | null;
  sourceIssueId: string | null;
  sourceUserId: string | null;
  confidence: number;
  preVerdict: "recommend_approve" | "recommend_reject" | "needs_human" | null;
  preVerdictReasoning: string | null;
  preVerdictAt: string | null;
  detectedConflicts: string[];
  status: "pending" | "approved" | "rejected" | "revision_requested";
  reviewedBy: string | null;
  reviewNotes: string | null;
  companyId: string;
  createdAt: string;
  reviewedAt: string | null;
}

export interface KnowledgeDraftListResponse {
  data: KnowledgeDraft[];
  meta: { next_cursor: string | null };
}

export const knowledgeApi = {
  listDrafts: (companyId: string, status?: string) => {
    const params = new URLSearchParams({ companyId });
    if (status) params.set("status", status);
    return api.get<KnowledgeDraftListResponse>(`/knowledge/drafts?${params}`);
  },

  approve: (id: string, companyId: string, review_notes?: string) =>
    api.post<{ data: { node_id: string } }>(
      `/knowledge/drafts/${id}/approve?companyId=${companyId}`,
      review_notes ? { review_notes } : {},
    ),

  reject: (id: string, companyId: string, review_notes?: string) =>
    api.post<void>(
      `/knowledge/drafts/${id}/reject?companyId=${companyId}`,
      review_notes ? { review_notes } : {},
    ),

  requestRevision: (id: string, companyId: string, review_notes: string) =>
    api.post<{ data: { issue_id: string | null } }>(
      `/knowledge/drafts/${id}/request-revision?companyId=${companyId}`,
      { review_notes },
    ),
};
