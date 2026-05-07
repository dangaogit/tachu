import { describe, expect, test } from "bun:test";
import { matchesRecord } from "./approval-matcher";
import type { ApprovalRecord } from "./approval-store";

const baseRecord = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: "test-id",
  scope: "project",
  tool: "write-file",
  match: { kind: "any" },
  createdAt: Date.now(),
  ...overrides,
});

describe("matchesRecord", () => {
  describe("过期检查", () => {
    test("过期记录不匹配", () => {
      const record = baseRecord({ expiresAt: Date.now() - 1000 });
      expect(matchesRecord(record, "write-file", {})).toBe(false);
    });

    test("未过期记录正常匹配", () => {
      const record = baseRecord({ expiresAt: Date.now() + 100_000 });
      expect(matchesRecord(record, "write-file", {})).toBe(true);
    });

    test("无过期时间永不过期", () => {
      const record = baseRecord();
      expect(matchesRecord(record, "write-file", {})).toBe(true);
    });
  });

  describe("sessionId 检查", () => {
    test("sessionId 匹配时通过", () => {
      const record = baseRecord({ sessionId: "sess-1" });
      expect(matchesRecord(record, "write-file", {}, "sess-1")).toBe(true);
    });

    test("sessionId 不匹配时拒绝", () => {
      const record = baseRecord({ sessionId: "sess-1" });
      expect(matchesRecord(record, "write-file", {}, "sess-2")).toBe(false);
    });

    test("无 sessionId 的记录对任意 sessionId 有效", () => {
      const record = baseRecord();
      expect(matchesRecord(record, "write-file", {}, "sess-any")).toBe(true);
    });

    test("记录有 sessionId 但调用方没有 currentSessionId 时拒绝", () => {
      const record = baseRecord({ sessionId: "sess-1" });
      expect(matchesRecord(record, "write-file", {})).toBe(false);
    });
  });

  describe("工具名检查", () => {
    test("工具名不匹配时拒绝", () => {
      const record = baseRecord({ tool: "read-file" });
      expect(matchesRecord(record, "write-file", {})).toBe(false);
    });

    test("工具名匹配时通过", () => {
      const record = baseRecord({ tool: "write-file" });
      expect(matchesRecord(record, "write-file", {})).toBe(true);
    });
  });

  describe("kind: any", () => {
    test("any 类型工具名匹配即通过", () => {
      const record = baseRecord({ match: { kind: "any" } });
      expect(matchesRecord(record, "write-file", { path: "/some/file" })).toBe(true);
    });
  });

  describe("kind: shellCommand", () => {
    test("命令匹配正则且无 args 时通过", () => {
      const record = baseRecord({
        tool: "run-shell",
        match: { kind: "shellCommand", pattern: "^git\\b" },
      });
      expect(matchesRecord(record, "run-shell", { command: "git status" })).toBe(true);
    });

    test("命令不匹配正则时拒绝", () => {
      const record = baseRecord({
        tool: "run-shell",
        match: { kind: "shellCommand", pattern: "^git\\b" },
      });
      expect(matchesRecord(record, "run-shell", { command: "rm -rf /" })).toBe(false);
    });

    test("有 args 时即使命令匹配也拒绝", () => {
      const record = baseRecord({
        tool: "run-shell",
        match: { kind: "shellCommand", pattern: "^git\\b" },
      });
      expect(
        matchesRecord(record, "run-shell", { command: "git", args: ["status"] }),
      ).toBe(false);
    });

    test("非法正则不抛错而是返回 false", () => {
      const record = baseRecord({
        tool: "run-shell",
        match: { kind: "shellCommand", pattern: "[unclosed(" },
      });
      expect(matchesRecord(record, "run-shell", { command: "git" })).toBe(false);
    });
  });

  describe("kind: argPattern", () => {
    test("glob 模式匹配时通过", () => {
      const record = baseRecord({
        match: { kind: "argPattern", field: "path", pattern: "src/**" },
      });
      expect(matchesRecord(record, "write-file", { path: "src/foo/bar.ts" })).toBe(true);
    });

    test("glob 模式不匹配时拒绝", () => {
      const record = baseRecord({
        match: { kind: "argPattern", field: "path", pattern: "src/**" },
      });
      expect(matchesRecord(record, "write-file", { path: "dist/foo/bar.ts" })).toBe(false);
    });

    test("字段不存在时拒绝", () => {
      const record = baseRecord({
        match: { kind: "argPattern", field: "path", pattern: "src/**" },
      });
      expect(matchesRecord(record, "write-file", {})).toBe(false);
    });

    test("字段类型非字符串时拒绝", () => {
      const record = baseRecord({
        match: { kind: "argPattern", field: "path", pattern: "src/**" },
      });
      expect(matchesRecord(record, "write-file", { path: 123 })).toBe(false);
    });
  });
});
