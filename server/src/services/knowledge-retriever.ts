import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { computeFreshness, freshnessLabel, type FreshnessLabel } from "./knowledge-freshness.js";

/**
 * Knowledge Retriever 服务（Phase 2a）—— PRD §6 FR5 两路检索。
 *
 * 输入自然语言 query，输出 Top N 结果按 final_score 排序。
 *
 * 工作流：
 *   1. embed(query) → 1536 维 query vector
 *   2. 语义路径 SQL：cosine 距离 < 0.25（similarity > 0.75）+ active + 多层过滤 → Top 10
 *   3. 经验路径 SQL（仅当传 used_for）：used_for && $tags + active + 同样过滤 → Top 5
 *   4. 合并去重 → 算每条 final_score = sim*0.5 + exp_norm*0.3 + freshness*0.2
 *   5. 按 final_score 降序，取 limit（默认 5）
 *
 * freshness 实时算，不存 DB（见 ./knowledge-freshness）。
 * outdated 节点（freshness < 0.3）默认排除，可用 include_outdated=true 显式保留。
 */

export interface RetrieverChatClient {
  embed(text: string): Promise<number[]>;
}

export interface KnowledgeSearchInput {
  companyId: string;
  query: string;
  projectId?: string | null;
  type?: string[] | null;
  domain?: string[] | null;
  used_for?: string[] | null;
  include_outdated?: boolean;
  limit?: number;
}

export interface SearchResultDomain {
  name: string;
  display_label: string;
  color: string;
}

export interface SearchResultItem {
  id: string;
  title: string;
  snippet: string;
  type: string;
  level: string;
  domain: SearchResultDomain;
  confidence: number;
  verified: boolean;
  trigger_count: number;
  similarity: number;
  experience_score: number;
  freshness_score: number;
  freshness_label: FreshnessLabel;
  final_score: number;
  verified_at: string | null;
  volatility: string | null;
}

export interface KnowledgeSearchResult {
  results: SearchResultItem[];
  search_type: "semantic" | "experience" | "semantic+experience";
  took_ms: number;
}

// 注：PRD §6 FR5 写 0.75，是按 OpenAI text-embedding-3-small 校准。
// DashScope text-embedding-v1 的 cosine 分布更平（不同语义节点典型 0.0~0.3，
// 同义改写约 0.5~0.7），用 0.75 会全部空集。这里取 env 覆盖、默认 0.3，
// 兼容两类 provider；生产建议按所用 embedding model 校准这个常量。
const SEMANTIC_SIMILARITY_FLOOR = Number(
  process.env.KNOWLEDGE_SEMANTIC_SIMILARITY_FLOOR ?? "0.3",
);
const SEMANTIC_LIMIT = 10;
const EXPERIENCE_LIMIT = 5;
const SNIPPET_CHARS = 200;
const EXP_SCORE_NORMALIZATION = 10;   // experience_score / 10 上限 1.0

