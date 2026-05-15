import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { projectService } from "../services/projects.ts";

// 回归测试：非 UUID 的项目引用（如前端改名后访问 /projects/onboarding）
// 不得把字符串塞进 UUID 类型的查询里触发 Postgres 500，应短路返回 null（路由层转 404）。
describe("projectService.getById UUID guard", () => {
  it("returns null for a non-UUID id without touching the database", async () => {
    let queried = false;
    const fakeDb = {
      select() {
        queried = true;
        throw new Error("db.select must not be called for a non-UUID project id");
      },
    } as unknown as Db;

    const svc = projectService(fakeDb);
    const result = await svc.getById("onboarding");

    expect(result).toBeNull();
    expect(queried).toBe(false);
  });
});
