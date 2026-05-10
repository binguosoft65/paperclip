import { useEffect, useRef, useState } from "react";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { X } from "lucide-react";
import { cn } from "../lib/utils";
import { useTranslation } from "react-i18next";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

type Row = {
  key: string;
  source: "plain" | "secret";
  plainValue: string;
  secretId: string;
};

function toRows(rec: Record<string, EnvBinding> | null | undefined): Row[] {
  if (!rec || typeof rec !== "object") {
    return [{ key: "", source: "plain", plainValue: "", secretId: "" }];
  }
  const entries = Object.entries(rec).map(([key, binding]) => {
    if (typeof binding === "string") {
      return { key, source: "plain" as const, plainValue: binding, secretId: "" };
    }
    if (
      typeof binding === "object" &&
      binding !== null &&
      "type" in binding &&
      (binding as { type?: unknown }).type === "secret_ref"
    ) {
      const record = binding as { secretId?: unknown };
      return {
        key,
        source: "secret" as const,
        plainValue: "",
        secretId: typeof record.secretId === "string" ? record.secretId : "",
      };
    }
    if (
      typeof binding === "object" &&
      binding !== null &&
      "type" in binding &&
      (binding as { type?: unknown }).type === "plain"
    ) {
      const record = binding as { value?: unknown };
      return {
        key,
        source: "plain" as const,
        plainValue: typeof record.value === "string" ? record.value : "",
        secretId: "",
      };
    }
    return { key, source: "plain" as const, plainValue: "", secretId: "" };
  });
  return [...entries, { key: "", source: "plain", plainValue: "", secretId: "" }];
}

