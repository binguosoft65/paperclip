import { describe, it, expect, vi, beforeEach } from "vitest";

// 把 OpenAI SDK 整个 mock 掉
const mockCreateEmbedding = vi.fn();
const mockCreateChat = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    embeddings = { create: mockCreateEmbedding };
    chat = { completions: { create: mockCreateChat } };
    constructor() {}
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // 清缓存：llm-wiki 内部 cachedClient 是 module-level
  vi.resetModules();
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_CHAT_MODEL;
});

describe("llmWikiService.completeChat", () => {
  it("调 chat.completions.create 并返回 message.content", async () => {
    const { llmWikiService } = await import("./llm-wiki.js");
    mockCreateChat.mockResolvedValueOnce({
      choices: [{ message: { content: "hello world", role: "assistant" } }],
    });
    const svc = llmWikiService({} as any);
    const out = await svc.completeChat({
      system: "you are helpful",
      user: "say hi",
    });
    expect(out).toBe("hello world");
    expect(mockCreateChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "say hi" },
        ],
      }),
    );
  });

  it("jsonMode=true 时传 response_format json_object", async () => {
    const { llmWikiService } = await import("./llm-wiki.js");
    mockCreateChat.mockResolvedValueOnce({
      choices: [{ message: { content: "{}" } }],
    });
    const svc = llmWikiService({} as any);
    await svc.completeChat({ system: "s", user: "u", jsonMode: true });
    expect(mockCreateChat).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: { type: "json_object" },
      }),
    );
  });

  it("OPENAI_CHAT_MODEL env 覆盖默认 model", async () => {
    process.env.OPENAI_CHAT_MODEL = "qwen-plus";
    const { llmWikiService } = await import("./llm-wiki.js");
    mockCreateChat.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
    });
    const svc = llmWikiService({} as any);
    await svc.completeChat({ system: "s", user: "u" });
    expect(mockCreateChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "qwen-plus" }),
    );
  });

  it("缺 OPENAI_API_KEY 时抛清晰错误", async () => {
    delete process.env.OPENAI_API_KEY;
    const { llmWikiService } = await import("./llm-wiki.js");
    const svc = llmWikiService({} as any);
    await expect(svc.completeChat({ system: "s", user: "u" })).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it("响应没有 choices[0].message.content 时抛错", async () => {
    const { llmWikiService } = await import("./llm-wiki.js");
    mockCreateChat.mockResolvedValueOnce({ choices: [] });
    const svc = llmWikiService({} as any);
    await expect(svc.completeChat({ system: "s", user: "u" })).rejects.toThrow(
      /empty completion/,
    );
  });
});
