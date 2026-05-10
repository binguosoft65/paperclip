// 统一错误处理中间件：将异常分为三个层级处理：
// 1. HttpError（已知业务异常）→ 返回对应状态码
// 2. ZodError（请求体校验失败）→ 统一返回 400 + 字段级详情
// 3. 未知异常 → 兜底返回 500，记录完整上下文用于调试
import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";

// 挂载到响应对象上的错误上下文结构体——不直接返回给客户端，而是供 logger.ts 在写日志时取用
export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

// 将错误信息及其请求上下文挂载到响应对象上，供 HTTP 日志记录器输出详细错误日志
function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  // 已知业务异常（HttpError）：携带状态码，>=500 时记录上下文并上报遥测
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      // 服务端错误需记录完整上下文和原始异常，用于调试和遥测
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  // Zod 校验错误：统一返回 400，附带字段级别的错误详情
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  // 未知异常兜底：统一视为 500 内部错误，非 Error 对象也包装为 Error 以确保堆栈信息可用
  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  // 对所有未捕获的 500 错误上报遥测，以便发现和追踪服务端异常
  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });

  res.status(500).json({ error: "Internal server error" });
}
