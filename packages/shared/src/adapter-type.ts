import { z } from "zod";
import { AGENT_ADAPTER_TYPES } from "./constants.js";

/**
 * Agent 适配器类型校验器。
 * 内建类型限定在 AGENT_ADAPTER_TYPES 列表中（process/http/acpx_local 等），
 * 但允许传入任意非空字符串以支持运行时注册的外部适配器。
 */
export const agentAdapterTypeSchema = z
  .string()
  .trim()
  .min(1)
  .default("process")
  .describe(`Known built-in adapters: ${AGENT_ADAPTER_TYPES.join(", ")}. External adapters may register additional non-empty string types at runtime.`);

/** 可选的适配器类型：不提供时使用默认值 */
export const optionalAgentAdapterTypeSchema = z
  .string()
  .trim()
  .min(1)
  .optional();
