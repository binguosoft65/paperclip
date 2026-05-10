// pause-hold-guard: 检查 issue 树控制层面的"暂停持有"门禁
// 当用户手动暂停了某个 issue 的自动流程，恢复系统不应干预
// 这个防护可以避免恢复逻辑与用户意图冲突

import type { Db } from "@paperclipai/db";
import { issueTreeControlService } from "../issue-tree-control.js";

type IssueTreeControlService = ReturnType<typeof issueTreeControlService>;

// 判断某个 issue 当前是否处于"暂停持有"保护之下
// 如果是，则恢复操作（如续作、升级等）应被抑制，尊重用户暂停的意图
export async function isAutomaticRecoverySuppressedByPauseHold(
  db: Db,
  companyId: string,
  issueId: string,
  treeControlSvc: IssueTreeControlService = issueTreeControlService(db),
) {
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, issueId);
  return Boolean(activePauseHold);
}
