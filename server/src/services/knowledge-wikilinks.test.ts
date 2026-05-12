import { describe, it, expect } from "vitest";
import { parseWikilinks } from "./knowledge-wikilinks.js";

describe("parseWikilinks", () => {
  it("提取单个 UUID wikilink", () => {
    const content = "见 [[a3f1c0d4-5e6f-7890-abcd-ef1234567890]] 详解";
    expect(parseWikilinks(content)).toEqual(["a3f1c0d4-5e6f-7890-abcd-ef1234567890"]);
  });

  it("提取多个 UUID wikilink，按出现顺序去重", () => {
    const content = "[[a3f1c0d4-5e6f-7890-abcd-ef1234567890]] 和 [[b7d2c0d4-5e6f-7890-abcd-ef1234567890]]，再次 [[a3f1c0d4-5e6f-7890-abcd-ef1234567890]]";
    expect(parseWikilinks(content)).toEqual([
      "a3f1c0d4-5e6f-7890-abcd-ef1234567890",
      "b7d2c0d4-5e6f-7890-abcd-ef1234567890",
    ]);
  });

  it("忽略非 UUID 的 wikilink（[[Title]] 留给后续 Phase）", () => {
    const content = "[[Some Title]] 不应被解析";
    expect(parseWikilinks(content)).toEqual([]);
  });

  it("忽略代码块内的 wikilink（避免误抓示例）", () => {
    const content = "```\n[[a3f1c0d4-5e6f-7890-abcd-ef1234567890]]\n```\n正文 [[b7d2c0d4-5e6f-7890-abcd-ef1234567890]]";
    expect(parseWikilinks(content)).toEqual(["b7d2c0d4-5e6f-7890-abcd-ef1234567890"]);
  });

  it("空内容返回空数组", () => {
    expect(parseWikilinks("")).toEqual([]);
  });

  it("UUID 大小写归一化为小写", () => {
    const content = "[[A3F1C0D4-5E6F-7890-ABCD-EF1234567890]]";
    expect(parseWikilinks(content)).toEqual(["a3f1c0d4-5e6f-7890-abcd-ef1234567890"]);
  });
});
