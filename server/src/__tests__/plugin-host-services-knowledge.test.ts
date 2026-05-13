import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock knowledgeDraftService — the only direct dep we care about
const mockDraftCreate = vi.fn();
vi.mock("../services/knowledge-drafts.js", () => ({
  knowledgeDraftService: () => ({ create: mockDraftCreate }),
}));

// Stub all the other services buildHostServices instantiates;
// none participate in the knowledge.proposeDraft path.
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getActiveCompaniesForPlugin: vi.fn().mockResolvedValue([{ companyId: "c-1" }]),
  }),
}));
vi.mock("../services/plugin-state-store.js", () => ({ pluginStateStore: () => ({}) }));
vi.mock("../services/plugin-database.js", () => ({ pluginDatabaseService: () => ({}) }));
vi.mock("../services/plugin-secrets-handler.js", () => ({ createPluginSecretsHandler: () => ({}) }));
vi.mock("../services/companies.js", () => ({ companyService: () => ({}) }));
vi.mock("../services/agents.js", () => ({ agentService: () => ({}) }));
vi.mock("../services/plugin-managed-agents.js", () => ({ pluginManagedAgentService: () => ({}) }));
vi.mock("../services/plugin-managed-routines.js", () => ({ pluginManagedRoutineService: () => ({}) }));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => ({}) }));
vi.mock("../services/projects.js", () => ({ projectService: () => ({}) }));
vi.mock("../services/issues.js", () => ({ issueService: () => ({}) }));
vi.mock("../services/issue-thread-interactions.js", () => ({
  issueThreadInteractionService: () => ({}),
}));
vi.mock("../services/documents.js", () => ({ documentService: () => ({}) }));
vi.mock("../services/goals.js", () => ({ goalService: () => ({}) }));
vi.mock("../services/activity.js", () => ({ activityService: () => ({}) }));
vi.mock("../services/costs.js", () => ({ costService: () => ({}) }));
vi.mock("../services/budgets.js", () => ({ budgetService: () => ({}) }));
vi.mock("../services/issue-approvals.js", () => ({ issueApprovalService: () => ({}) }));
vi.mock("../services/assets.js", () => ({ assetService: () => ({}) }));

const fakeEventBus = { forPlugin: () => ({}) } as any;

describe("buildHostServices().knowledge.proposeDraft", () => {
  beforeEach(() => vi.clearAllMocks());

  it("调 knowledgeDraftService.create 并返回 {id, status, preVerdict}", async () => {
    mockDraftCreate.mockResolvedValueOnce({ id: "d-1", status: "pending", preVerdict: null });
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const services = buildHostServices({} as any, "plugin-id", "plugin-key", fakeEventBus);
    const result = await services.knowledge.proposeDraft({
      companyId: "c-1",
      title: "Agent proposed lesson",
      content: "Some content",
      type: "lesson",
      level: "project",
      business_domain_name: "general",
    });
    expect(result).toEqual({ id: "d-1", status: "pending", preVerdict: null });
    expect(mockDraftCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "c-1",
        payload: expect.objectContaining({
          title: "Agent proposed lesson",
          content: "Some content",
          type: "lesson",
          source: "manual",
          business_domain_name: "general",
        }),
      }),
    );
  });

  it("缺 companyId 时抛错（host 端校验）", async () => {
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const services = buildHostServices({} as any, "plugin-id", "plugin-key", fakeEventBus);
    await expect(
      services.knowledge.proposeDraft({
        companyId: "",
        title: "x",
        content: "y",
        type: "lesson",
        level: "project",
        business_domain_name: "general",
      }),
    ).rejects.toThrow(/companyId/);
  });

  it("合并 used_for 到 metadata", async () => {
    mockDraftCreate.mockResolvedValueOnce({ id: "d-1", status: "pending", preVerdict: null });
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const services = buildHostServices({} as any, "plugin-id", "plugin-key", fakeEventBus);
    await services.knowledge.proposeDraft({
      companyId: "c-1",
      title: "t",
      content: "c",
      type: "rule",
      level: "company",
      business_domain_name: "general",
      used_for: ["bug-fix", "security"],
      metadata: { extra: "yes" },
    });
    const callArg = mockDraftCreate.mock.calls[0][0];
    expect(callArg.payload.metadata).toEqual(
      expect.objectContaining({ used_for: ["bug-fix", "security"], extra: "yes" }),
    );
  });
});
