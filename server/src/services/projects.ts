import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  projects,
  projectGoals,
  goals,
  pluginManagedResources,
  plugins,
  projectWorkspaces,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  PROJECT_COLORS,
  deriveProjectUrlKey,
  hasNonAsciiContent,
  isUuidLike,
  normalizeProjectUrlKey,
  type ProjectCodebase,
  type ProjectExecutionWorkspacePolicy,
  type ProjectGoalRef,
  type ProjectManagedByPlugin,
  type ProjectWorkspaceRuntimeConfig,
  type ProjectWorkspace,
  type WorkspaceRuntimeService,
  type PluginManagedProjectDeclaration,
  type PluginManagedProjectResolution,
} from "@paperclipai/shared";
import { listCurrentRuntimeServicesForProjectWorkspaces } from "./workspace-runtime-read-model.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { mergeProjectWorkspaceRuntimeConfig, readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";

type ProjectRow = typeof projects.$inferSelect;
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
// 哨兵值：当工作区仅配置了 git 仓库但未指定本地路径时，数据库用该值占位，查询时自动转为 null
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
type CreateWorkspaceInput = {
  name?: string | null;
  sourceType?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  defaultRef?: string | null;
  visibility?: string | null;
  setupCommand?: string | null;
  cleanupCommand?: string | null;
  remoteProvider?: string | null;
  remoteWorkspaceRef?: string | null;
  sharedWorkspaceKey?: string | null;
  metadata?: Record<string, unknown> | null;
  runtimeConfig?: Partial<ProjectWorkspaceRuntimeConfig> | null;
  isPrimary?: boolean;
};
type UpdateWorkspaceInput = Partial<CreateWorkspaceInput>;

interface ProjectWithGoals extends Omit<ProjectRow, "executionWorkspacePolicy"> {
  urlKey: string;
  goalIds: string[];
  goals: ProjectGoalRef[];
  executionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  codebase: ProjectCodebase;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  managedByPlugin: ProjectManagedByPlugin | null;
}

interface ProjectShortnameRow {
  id: string;
  name: string;
}

interface ResolveProjectNameOptions {
  excludeProjectId?: string | null;
}

/** 批量加载项目关联的目标：一次查询 project_goals 联表 + goals 表，减少 N+1 问题 */
async function attachGoals(db: Db, rows: ProjectRow[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);

  // Fetch join rows + goal titles in one query
  const links = await db
    .select({
      projectId: projectGoals.projectId,
      goalId: projectGoals.goalId,
      goalTitle: goals.title,
    })
    .from(projectGoals)
    .innerJoin(goals, eq(projectGoals.goalId, goals.id))
    .where(inArray(projectGoals.projectId, projectIds));

  const map = new Map<string, ProjectGoalRef[]>();
  for (const link of links) {
    let arr = map.get(link.projectId);
    if (!arr) {
      arr = [];
      map.set(link.projectId, arr);
    }
    arr.push({ id: link.goalId, title: link.goalTitle });
  }

  return rows.map((r) => {
    const g = map.get(r.id) ?? [];
    return {
      ...r,
      urlKey: deriveProjectUrlKey(r.name, r.id),
      goalIds: g.map((x) => x.id),
      goals: g,
      executionWorkspacePolicy: parseProjectExecutionWorkspacePolicy(r.executionWorkspacePolicy),
    } as ProjectWithGoals;
  });
}

