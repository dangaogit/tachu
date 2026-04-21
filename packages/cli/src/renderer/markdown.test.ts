import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { renderMarkdownToAnsi } from "./markdown";
import { setNoColor, resetColorState } from "./color";

// Local ANSI stripper so assertions don't break when chalk/cli-highlight
// decide to inject SGR sequences based on FORCE_COLOR / TTY state at runtime.
// Mirrors the regex used by the `strip-ansi` package.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

describe("renderMarkdownToAnsi", () => {
  afterEach(() => {
    resetColorState();
  });

  describe("禁色环境退化", () => {
    beforeEach(() => {
      setNoColor(true);
    });

    it("禁色环境下返回原文（不经 marked 解析）", () => {
      const src = "# Heading\n\n**bold** and *italic* and `code`";
      expect(renderMarkdownToAnsi(src)).toBe(src);
    });

    it("禁色环境下空字符串仍返回空字符串", () => {
      expect(renderMarkdownToAnsi("")).toBe("");
    });

    it("禁色环境下 fenced code block 原样返回", () => {
      const src = "```ts\nconst x: number = 1;\n```";
      expect(renderMarkdownToAnsi(src)).toBe(src);
    });

    it("force 时禁色仍解析 GFM 表格（Ink 等需排版）", () => {
      const src = "| a | b |\n|---|---|\n| 1 | 2 |";
      const out = renderMarkdownToAnsi(src, { force: true });
      expect(out).not.toBe(src);
      expect(out).toContain("1");
      expect(out).toContain("2");
    });
  });

  describe("开色环境（走 marked + marked-terminal 链路）", () => {
    beforeEach(() => {
      // 显式关闭 no-color 标志。注意：测试环境 stdout 通常非 TTY，
      // chalk 自身会根据 TTY/FORCE_COLOR 决定是否输出 ANSI 码；
      // 这里不强求 ANSI 断言，只断言核心内容 + 换行归一化。
      setNoColor(false);
    });

    it("标题内容会经过 marked 处理并保留原始文字", () => {
      const out = renderMarkdownToAnsi("# Hello World");
      expect(stripAnsi(out)).toContain("Hello World");
    });

    it("粗体 / 斜体 / 行内代码 的文字内容被保留", () => {
      const out = renderMarkdownToAnsi(
        "This is **bold**, *italic*, and `code` together.",
      );
      const plain = stripAnsi(out);
      expect(plain).toContain("bold");
      expect(plain).toContain("italic");
      expect(plain).toContain("code");
    });

    it("无序列表条目文字被保留", () => {
      const out = renderMarkdownToAnsi("- first\n- second\n- third");
      const plain = stripAnsi(out);
      expect(plain).toContain("first");
      expect(plain).toContain("second");
      expect(plain).toContain("third");
    });

    it("fenced code block 的代码文字被保留", () => {
      const src = "```ts\nconst answer = 42;\n```";
      const out = renderMarkdownToAnsi(src);
      // cli-highlight may wrap tokens (`const`, `42`) with individual SGR
      // sequences when color is active, splitting the literal substring.
      // Strip ANSI before checking so the assertion is color-agnostic.
      expect(stripAnsi(out)).toContain("const answer = 42");
    });

    it("链接文本会被保留", () => {
      const out = renderMarkdownToAnsi("[Tachu](https://example.com/tachu)");
      expect(stripAnsi(out)).toContain("Tachu");
    });

    it("输出尾部多余换行会被归一化为单个 \\n", () => {
      const out = renderMarkdownToAnsi("hello");
      expect(out.endsWith("\n")).toBe(true);
      // 不以两个及以上 \n 结尾
      expect(/\n\n+$/.test(out)).toBe(false);
    });

    it("纯文本（无 Markdown 语法）被正确透传（作为段落处理）", () => {
      const out = renderMarkdownToAnsi("just a plain sentence.");
      expect(stripAnsi(out)).toContain("just a plain sentence.");
    });

    it("空字符串始终返回空（早退路径，不触发 marked）", () => {
      expect(renderMarkdownToAnsi("")).toBe("");
    });
  });
});
