import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.knowledge-engine";
const PLUGIN_VERSION = "0.1.0";

/**
 * Paperclip LLM-Wiki Phase 1b-2 first-party plugin。
 *
 * 暴露一个 Agent tool `propose_knowledge_node`，Agent 运行中可主动提交
 * knowledge draft。Tool handler 调 ctx.knowledge.proposeDraft() 走 host
 * bridge 落到 Paperclip 主进程的 knowledge_drafts 表（source=manual，
 * 走 review queue）。
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Knowledge Engine",
  description: "Exposes propose_knowledge_node Agent tool for writing into the Paperclip LLM-Wiki.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "knowledge.draft.create",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  tools: [
    {
      name: "propose_knowledge_node",
      displayName: "Propose Knowledge Node",
      description:
        "Propose a knowledge draft (lesson / rule / decision / fact / concept) for the LLM-Wiki review queue.",
      parametersSchema: {
        type: "object",
        required: ["title", "content", "type", "level", "business_domain_name"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 500 },
          content: { type: "string", minLength: 1, maxLength: 8000 },
          type: {
            type: "string",
            enum: ["concept", "lesson", "rule", "decision", "fact"],
          },
          level: {
            type: "string",
            enum: ["personal", "project", "company"],
          },
          business_domain_name: {
            type: "string",
            pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          volatility: {
            type: "string",
            enum: ["stable", "slow", "fast"],
          },
          used_for: { type: "array", items: { type: "string" } },
          target_node_id: { type: ["string", "null"], format: "uuid" },
          metadata: { type: "object", additionalProperties: true },
        },
      },
    },
  ],
};

export default manifest;