function toRuntimeService(row: WorkspaceRuntimeServiceRow): WorkspaceRuntimeService {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    scopeType: row.scopeType as WorkspaceRuntimeService["scopeType"],
    scopeId: row.scopeId ?? null,
    serviceName: row.serviceName,
    status: row.status as WorkspaceRuntimeService["status"],
    lifecycle: row.lifecycle as WorkspaceRuntimeService["lifecycle"],
    reuseKey: row.reuseKey ?? null,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    port: row.port ?? null,
    url: row.url ?? null,
    provider: row.provider as WorkspaceRuntimeService["provider"],
    providerRef: row.providerRef ?? null,
    ownerAgentId: row.ownerAgentId ?? null,
    startedByRunId: row.startedByRunId ?? null,
    lastUsedAt: row.lastUsedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt ?? null,
    stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
    healthStatus: row.healthStatus as WorkspaceRuntimeService["healthStatus"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWorkspace(
  row: ProjectWorkspaceRow,
  runtimeServices: WorkspaceRuntimeService[] = [],
): ProjectWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    name: row.name,
    sourceType: row.sourceType as ProjectWorkspace["sourceType"],
    cwd: normalizeWorkspaceCwd(row.cwd),
    repoUrl: row.repoUrl ?? null,
    repoRef: row.repoRef ?? null,
    defaultRef: row.defaultRef ?? row.repoRef ?? null,
    visibility: row.visibility as ProjectWorkspace["visibility"],
    setupCommand: row.setupCommand ?? null,
    cleanupCommand: row.cleanupCommand ?? null,
    remoteProvider: row.remoteProvider ?? null,
    remoteWorkspaceRef: row.remoteWorkspaceRef ?? null,
    sharedWorkspaceKey: row.sharedWorkspaceKey ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    runtimeConfig: readProjectWorkspaceRuntimeConfig((row.metadata as Record<string, unknown> | null) ?? null),
    isPrimary: row.isPrimary,
    runtimeServices,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// 从仓库 URL 中提取仓库名（如 https://github.com/org/repo.git -> repo），用于 Paperclip 托管目录命名
function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const raw = readNonEmptyString(repoUrl);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

function deriveProjectCodebase(input: {
  companyId: string;
  projectId: string;
  primaryWorkspace: ProjectWorkspace | null;
  fallbackWorkspaces: ProjectWorkspace[];
}): ProjectCodebase {
  const primaryWorkspace = input.primaryWorkspace ?? input.fallbackWorkspaces[0] ?? null;
  const repoUrl = primaryWorkspace?.repoUrl ?? null;
  const repoName = deriveRepoNameFromRepoUrl(repoUrl);
  const localFolder = primaryWorkspace?.cwd ?? null;
  const managedFolder = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName,
  });

  return {
    workspaceId: primaryWorkspace?.id ?? null,
    repoUrl,
    repoRef: primaryWorkspace?.repoRef ?? null,
    defaultRef: primaryWorkspace?.defaultRef ?? null,
    repoName,
    localFolder,
    managedFolder,
    effectiveLocalFolder: localFolder ?? managedFolder,
    origin: localFolder ? "local_folder" : "managed_checkout", // 标识代码库来源：用户本地路径 vs Paperclip 托管检出
  };
}

// 选择主工作区：优先使用 isPrimary 标记，若没有显式标记则取第一个（按创建时间排序后最早的）
function pickPrimaryWorkspace(
  rows: ProjectWorkspaceRow[],
  runtimeServicesByWorkspaceId?: Map<string, WorkspaceRuntimeService[]>,
): ProjectWorkspace | null {
  if (rows.length === 0) return null;
  const explicitPrimary = rows.find((row) => row.isPrimary);
  const primary = explicitPrimary ?? rows[0];
  return toWorkspace(primary, runtimeServicesByWorkspaceId?.get(primary.id) ?? []);
}

