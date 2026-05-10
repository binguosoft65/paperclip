import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";

// 请求体校验中间件工厂——用 Zod schema 解析 req.body，失败时自动抛出 ZodError，
// 由 error-handler.ts 统一捕获并返回 400 + 字段级错误详情
export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body);
    next();
  };
}
