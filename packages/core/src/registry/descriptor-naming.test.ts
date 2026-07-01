import { describe, expect, test, mock } from "bun:test";
import { ValidationError } from "../errors";
import {
  isValidDescriptorNameFormat,
  requireValidDescriptorNameFormat,
  isSkillDirectoryForm,
  warnOnDescriptorIdentityMismatch,
} from "./descriptor-naming";

describe("isValidDescriptorNameFormat", () => {
  test("accepts lowercase kebab-case names", () => {
    expect(isValidDescriptorNameFormat("git-workflow")).toBe(true);
    expect(isValidDescriptorNameFormat("a")).toBe(true);
    expect(isValidDescriptorNameFormat("a1-b2")).toBe(true);
  });

  test("rejects uppercase, leading/trailing hyphen, and consecutive hyphens", () => {
    expect(isValidDescriptorNameFormat("Git-Workflow")).toBe(false);
    expect(isValidDescriptorNameFormat("-pdf")).toBe(false);
    expect(isValidDescriptorNameFormat("pdf-")).toBe(false);
    expect(isValidDescriptorNameFormat("pdf--processing")).toBe(false);
    expect(isValidDescriptorNameFormat("")).toBe(false);
  });
});

describe("requireValidDescriptorNameFormat", () => {
  test("does not throw for a valid name", () => {
    expect(() => requireValidDescriptorNameFormat("git-workflow")).not.toThrow();
  });

  test("throws ValidationError for an invalid name", () => {
    expect(() => requireValidDescriptorNameFormat("Bad_Name")).toThrow(ValidationError);
  });
});

describe("isSkillDirectoryForm", () => {
  test("true only for a file literally named SKILL.md (case-insensitive)", () => {
    expect(isSkillDirectoryForm("/a/git-workflow/SKILL.md")).toBe(true);
    expect(isSkillDirectoryForm("/a/git-workflow/skill.md")).toBe(true);
    expect(isSkillDirectoryForm("/a/skills/s1.md")).toBe(false);
  });
});

describe("warnOnDescriptorIdentityMismatch", () => {
  test("skill directory form: warns when name != parent directory name", () => {
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      warnOnDescriptorIdentityMismatch("skill", "other-name", "/a/git-workflow/SKILL.md");
    } finally {
      console.warn = originalWarn;
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("skill directory form: no warning when name == parent directory name", () => {
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      warnOnDescriptorIdentityMismatch("skill", "git-workflow", "/a/git-workflow/SKILL.md");
    } finally {
      console.warn = originalWarn;
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test("single-file form (rule/tool/agent/flat skill): compares against filename, not directory", () => {
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      warnOnDescriptorIdentityMismatch("rule", "no-external-calls", "/a/rules/no-external-calls.md");
      warnOnDescriptorIdentityMismatch("skill", "explain-code", "/a/skills/explain-code.md");
    } finally {
      console.warn = originalWarn;
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test("no sourceFile: never warns", () => {
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      warnOnDescriptorIdentityMismatch("tool", "anything", undefined);
    } finally {
      console.warn = originalWarn;
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
