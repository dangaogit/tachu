import { describe, expect, test } from "bun:test";
import type { MessageContentPart } from "../types/message";
import { stripTrailingCurrentTurn } from "./turn-tail";

describe("stripTrailingCurrentTurn", () => {
 describe("Slice 1: bug 直击 + 安全契约", () => {
 test("tail 是 user 且 string content 与 currentContent 相等 → 剥", () => {
      const history = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "hello" }, // 本轮 session.append 写入的同一条
      ];
      const result = stripTrailingCurrentTurn(history, "hello");
      expect(result).toHaveLength(2);
      expect(result[result.length - 1]?.role).toBe("assistant");
    });

 test("tail 是 assistant → 不剥（守住「不向前回溯」契约）", () => {
      const history = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hello" },
      ];
      const result = stripTrailingCurrentTurn(history, "hello");
      expect(result).toBe(history);
      expect(result).toHaveLength(2);
    });

 test("历史里有两条连续 user:'hello' → 只剥末尾一条，前一条保住", () => {
      const history = [
        { role: "user", content: "hello" }, // 上一轮可能未写 assistant
        { role: "user", content: "hello" }, // 本轮 session.append
      ];
      const result = stripTrailingCurrentTurn(history, "hello");
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe("hello");
      expect(result[0]?.role).toBe("user");
    });
  });

 describe("Slice 2: 边界", () => {
 test("tail 是 user 但 content 不等 → 不剥", () => {
      const history = [{ role: "user", content: "different" }];
      const result = stripTrailingCurrentTurn(history, "hello");
      expect(result).toBe(history);
    });

 test("空 history → 原样返回", () => {
      const history: Array<{ role: string; content: unknown }> = [];
      const result = stripTrailingCurrentTurn(history, "hello");
      expect(result).toBe(history);
    });
  });

 describe("Slice 3: 多模态结构相等", () => {
 test("双方都是 MessageContentPart[] 且逐 part 相等 → 剥", () => {
      const parts: MessageContentPart[] = [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "https://e.com/x.png" } },
      ];
      const history = [{ role: "user", content: parts }];
      const result = stripTrailingCurrentTurn(history, parts);
      expect(result).toHaveLength(0);
    });

 test("part 内容不同（image url 不同）→ 不剥", () => {
      const tail: MessageContentPart[] = [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "https://e.com/x.png" } },
      ];
      const current: MessageContentPart[] = [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "https://e.com/Y.png" } },
      ];
      const history = [{ role: "user", content: tail }];
      const result = stripTrailingCurrentTurn(history, current);
      expect(result).toBe(history);
    });

 test("part 长度不同 → 不剥", () => {
      const tail: MessageContentPart[] = [{ type: "text", text: "describe" }];
      const current: MessageContentPart[] = [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "https://e.com/x.png" } },
      ];
      const history = [{ role: "user", content: tail }];
      const result = stripTrailingCurrentTurn(history, current);
      expect(result).toBe(history);
    });
  });

 describe("不变式：只剥尾巴一次", () => {
 test("即使倒数第二条也等于 currentContent，也只剥最后一条", () => {
      const history = [
        { role: "user", content: "hello" },
        { role: "user", content: "hello" },
      ];
      const result = stripTrailingCurrentTurn(history, "hello");
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe("hello");
    });
  });
});