// 环境变量编辑器：允许用户为 Agent 或 Project 配置环境变量。
// 每行包含三个部分：
// 1. 变量名（key）
// 2. 来源选择：明文（plain）或密钥引用（secret）
// 3. 对应的值或已存储的密钥
// 支持 "密封"（seal）操作——将明文值自动转为密钥引用，提高安全性。
export function EnvVarEditor({
  value,
  secrets,
  onCreateSecret,
  onChange,
}: {
  value: Record<string, EnvBinding>;
  secrets: CompanySecret[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  onChange: (env: Record<string, EnvBinding> | undefined) => void;
}) {
  const { t } = useTranslation("common");
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [sealError, setSealError] = useState<string | null>(null);
  const valueRef = useRef(value);
  const emittingRef = useRef(false);

  useEffect(() => {
    if (emittingRef.current) {
      emittingRef.current = false;
      valueRef.current = value;
      return;
    }
    if (value !== valueRef.current) {
      valueRef.current = value;
      setRows(toRows(value));
    }
  }, [value]);

  // 将 Row 数组序列化为 Record<string, EnvBinding> 并向上传递。
  // 如果所有行都为空（无 key），传递 undefined 表示未设置任何环境变量。
  // 注意：secret_ref 行的 secretId 为空时会自动降级为 plain 类型——这是一种容错设计，
  // 防止用户选择了 "Secret" 来源但未选择具体密钥时产生无效的绑定。
  function emit(nextRows: Row[]) {
    const rec: Record<string, EnvBinding> = {};
    for (const row of nextRows) {
      const key = row.key.trim();
      if (!key) continue;
      if (row.source === "secret") {
        if (row.secretId) {
          rec[key] = { type: "secret_ref", secretId: row.secretId, version: "latest" };
        } else {
          rec[key] = { type: "plain", value: row.plainValue };
        }
      } else {
        rec[key] = { type: "plain", value: row.plainValue };
      }
    }
    emittingRef.current = true;
    onChange(Object.keys(rec).length > 0 ? rec : undefined);
  }

  // 更新某一行后，如果最后一行已被填写，自动追加一个空行以便用户继续添加新变量。
  // 这是典型的"自动追加行"交互模式——用户在最后一行输入时无需手动点击"添加行"按钮。
  function updateRow(index: number, patch: Partial<Row>) {
    const withPatch = rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
    if (
      withPatch[withPatch.length - 1].key ||
      withPatch[withPatch.length - 1].plainValue ||
      withPatch[withPatch.length - 1].secretId
    ) {
      withPatch.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(withPatch);
    emit(withPatch);
  }

  function removeRow(index: number) {
    const next = rows.filter((_, rowIndex) => rowIndex !== index);
    if (
      next.length === 0 ||
      next[next.length - 1].key ||
      next[next.length - 1].plainValue ||
      next[next.length - 1].secretId
    ) {
      next.push({ key: "", source: "plain", plainValue: "", secretId: "" });
    }
    setRows(next);
    emit(next);
  }

  function defaultSecretName(key: string) {
    return key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  }

  // "密封"操作：将一行的明文值转为密钥引用。
  // 流程：弹出命名对话框 -> 调用 API 创建密钥 -> 将行切换为 secret_ref 模式。
  // 这种"一键转密钥"的设计降低了用户使用密钥管理的门槛——用户可以先快速输入明文，
  // 后续再通过密封操作提升安全性，而无需预先切换到密钥管理页面创建密钥。
  async function sealRow(index: number) {
    const row = rows[index];
    if (!row) return;
    const key = row.key.trim();
    const plain = row.plainValue;
    if (!key || plain.length === 0) return;

    const suggested = defaultSecretName(key) || "secret";
    const name = window.prompt("Secret name", suggested)?.trim();
    if (!name) return;

    try {
      setSealError(null);
      const created = await onCreateSecret(name, plain);
      updateRow(index, { source: "secret", secretId: created.id });
    } catch (error) {
      setSealError(error instanceof Error ? error.message : t("envVarEditor.createSecretFailed"));
    }
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, index) => {
        const isTrailing =
          index === rows.length - 1 &&
          !row.key &&
          !row.plainValue &&
          !row.secretId;
        return (
          <div key={index} className="flex items-center gap-1.5">
            <input
              className={cn(inputClass, "flex-[2]")}
              placeholder={t("envVarEditor.keyPlaceholder")}
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
            />
            <select
              className={cn(inputClass, "flex-[1] bg-background")}
              value={row.source}
              onChange={(event) =>
                updateRow(index, {
                  source: event.target.value === "secret" ? "secret" : "plain",
                  ...(event.target.value === "plain" ? { secretId: "" } : {}),
                })
              }
            >
              <option value="plain">{t("envVarEditor.plain")}</option>
              <option value="secret">{t("envVarEditor.secret")}</option>
            </select>
            {row.source === "secret" ? (
              <>
                <select
                  className={cn(inputClass, "flex-[3] bg-background")}
                  value={row.secretId}
                  onChange={(event) => updateRow(index, { secretId: event.target.value })}
                >
                  <option value="">{t("envVarEditor.selectSecret")}</option>
                  {secrets.map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(index)}
                  disabled={!row.key.trim() || !row.plainValue}
                  title={t("envVarEditor.createSecretTitle")}
                >
                  {t("envVarEditor.createSecret")}
                </button>
              </>
            ) : (
              <>
                <input
                  className={cn(inputClass, "flex-[3]")}
                  placeholder={t("envVarEditor.valuePlaceholder")}
                  value={row.plainValue}
                  onChange={(event) => updateRow(index, { plainValue: event.target.value })}
                />
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(index)}
                  disabled={!row.key.trim() || !row.plainValue}
                  title={t("envVarEditor.sealTitle")}
                >
                  {t("envVarEditor.seal")}
                </button>
              </>
            )}
            {!isTrailing ? (
              <button
                type="button"
                className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                onClick={() => removeRow(index)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="w-[26px] shrink-0" />
            )}
          </div>
        );
      })}
      {sealError && <p className="text-[11px] text-destructive">{sealError}</p>}
      <p className="text-[11px] text-muted-foreground/60">
        {t("envVarEditor.autoInject")}
      </p>
    </div>
  );
}
