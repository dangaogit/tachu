import { describe, expect, it } from "bun:test";
import { tryParseImageSlashCommand } from "./image-slash-command";

describe("tryParseImageSlashCommand", () => {
  it("parses path and prompt", () => {
    expect(tryParseImageSlashCommand(`/image ./a.png 描述内容`)).toEqual({
      rawPath: "./a.png",
      prompt: "描述内容",
    });
  });

  it("parses quoted path", () => {
    expect(tryParseImageSlashCommand(`/image "./a b.png" hello`)).toEqual({
      rawPath: "./a b.png",
      prompt: "hello",
    });
  });

  it("path only", () => {
    expect(tryParseImageSlashCommand(`/image ./x.jpg`)).toEqual({
      rawPath: "./x.jpg",
      prompt: "",
    });
  });

  it("rejects plain line", () => {
    expect(tryParseImageSlashCommand("hello")).toBeNull();
  });

  it("does not treat /images as /image", () => {
    expect(tryParseImageSlashCommand("/images ./a.png")).toBeNull();
  });
});
