import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals } from "@paperclipai/db";

type GoalReader = Pick<Db, "select">;

// 获取公司的"默认"公司级目标，用于 UI 初始展开或导航到目标入口。
// 优先级逻辑（降级兜底）：
//   1. 选第一个 active 且无 parentId 的公司级目标（活跃根节点）；
//   2. 若无，回退到第一个任意状态但无 parentId 的公司级目标；
//   3. 再退一步，取任意公司级目标（即使在树中不是根节点，也作为后备）。
// 这种多级降级确保公司中只要还有公司级目标，就不会返回 null。
export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

// Goal 服务层：封装对 goals 表的 CRUD 操作。
// 所有方法均直接返回 drizzle 查询结果，不包含业务校验或事务包装 —— 由上层路由或调用方负责。
export function goalService(db: Db) {
  return {
    // 列出某公司全部目标，不做分页过滤。前端拿到全量数据后自行构建树形结构。
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    // 按 ID 查询单个目标，不存在返回 null。
    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    // 创建目标：自动注入 companyId，其他字段由调用方提供。
    // 使用 .returning() 返回创建后的完整记录，包括服务端生成的 id/createdAt 等。
    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) =>
      db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    // 更新目标：手动刷新 updatedAt 时间戳，因为 drizzle 不会自动处理。
    // 即使 data 中不包含任何有效字段，也会更新 updatedAt。
    update: (id: string, data: Partial<typeof goals.$inferInsert>) =>
      db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    // 删除目标：硬删除。关联表（project_goals）由外键 CASCADE 自动清理。
    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
