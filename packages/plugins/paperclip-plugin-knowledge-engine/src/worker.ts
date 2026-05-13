import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";

const TOOL_NAME = "propose_knowledge_node";

/**
 * Paperclip LLM-Wiki — propose_knowledge_node tool plugin worker。
 *
 * Agent 调用时把 runCtx (companyId/runId) 透传给 ctx.knowledge.proposeDraft；
 * 不调 LLM、不做抽取（draft 内容由 Agent 已经结构化好），直接落 review queue。
 */
const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("knowledge-engine plugin setup complete");

    ctx.tools.register(
      TOOL_NAME,
      {
        displayName: "Propose Knowledge Node",
        description: "Propose a knowledge draft to the LLM-Wiki review queue.",
        parametersSchema: {
          type: "object",
          required: ["title", "content", "type", "level", "business_domain_name"],
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            type: {
              type: "string",
              enum: ["concept", "lesson", "rule", "decision", "fact"],
            },
            level: {
              type: "string",
              enum: ["personal", "project", "company"],
            },
            business_domain_name: { type: "string" },
            confidence: { type: "number" },
            volatility: {
              type: "string",
              enum: ["stable", "slow", "fast"],
            },
            used_for: { type: "array", items: { type: "string" } },
            target_node_id: { type: ["string", "null"] },
            metadata: { type: "object" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          title?: string;
          content?: string;
          type?: "concept" | "lesson" | "rule" | "decision" | "fact";
          level?: "personal" | "project" | "company";
          business_domain_name?: string;
          confidence?: number;
          volatility?: "stable" | "slow" | "fast";
          used_for?: string[];
          target_node_id?: string | null;
          metadata?: Record<string, unknown>;
        };

        if (!p.title || !p.content || !p.type || !p.level || !p.business_domain_name) {
          return {
            error: "title, content, type, level, business_domain_name are required",
          };
        }

        try {
          const draft = await ctx.knowledge.proposeDraft({
            companyId: runCtx.companyId,
            title: p.title,
            content: p.content,
            type: p.type,
            level: p.level,
            business_domain_name: p.business_domain_name,
            confidence: p.confidence,
            volatility: p.volatility,
            used_for: p.used_for,
            metadata: p.metadata,
            target_node_id: p.target_node_id,
            source_run_id: runCtx.runId,
          });
          return {
            content: `Proposed draft ${draft.id} (status=${draft.status})`,
            data: draft,
          };
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "knowledge-engine plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
