import OpenAI from "openai";
import type { Db } from "@paperclipai/db";

/**
 * LLM-Wiki 知识引擎服务（Phase 0：仅 embedding 封装）。
 *
 * Phase 0 MVP 只暴露一个能力：text → 1536 维 vector。后续 Phase 1+ 会
 * 在此 service 内部增加 drafts / nodes / search / drafter / retriever
 * 等子模块（见 docs/design/2026-05-12-llm-wiki-knowledge-engine-architecture.md
 * §3）。
 *
 * 模型选型：OpenAI text-embedding-3-small（1536 维，对应 knowledge_nodes.embedding
 * 列类型 vector(1536)）。如未来换模型需同步改列类型并重建 HNSW 索引。
 *
 * 配置：通过环境变量 OPENAI_API_KEY 注入。未配置时调用 embed() 会抛错。
 */

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;
/** OpenAI embedding 接口对单次输入的 token 上限保守取 8000 字符 */
const MAX_INPUT_CHARS = 8000;

let cachedClient: OpenAI | null = null;

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required for llm-wiki embedding service",
    );
  }
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey });
  }
  return cachedClient;
}

/**
 * llmWikiService 工厂：跟项目 service 风格一致，接收 Db 实例返回方法集。
 * MVP 阶段 db 参数仅占位（Phase 1+ 才会用到），保留 signature 一致性。
 */
export function llmWikiService(_db: Db) {
  return {
    /**
     * 把文本转为 1536 维 embedding。超过 MAX_INPUT_CHARS 自动截断。
     * 失败时抛错，由调用方处理（不内部静默 / 不重试）。
     */
    async embed(text: string): Promise<number[]> {
      if (!text || text.trim().length === 0) {
        throw new Error("embed() requires non-empty text input");
      }
      const truncated = text.slice(0, MAX_INPUT_CHARS);
      const resp = await getClient().embeddings.create({
        model: EMBEDDING_MODEL,
        input: truncated,
      });
      const embedding = resp.data[0]?.embedding;
      if (!embedding || embedding.length !== EMBEDDING_DIM) {
        throw new Error(
          `expected ${EMBEDDING_DIM} dims from ${EMBEDDING_MODEL}, got ${embedding?.length ?? 0}`,
        );
      }
      return embedding;
    },
  };
}

export type LlmWikiService = ReturnType<typeof llmWikiService>;