/** 批量加载项目的工作区、运行时服务和插件托管资源：在一次批量查询中完成所有关联数据加载 */
async function attachWorkspaces(db: Db, rows: ProjectWithGoals[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);
  const workspaceRows = await db
    .select()
    .from(projectWorkspaces)
    .where(inArray(projectWorkspaces.projectId, projectIds))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
  const runtimeServicesByWorkspaceId = await listCurrentRuntimeServicesForProjectWorkspaces(
    db,
    rows[0]!.companyId,
    workspaceRows.map((workspace) => workspace.id),
  );
  const sharedRuntimeServicesByWorkspaceId = new Map(
    Array.from(runtimeServicesByWorkspaceId.entries()).map(([workspaceId, services]) => [
      workspaceId,
      services.map(toRuntimeService),
    ]),
  );

  const map = new Map<string, ProjectWorkspaceRow[]>();
  for (const row of workspaceRows) {
    let arr = map.get(row.projectId);
    if (!arr) {
      arr = [];
      map.set(row.projectId, arr);
    }
    arr.push(row);
  }

  const managedRows = await db
    .select({
      id: pluginManagedResources.id,
      pluginId: pluginManagedResources.pluginId,
      pluginKey: pluginManagedResources.pluginKey,
      manifestJson: plugins.manifestJson,
      resourceKind: pluginManagedResources.resourceKind,
      resourceKey: pluginManagedResources.resourceKey,
      resourceId: pluginManagedResources.resourceId,
      defaultsJson: pluginManagedResources.defaultsJson,
      createdAt: pluginManagedResources.createdAt,
      updatedAt: pluginManagedResources.updatedAt,
    })
    .from(pluginManagedResources)
    .innerJoin(plugins, eq(pluginManagedResources.pluginId, plugins.id))
    .where(and(
      eq(pluginManagedResources.resourceKind, "project"),
      inArray(pluginManagedResources.resourceId, projectIds),
    ));
  const managedByProjectId = new Map<string, ProjectManagedByPlugin>();
  for (const row of managedRows) {
    managedByProjectId.set(row.resourceId, {
      id: row.id,
      pluginId: row.pluginId,
      pluginKey: row.pluginKey,
      pluginDisplayName: row.manifestJson.displayName ?? row.pluginKey,
      resourceKind: "project",
      resourceKey: row.resourceKey,
      defaultsJson: row.defaultsJson,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return rows.map((row) => {
    const projectWorkspaceRows = map.get(row.id) ?? [];
    const workspaces = projectWorkspaceRows.map((workspace) =>
      toWorkspace(
        workspace,
        sharedRuntimeServicesByWorkspaceId.get(workspace.id) ?? [],
      ),
    );
    const primaryWorkspace = pickPrimaryWorkspace(projectWorkspaceRows, sharedRuntimeServicesByWorkspaceId);
    return {
      ...row,
      codebase: deriveProjectCodebase({
        companyId: row.companyId,
        projectId: row.id,
        primaryWorkspace,
        fallbackWorkspaces: workspaces,
      }),
      workspaces,
      primaryWorkspace,
      managedByPlugin: managedByProjectId.get(row.id) ?? null,
    };
  });
}

/** 同步项目-目标的关联关系：全量替换策略（先删后插），避免逐条 diff */
async function syncGoalLinks(db: Db, projectId: string, companyId: string, goalIds: string[]) {
  // 删除旧的关联记录
  await db.delete(projectGoals).where(eq(projectGoals.projectId, projectId));

  // 插入新的关联记录
  if (goalIds.length > 0) {
    await db.insert(projectGoals).values(
      goalIds.map((goalId) => ({ projectId, goalId, companyId })),
    );
  }
}

/** 解析目标 ID 列表：兼容旧版单一 goalId 字段，新版使用 goalIds 数组，undefined 表示不修改 */
function resolveGoalIds(data: { goalIds?: string[]; goalId?: string | null }): string[] | undefined {
  if (data.goalIds !== undefined) return data.goalIds;
  if (data.goalId !== undefined) {
    return data.goalId ? [data.goalId] : [];
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// 归一化工作区路径：空值或哨兵值均转为 null，确保领域层使用一致的语义
function normalizeWorkspaceCwd(value: unknown): string | null {
  const cwd = readNonEmptyString(value);
  if (!cwd) return null;
  return cwd === REPO_ONLY_CWD_SENTINEL ? null : cwd;
}

function deriveNameFromCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Local folder";
}

function deriveNameFromRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    const cleanedPath = url.pathname.replace(/\/+$/, "");
    const lastSegment = cleanedPath.split("/").filter(Boolean).pop() ?? "";
    const noGitSuffix = lastSegment.replace(/\.git$/i, "");
    return noGitSuffix || repoUrl;
  } catch {
    return repoUrl;
  }
}

// 推导工作区名称：显式名称 > 本地目录名 > 仓库名 > 默认值 "Workspace"
function deriveWorkspaceName(input: {
  name?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
}) {
  const explicit = readNonEmptyString(input.name);
  if (explicit) return explicit;

  const cwd = readNonEmptyString(input.cwd);
  if (cwd) return deriveNameFromCwd(cwd);

  const repoUrl = readNonEmptyString(input.repoUrl);
  if (repoUrl) return deriveNameFromRepoUrl(repoUrl);

  return "Workspace";
}

function buildManagedProjectDefaults(declaration: PluginManagedProjectDeclaration) {
  return {
    projectKey: declaration.projectKey,
    displayName: declaration.displayName,
    description: declaration.description ?? null,
    status: declaration.status ?? "in_progress",
    color: declaration.color ?? null,
    settings: declaration.settings ?? {},
  };
}

export function resolveProjectNameForUniqueShortname(
  requestedName: string,
  existingProjects: ProjectShortnameRow[],
  options?: ResolveProjectNameOptions,
): string {
  const requestedShortname = normalizeProjectUrlKey(requestedName);
  if (!requestedShortname) return requestedName;
  // 非 ASCII 名称在 deriveProjectUrlKey 中已有 UUID 后缀保证唯一性，无需进一步处理
  if (hasNonAsciiContent(requestedName)) return requestedName;

  const usedShortnames = new Set(
    existingProjects
      .filter((project) => !(options?.excludeProjectId && project.id === options.excludeProjectId))
      .map((project) => normalizeProjectUrlKey(project.name))
      .filter((value): value is string => value !== null),
  );
  if (!usedShortnames.has(requestedShortname)) return requestedName;

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidateName = `${requestedName} ${suffix}`;
    const candidateShortname = normalizeProjectUrlKey(candidateName);
    if (candidateShortname && !usedShortnames.has(candidateShortname)) {
      return candidateName;
    }
  }

  // 最终兜底：极端冲突情况下使用时间戳后缀保证唯一
  return `${requestedName} ${Date.now()}`;
}

async function ensureSinglePrimaryWorkspace(
  dbOrTx: any,
  input: {
    companyId: string;
    projectId: string;
    keepWorkspaceId: string;
  },
) {
  await dbOrTx
    .update(projectWorkspaces)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
      ),
    );

  await dbOrTx
    .update(projectWorkspaces)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(
      and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
        eq(projectWorkspaces.id, input.keepWorkspaceId),
      ),
    );
}

