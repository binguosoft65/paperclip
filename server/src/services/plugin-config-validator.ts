/**
 * @fileoverview Validates plugin instance configuration against its JSON Schema.
 *
 * Uses Ajv to validate `configJson` values against the `instanceConfigSchema`
 * declared in a plugin's manifest. This ensures that invalid configuration is
 * rejected at the API boundary, not discovered later at worker startup.
 *
 * ── 设计选择：Ajv vs Zod ──
 * manifest 验证使用 Zod，但 config 验证使用 Ajv。原因：
 * 1) instanceConfigSchema 来自插件 manifest，是 JSON Schema 格式，
 *    Zod 不支持直接解析 JSON Schema（需要转换）。
 * 2) Ajv 是 JSON Schema 的参考实现，支持 JSON Schema 的所有特性
 *    （$ref、if/then/else 等），这些 Zod 不完全支持。
 * 3) ajv-formats 提供了 format 关键字支持（如 email、uri）。
 *
 * ── secret-ref format ──
 * 插件可以声明配置字段类型为 "secret-ref"，表示该字段的值应该
 * 是一个 Paperclip 秘密的 UUID，而非明文值。这个 format 只做 UI
 * 层面的提示 —— UUID 的实际验证在 secret 解析器中完成。
 *
 * @module server/services/plugin-config-validator
 */

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type { JsonSchema } from "@paperclipai/shared";

export interface ConfigValidationResult {
  valid: boolean;
  errors?: { field: string; message: string }[];
}

/**
 * Validate a config object against a JSON Schema.
 *
 * @param configJson - The configuration values to validate.
 * @param schema - The JSON Schema from the plugin manifest's `instanceConfigSchema`.
 * @returns Validation result with structured field errors on failure.
 */
export function validateInstanceConfig(
  configJson: Record<string, unknown>,
  schema: JsonSchema,
): ConfigValidationResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvCtor = (Ajv as any).default ?? Ajv;
  const ajv = new AjvCtor({ allErrors: true });
  // ajv-formats v3 default export is a FormatsPlugin object; call it as a plugin.
  const applyFormats = (addFormats as any).default ?? addFormats;
  applyFormats(ajv);
  // Register the secret-ref format used by plugin manifests to mark fields that
  // hold a Paperclip secret UUID rather than a raw value. The format is a UI
  // hint only — UUID validation happens in the secrets handler at resolve time.
  ajv.addFormat("secret-ref", { validate: () => true });
  const validate = ajv.compile(schema);
  const valid = validate(configJson);

  if (valid) {
    return { valid: true };
  }

  const errors = (validate.errors ?? []).map((err: ErrorObject) => ({
    field: err.instancePath || "/",
    message: err.message ?? "validation failed",
  }));

  return { valid: false, errors };
}