/** Drizzle 拼接 array literal 的字面量（避免 ARRAY[$1,$2] 绑定数组到 text[] 麻烦） */
function pgTextArray(values: string[]) {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

function pgVector(vec: number[]) {
  // pgvector 文本格式 [v1,v2,...]
  return sql`${`[${vec.join(",")}]`}::vector`;
}

export function knowledgeRetrieverService(db: Db, llm: RetrieverChatClient) {
  return {
    async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
      if (!input.query || input.query.trim().length === 0) {
        throw unprocessable("query parameter is required");
      }

      const startedAt = Date.now();
      const queryVec = await llm.embed(input.query);
      const queryVecSql = pgVector(queryVec);
      const companyId = input.companyId;
      const limit = input.limit ?? 5;

      // 公共 WHERE 子句构造。注意：SQL `= NULL` 永假，必须用 `IS NULL`，
      // 否则当 projectId 缺省时所有 project-level 节点（即便 project_id 为 NULL）
      // 都会被过滤掉，导致检索结果只剩 company-level。
      const filters = [
        sql`n.company_id = ${companyId}`,
        sql`n.status = 'active'`,
        input.projectId
          ? sql`(n.level = 'company' OR (n.level = 'project' AND n.project_id = ${input.projectId}))`
          : sql`(n.level = 'company' OR (n.level = 'project' AND n.project_id IS NULL))`,
      ];
      if (input.type && input.type.length > 0) {
        filters.push(sql`n.type = ANY(${pgTextArray(input.type)})`);
      }
      if (input.domain && input.domain.length > 0) {
        // 业务域 name 过滤；general 永远兜底命中
        filters.push(
          sql`(d.name = ANY(${pgTextArray([...input.domain, "general"])}))`,
        );
      }
      const whereCombined = sql.join(filters, sql` AND `);

      // ── 语义路径 ──
      const semanticSql = sql`
        SELECT
          n.id, n.title, n.content, n.type, n.level, n.confidence, n.verified,
          n.trigger_count, n.last_triggered, n.volatility, n.verified_at,
          n.valid_until, n.metadata, n.created_at,
          1 - (n.embedding <=> ${queryVecSql}) AS similarity,
          d.name AS domain_name,
          d.display_label AS domain_display_label,
          d.color AS domain_color
        FROM knowledge_nodes n
        JOIN business_domains d ON d.id = n.business_domain_id
        WHERE ${whereCombined}
          AND 1 - (n.embedding <=> ${queryVecSql}) > ${SEMANTIC_SIMILARITY_FLOOR}
        ORDER BY n.embedding <=> ${queryVecSql}
        LIMIT ${SEMANTIC_LIMIT}
      `;
      const semanticRowsRaw = (await db.execute(semanticSql)) as unknown as Array<Record<string, unknown>>;

      // ── 经验路径（条件性） ──
      let experienceRowsRaw: Array<Record<string, unknown>> = [];
      let hasExperience = false;
      if (input.used_for && input.used_for.length > 0) {
        hasExperience = true;
        const expWhere = sql.join(
          [
            ...filters,
            sql`n.used_for && ${pgTextArray(input.used_for)}`,
          ],
          sql` AND `,
        );
        const experienceSql = sql`
          SELECT
            n.id, n.title, n.content, n.type, n.level, n.confidence, n.verified,
            n.trigger_count, n.last_triggered, n.volatility, n.verified_at,
            n.valid_until, n.metadata, n.created_at,
            n.trigger_count * (1.0 / GREATEST(1, EXTRACT(DAY FROM (now() - COALESCE(n.last_triggered, n.created_at))))) AS exp_raw,
            d.name AS domain_name,
            d.display_label AS domain_display_label,
            d.color AS domain_color
          FROM knowledge_nodes n
          JOIN business_domains d ON d.id = n.business_domain_id
          WHERE ${expWhere}
          ORDER BY exp_raw DESC
          LIMIT ${EXPERIENCE_LIMIT}
        `;
        experienceRowsRaw = (await db.execute(experienceSql)) as unknown as Array<Record<string, unknown>>;
      }

      // ── 合并去重 ──
      type Row = Record<string, unknown>;
      const merged = new Map<string, { row: Row; similarity: number; experience: number }>();

      for (const row of semanticRowsRaw) {
        const id = row.id as string;
        const sim = typeof row.similarity === "number" ? row.similarity : Number(row.similarity ?? 0);
        merged.set(id, { row, similarity: sim, experience: 0 });
      }
      for (const row of experienceRowsRaw) {
        const id = row.id as string;
        const expRaw = typeof row.exp_raw === "number" ? row.exp_raw : Number(row.exp_raw ?? 0);
        const expNorm = Math.min(expRaw / EXP_SCORE_NORMALIZATION, 1.0);
        const existing = merged.get(id);
        if (existing) {
          existing.experience = expNorm;
        } else {
          merged.set(id, { row, similarity: 0, experience: expNorm });
        }
      }

      // ── 算 final_score + freshness ──
      const now = new Date();
      const includeOutdated = input.include_outdated === true;
      const items: SearchResultItem[] = [];
      for (const { row, similarity, experience } of merged.values()) {
        const freshness = computeFreshness(
          {
            volatility: (row.volatility as string | null) ?? null,
            verifiedAt: (row.verified_at as string | Date | null) ?? null,
            validUntil: (row.valid_until as string | Date | null) ?? null,
            createdAt: (row.created_at as string | Date) ?? new Date(),
            metadata: (row.metadata as Record<string, unknown> | null) ?? null,
          },
          now,
        );
        const label = freshnessLabel(freshness);
        if (!includeOutdated && label === "outdated") continue;

        const finalScore = similarity * 0.5 + experience * 0.3 + freshness * 0.2;
        const contentStr = String(row.content ?? "");

        items.push({
          id: String(row.id),
          title: String(row.title ?? ""),
          snippet: contentStr.length > SNIPPET_CHARS ? contentStr.slice(0, SNIPPET_CHARS) + "…" : contentStr,
          type: String(row.type ?? ""),
          level: String(row.level ?? ""),
          domain: {
            name: String(row.domain_name ?? ""),
            display_label: String(row.domain_display_label ?? ""),
            color: String(row.domain_color ?? "#6B7280"),
          },
          confidence: Number(row.confidence ?? 0),
          verified: Boolean(row.verified),
          trigger_count: Number(row.trigger_count ?? 0),
          similarity: Number(similarity.toFixed(4)),
          experience_score: Number(experience.toFixed(4)),
          freshness_score: Number(freshness.toFixed(4)),
          freshness_label: label,
          final_score: Number(finalScore.toFixed(4)),
          verified_at: row.verified_at instanceof Date ? row.verified_at.toISOString() : (row.verified_at as string | null) ?? null,
          volatility: (row.volatility as string | null) ?? null,
        });
      }

      items.sort((a, b) => b.final_score - a.final_score);
      const results = items.slice(0, limit);

      const searchType: KnowledgeSearchResult["search_type"] = hasExperience
        ? "semantic+experience"
        : "semantic";

      return {
        results,
        search_type: searchType,
        took_ms: Date.now() - startedAt,
      };
    },
  };
}

export type KnowledgeRetrieverService = ReturnType<typeof knowledgeRetrieverService>;