export function projectService(db: Db) {
  const createProject = async (
    companyId: string,
    data: Omit<typeof projects.$inferInsert, "companyId"> & { goalIds?: string[] },
  ): Promise<ProjectWithGoals> => {
    const { goalIds: inputGoalIds, ...projectData } = data;
    const ids = resolveGoalIds({ goalIds: inputGoalIds, goalId: projectData.goalId });

    // 未指定颜色时自动分配：优先使用未用过的颜色，颜色用完后退化为取模轮转
    if (!projectData.color) {
      const existing = await db.select({ color: projects.color }).from(projects).where(eq(projects.companyId, companyId));
      const usedColors = new Set(existing.map((r) => r.color).filter(Boolean));
      const nextColor = PROJECT_COLORS.find((c) => !usedColors.has(c)) ?? PROJECT_COLORS[existing.length % PROJECT_COLORS.length];
      projectData.color = nextColor;
    }

    const existingProjects = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.companyId, companyId));
    projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects);

    // 同时写入旧版 goalId 列（取第一个目标），保持向后兼容
    const legacyGoalId = ids && ids.length > 0 ? ids[0] : projectData.goalId ?? null;

    const row = await db
      .insert(projects)
      .values({ ...projectData, goalId: legacyGoalId, companyId })
      .returning()
      .then((rows) => rows[0]);

    if (ids && ids.length > 0) {
      await syncGoalLinks(db, row.id, companyId, ids);
    }

    const [withGoals] = await attachGoals(db, [row]);
    const [enriched] = withGoals ? await attachWorkspaces(db, [withGoals]) : [];
    return enriched!;
  };

  const getProjectById = async (id: string): Promise<ProjectWithGoals | null> => {
    // projects.id 是 UUID 列：非 UUID 引用（如改名后残留的 /projects/onboarding）
    // 此处已无法解析为短名称，直接当作不存在返回 null，避免把字符串塞进 UUID 查询触发 Postgres 500。
    if (!isUuidLike(id)) return null;
    const row = await db
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [withGoals] = await attachGoals(db, [row]);
    if (!withGoals) return null;
    const [enriched] = await attachWorkspaces(db, [withGoals]);
    return enriched ?? null;
  };

  return {
    list: async (companyId: string): Promise<ProjectWithGoals[]> => {
      const rows = await db.select().from(projects).where(eq(projects.companyId, companyId));
      const withGoals = await attachGoals(db, rows);
      return attachWorkspaces(db, withGoals);
    },

    listByIds: async (companyId: string, ids: string[]): Promise<ProjectWithGoals[]> => {
      const dedupedIds = [...new Set(ids)];
      if (dedupedIds.length === 0) return [];
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, dedupedIds)));
      const withGoals = await attachGoals(db, rows);
      const withWorkspaces = await attachWorkspaces(db, withGoals);
      const byId = new Map(withWorkspaces.map((project) => [project.id, project]));
      return dedupedIds.map((id) => byId.get(id)).filter((project): project is ProjectWithGoals => Boolean(project));
    },

    getById: getProjectById,

    // 通过插件声明解析/创建托管项目：实现插件的 project 资源声明式生命周期管理
    resolveManagedProject: async (input: {
      companyId: string;
      pluginId: string;
      pluginKey: string;
      projectKey: string;
      reset?: boolean;
      createIfMissing?: boolean;
    }): Promise<PluginManagedProjectResolution> => {
      const plugin = await db
        .select({ id: plugins.id, pluginKey: plugins.pluginKey, manifestJson: plugins.manifestJson })
        .from(plugins)
        .where(eq(plugins.id, input.pluginId))
        .then((rows) => rows[0] ?? null);
      if (!plugin || plugin.pluginKey !== input.pluginKey) {
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: null,
          project: null,
          status: "missing",
        };
      }

      const declaration = plugin.manifestJson.projects?.find((project) => project.projectKey === input.projectKey);
      if (!declaration) {
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: null,
          project: null,
          status: "missing",
        };
      }

      const defaults = buildManagedProjectDefaults(declaration);
      const existingBinding = await db
        .select()
        .from(pluginManagedResources)
        .where(and(
          eq(pluginManagedResources.companyId, input.companyId),
          eq(pluginManagedResources.pluginId, input.pluginId),
          eq(pluginManagedResources.resourceKind, "project"),
          eq(pluginManagedResources.resourceKey, input.projectKey),
        ))
        .then((rows) => rows[0] ?? null);

      if (existingBinding) {
        const existingProject = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.companyId, input.companyId), eq(projects.id, existingBinding.resourceId)))
          .then((rows) => rows[0] ?? null);
        if (existingProject) {
          if (input.reset) {
            await db
              .update(projects)
              .set({
                name: declaration.displayName,
                description: declaration.description ?? null,
                status: declaration.status ?? "in_progress",
                color: declaration.color ?? null,
                updatedAt: new Date(),
              })
              .where(and(eq(projects.companyId, input.companyId), eq(projects.id, existingBinding.resourceId)));
          }
          if (input.createIfMissing !== false) {
            await db
              .update(pluginManagedResources)
              .set({ defaultsJson: defaults, updatedAt: new Date() })
              .where(eq(pluginManagedResources.id, existingBinding.id));
          }
          const project = await getProjectById(existingBinding.resourceId);
          return {
            pluginKey: input.pluginKey,
            resourceKind: "project",
            resourceKey: input.projectKey,
            companyId: input.companyId,
            projectId: project?.id ?? existingBinding.resourceId,
            project: project as import("@paperclipai/shared").Project | null,
            status: input.reset ? "reset" : "resolved",
          };
        }

        if (input.createIfMissing === false) {
          return {
            pluginKey: input.pluginKey,
            resourceKind: "project",
            resourceKey: input.projectKey,
            companyId: input.companyId,
            projectId: null,
            project: null,
            status: "missing",
          };
        }

        const project = await createProject(input.companyId, {
          name: declaration.displayName,
          description: declaration.description ?? null,
          status: declaration.status ?? "in_progress",
          color: declaration.color ?? undefined,
        });
        await db
          .update(pluginManagedResources)
          .set({ resourceId: project.id, defaultsJson: defaults, updatedAt: new Date() })
          .where(eq(pluginManagedResources.id, existingBinding.id));
        const hydrated = await getProjectById(project.id);
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: hydrated?.id ?? project.id,
          project: hydrated as import("@paperclipai/shared").Project | null,
          status: "relinked",
        };
      }

      if (input.createIfMissing === false) {
        return {
          pluginKey: input.pluginKey,
          resourceKind: "project",
          resourceKey: input.projectKey,
          companyId: input.companyId,
          projectId: null,
          project: null,
          status: "missing",
        };
      }

      const project = await createProject(input.companyId, {
        name: declaration.displayName,
        description: declaration.description ?? null,
        status: declaration.status ?? "in_progress",
        color: declaration.color ?? undefined,
      });
      await db.insert(pluginManagedResources).values({
        companyId: input.companyId,
        pluginId: input.pluginId,
        pluginKey: input.pluginKey,
        resourceKind: "project",
        resourceKey: input.projectKey,
        resourceId: project.id,
        defaultsJson: defaults,
      });
      const hydrated = await getProjectById(project.id);
      return {
        pluginKey: input.pluginKey,
        resourceKind: "project",
        resourceKey: input.projectKey,
        companyId: input.companyId,
        projectId: hydrated?.id ?? project.id,
        project: hydrated as import("@paperclipai/shared").Project | null,
        status: "created",
      };
    },

    create: createProject,

    update: async (
      id: string,
      data: Partial<typeof projects.$inferInsert> & { goalIds?: string[] },
    ): Promise<ProjectWithGoals | null> => {
      const { goalIds: inputGoalIds, ...projectData } = data;
      const ids = resolveGoalIds({ goalIds: inputGoalIds, goalId: projectData.goalId });
      const existingProject = await db
        .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existingProject) return null;

      if (projectData.name !== undefined) {
        const existingShortname = normalizeProjectUrlKey(existingProject.name);
        const nextShortname = normalizeProjectUrlKey(projectData.name);
        if (existingShortname !== nextShortname) {
          const existingProjects = await db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(eq(projects.companyId, existingProject.companyId));
          projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects, {
            excludeProjectId: id,
          });
        }
      }

      // 保持旧版 goalId 列同步：更新时根据 goalIds 数组重新设置 goalId 列
      const updates: Partial<typeof projects.$inferInsert> = {
        ...projectData,
        updatedAt: new Date(),
      };
      if (ids !== undefined) {
        updates.goalId = ids.length > 0 ? ids[0] : null;
      }

      const row = await db
        .update(projects)
        .set(updates)
        .where(eq(projects.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      if (ids !== undefined) {
        await syncGoalLinks(db, id, row.companyId, ids);
      }

      const [withGoals] = await attachGoals(db, [row]);
      const [enriched] = withGoals ? await attachWorkspaces(db, [withGoals]) : [];
      return enriched ?? null;
    },

    // 清空环境中选：当环境被删除时，将所有引用该环境的项目策略重置为 null
    clearExecutionWorkspaceEnvironmentSelection: async (companyId: string, environmentId: string) => {
      const rows = await db
        .select({
          id: projects.id,
          executionWorkspacePolicy: projects.executionWorkspacePolicy,
        })
        .from(projects)
        .where(eq(projects.companyId, companyId));

      let cleared = 0;
      for (const row of rows) {
        const policy = parseProjectExecutionWorkspacePolicy(row.executionWorkspacePolicy);
        if (policy?.environmentId !== environmentId) continue;

        await db
          .update(projects)
          .set({
            executionWorkspacePolicy: {
              ...policy,
              environmentId: null,
            },
            updatedAt: new Date(),
          })
          .where(eq(projects.id, row.id));
        cleared += 1;
      }

      return cleared;
    },

    remove: (id: string) =>
      db
        .delete(projects)
        .where(eq(projects.id, id))
        .returning()
        .then((rows) => {
          const row = rows[0] ?? null;
          if (!row) return null;
          return { ...row, urlKey: deriveProjectUrlKey(row.name, row.id) };
        }),

    listWorkspaces: async (projectId: string): Promise<ProjectWorkspace[]> => {
      const rows = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
      if (rows.length === 0) return [];
      const runtimeServicesByWorkspaceId = await listCurrentRuntimeServicesForProjectWorkspaces(
        db,
        rows[0]!.companyId,
        rows.map((workspace) => workspace.id),
      );
      return rows.map((row) =>
        toWorkspace(
          row,
          (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
        ),
      );
    },

    // 创建工作区：自动推导 sourceType 和名称，校验远程管理工作区的必填字段
    createWorkspace: async (
      projectId: string,
      data: CreateWorkspaceInput,
    ): Promise<ProjectWorkspace | null> => {
      const project = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .then((rows) => rows[0] ?? null);
      if (!project) return null;

      const cwd = normalizeWorkspaceCwd(data.cwd);
      const repoUrl = readNonEmptyString(data.repoUrl);
      // sourceType 未指定时根据已有信息推导：优先 git_repo > local_path > remote_managed
      const sourceType = readNonEmptyString(data.sourceType) ?? (repoUrl ? "git_repo" : cwd ? "local_path" : "remote_managed");
      const remoteWorkspaceRef = readNonEmptyString(data.remoteWorkspaceRef);
      // 远程管理工作区必须有 remoteWorkspaceRef 或 repoUrl，否则无法确定工作区位置
      if (sourceType === "remote_managed") {
        if (!remoteWorkspaceRef && !repoUrl) return null;
      } else if (!cwd && !repoUrl) {
        return null;
      }
      const name = deriveWorkspaceName({
        name: data.name,
        cwd,
        repoUrl,
      });

      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .orderBy(asc(projectWorkspaces.createdAt))
        .then((rows) => rows);

      const shouldBePrimary = data.isPrimary === true || existing.length === 0;
      // 事务中完成主工作区切换 + 创建：确保 isPrimary 互斥约束不因并发而破坏
      const created = await db.transaction(async (tx) => {
        if (shouldBePrimary) {
          // 先将所有工作区设为非主，再将新工作区设为唯一主工作区
          await tx
            .update(projectWorkspaces)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(projectWorkspaces.companyId, project.companyId),
                eq(projectWorkspaces.projectId, projectId),
              ),
            );
        }

        const row = await tx
          .insert(projectWorkspaces)
          .values({
            companyId: project.companyId,
            projectId,
            name,
            sourceType,
            cwd: cwd ?? null,
            repoUrl: repoUrl ?? null,
            repoRef: readNonEmptyString(data.repoRef),
            defaultRef: readNonEmptyString(data.defaultRef) ?? readNonEmptyString(data.repoRef),
            visibility: readNonEmptyString(data.visibility) ?? "default",
            setupCommand: readNonEmptyString(data.setupCommand),
            cleanupCommand: readNonEmptyString(data.cleanupCommand),
            remoteProvider: readNonEmptyString(data.remoteProvider),
            remoteWorkspaceRef,
            sharedWorkspaceKey: readNonEmptyString(data.sharedWorkspaceKey),
            metadata:
              data.runtimeConfig !== undefined
                ? mergeProjectWorkspaceRuntimeConfig(
                    (data.metadata as Record<string, unknown> | null | undefined) ?? null,
                    data.runtimeConfig ?? null,
                  )
                : (data.metadata as Record<string, unknown> | null | undefined) ?? null,
            isPrimary: shouldBePrimary,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        return row;
      });

      return created ? toWorkspace(created) : null;
    },

    // 更新工作区：支持部分字段更新、主工作区切换、数据完整性约束校验
    updateWorkspace: async (
      projectId: string,
      workspaceId: string,
      data: UpdateWorkspaceInput,
    ): Promise<ProjectWorkspace | null> => {
      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, workspaceId),
            eq(projectWorkspaces.projectId, projectId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const nextCwd =
        data.cwd !== undefined
          ? normalizeWorkspaceCwd(data.cwd)
          : normalizeWorkspaceCwd(existing.cwd);
      const nextRepoUrl =
        data.repoUrl !== undefined
          ? readNonEmptyString(data.repoUrl)
          : readNonEmptyString(existing.repoUrl);
      const nextSourceType =
        data.sourceType !== undefined
          ? readNonEmptyString(data.sourceType)
          : readNonEmptyString(existing.sourceType);
      const nextRemoteWorkspaceRef =
        data.remoteWorkspaceRef !== undefined
          ? readNonEmptyString(data.remoteWorkspaceRef)
          : readNonEmptyString(existing.remoteWorkspaceRef);
      // 校验 sourceType 约束：远程管理必须有引用，其他类型必须至少有一个路径/仓库
      if (nextSourceType === "remote_managed") {
        if (!nextRemoteWorkspaceRef && !nextRepoUrl) return null;
      } else if (!nextCwd && !nextRepoUrl) {
        return null;
      }

      const patch: Partial<typeof projectWorkspaces.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (data.name !== undefined) patch.name = deriveWorkspaceName({ name: data.name, cwd: nextCwd, repoUrl: nextRepoUrl });
      // cwd 或 repoUrl 变化时自动重推名称，避免名称与路径脱节
      if (data.name === undefined && (data.cwd !== undefined || data.repoUrl !== undefined)) {
        patch.name = deriveWorkspaceName({ cwd: nextCwd, repoUrl: nextRepoUrl });
      }
      if (data.cwd !== undefined) patch.cwd = nextCwd ?? null;
      if (data.repoUrl !== undefined) patch.repoUrl = nextRepoUrl ?? null;
      if (data.repoRef !== undefined) patch.repoRef = readNonEmptyString(data.repoRef);
      if (data.sourceType !== undefined && nextSourceType) patch.sourceType = nextSourceType;
      if (data.defaultRef !== undefined) patch.defaultRef = readNonEmptyString(data.defaultRef);
      if (data.visibility !== undefined && readNonEmptyString(data.visibility)) {
        patch.visibility = readNonEmptyString(data.visibility)!;
      }
      if (data.setupCommand !== undefined) patch.setupCommand = readNonEmptyString(data.setupCommand);
      if (data.cleanupCommand !== undefined) patch.cleanupCommand = readNonEmptyString(data.cleanupCommand);
      if (data.remoteProvider !== undefined) patch.remoteProvider = readNonEmptyString(data.remoteProvider);
      if (data.remoteWorkspaceRef !== undefined) patch.remoteWorkspaceRef = nextRemoteWorkspaceRef;
      if (data.sharedWorkspaceKey !== undefined) patch.sharedWorkspaceKey = readNonEmptyString(data.sharedWorkspaceKey);
      if (data.metadata !== undefined || data.runtimeConfig !== undefined) {
        // 合并运行时配置到 metadata 中，避免覆盖其他已有元数据
        patch.metadata =
          data.runtimeConfig !== undefined
            ? mergeProjectWorkspaceRuntimeConfig(
                data.metadata !== undefined
                  ? (data.metadata as Record<string, unknown> | null | undefined)
                  : ((existing.metadata as Record<string, unknown> | null | undefined) ?? null),
                data.runtimeConfig ?? null,
              )
            : data.metadata;
      }

      // 事务中处理主工作区切换：保证 isPrimary 互斥且始终存在一个主工作区
      const updated = await db.transaction(async (tx) => {
        if (data.isPrimary === true) {
          // 先将所有工作区设为非主，再单独设置目标工作区为主
          await tx
            .update(projectWorkspaces)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(projectWorkspaces.companyId, existing.companyId),
                eq(projectWorkspaces.projectId, projectId),
              ),
            );
          patch.isPrimary = true;
        } else if (data.isPrimary === false) {
          patch.isPrimary = false;
        }

        const row = await tx
          .update(projectWorkspaces)
          .set(patch)
          .where(eq(projectWorkspaces.id, workspaceId))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) return null;

        if (row.isPrimary) return row;

        const hasPrimary = await tx
          .select({ id: projectWorkspaces.id })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, row.companyId),
              eq(projectWorkspaces.projectId, row.projectId),
              eq(projectWorkspaces.isPrimary, true),
            ),
          )
          .then((rows) => rows[0] ?? null);

        // 当前工作区不再是主工作区且项目无主工作区时，自动推选最早创建的工作区为主
        if (!hasPrimary) {
          const nextPrimaryCandidate = await tx
            .select({ id: projectWorkspaces.id })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, row.companyId),
                eq(projectWorkspaces.projectId, row.projectId),
                eq(projectWorkspaces.id, row.id),
              ),
            )
            .then((rows) => rows[0] ?? null);
          const alternateCandidate = await tx
            .select({ id: projectWorkspaces.id })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, row.companyId),
                eq(projectWorkspaces.projectId, row.projectId),
              ),
            )
            .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
            .then((rows) => rows.find((candidate) => candidate.id !== row.id) ?? null);

          await ensureSinglePrimaryWorkspace(tx, {
            companyId: row.companyId,
            projectId: row.projectId,
            keepWorkspaceId: alternateCandidate?.id ?? nextPrimaryCandidate?.id ?? row.id,
          });
          const refreshed = await tx
            .select()
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.id, row.id))
            .then((rows) => rows[0] ?? row);
          return refreshed;
        }

        return row;
      });

      return updated ? toWorkspace(updated) : null;
    },

    // 删除工作区：若被删除的是主工作区，自动将最早创建的其他工作区递补为主工作区
    removeWorkspace: async (projectId: string, workspaceId: string): Promise<ProjectWorkspace | null> => {
      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, workspaceId),
            eq(projectWorkspaces.projectId, projectId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const removed = await db.transaction(async (tx) => {
        const row = await tx
          .delete(projectWorkspaces)
          .where(eq(projectWorkspaces.id, workspaceId))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) return null;

        // 非主工作区直接删除，不需要处理递补逻辑
        if (!row.isPrimary) return row;

        // 查找最早创建的工作区作为新的主工作区
        const next = await tx
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, row.companyId),
              eq(projectWorkspaces.projectId, row.projectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (next) {
          await ensureSinglePrimaryWorkspace(tx, {
            companyId: row.companyId,
            projectId: row.projectId,
            keepWorkspaceId: next.id,
          });
        }

        return row;
      });

      return removed ? toWorkspace(removed) : null;
    },

    // 根据引用解析项目：优先 UUID 匹配，其次短名称匹配；多个同名短名称返回 ambiguous
    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { project: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const row = await db
          .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
          .from(projects)
          .where(and(eq(projects.id, raw), eq(projects.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!row) return { project: null, ambiguous: false } as const;
        return {
          project: { id: row.id, companyId: row.companyId, urlKey: deriveProjectUrlKey(row.name, row.id) },
          ambiguous: false,
        } as const;
      }

      const urlKey = normalizeProjectUrlKey(raw);
      if (!urlKey) {
        return { project: null, ambiguous: false } as const;
      }

      const rows = await db
        .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
        .from(projects)
        .where(eq(projects.companyId, companyId));
      const matches = rows.filter((row) => deriveProjectUrlKey(row.name, row.id) === urlKey);
      if (matches.length === 1) {
        const match = matches[0]!;
        return {
          project: { id: match.id, companyId: match.companyId, urlKey: deriveProjectUrlKey(match.name, match.id) },
          ambiguous: false,
        } as const;
      }
      if (matches.length > 1) {
        return { project: null, ambiguous: true } as const;
      }
      return { project: null, ambiguous: false } as const;
    },
  };
}
