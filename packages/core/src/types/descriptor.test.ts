import { describe, expect, test } from "bun:test";
import { isBaseDescriptor, descriptorMetadataText } from "./descriptor";

describe("descriptor type guards", () => {
 test("validates base descriptor shape", () => {
    expect(isBaseDescriptor({ name: "a", description: "b" })).toBe(true);
    expect(isBaseDescriptor({ name: "a" })).toBe(false);
    expect(isBaseDescriptor(null)).toBe(false);
    expect(isBaseDescriptor("raw-string")).toBe(false);
    expect(
      isBaseDescriptor({
        name: "tool-1",
        description: "with optional fields",
        version: "1.2.3",
        displayName: "Tool 1",
        deprecated: false,
        deprecatedMessage: "use tool-2",
        tags: ["a", "b"],
        trigger: { type: "always" },
      }),
    ).toBe(true);
  });

 test("rejects invalid primitive field types", () => {
    expect(
      isBaseDescriptor({
        name: 123,
        description: "x",
      }),
    ).toBe(false);
    expect(
      isBaseDescriptor({
        name: "x",
        description: ["not", "string"],
      }),
    ).toBe(false);
  });
});

describe("descriptorMetadataText", () => {
 test("concatenates name + displayName + description + tags", () => {
    const text = descriptorMetadataText({
      name: "web-search",
      displayName: "Web Search",
      description: "Search the web",
      tags: ["search", "internet"],
    });
    expect(text).toContain("web-search");
    expect(text).toContain("Web Search");
    expect(text).toContain("Search the web");
    expect(text).toContain("search");
    expect(text).toContain("internet");
  });

 test("works with only required fields", () => {
    const text = descriptorMetadataText({ name: "my-tool", description: "does stuff" });
    expect(text).toContain("my-tool");
    expect(text).toContain("does stuff");
    expect(text.trim().length).toBeGreaterThan(0);
  });

 test("omits undefined optional fields without extra whitespace artifacts", () => {
    const text = descriptorMetadataText({ name: "x", description: "y" });
    expect(text.startsWith("  ")).toBe(false);
    expect(text.includes("undefined")).toBe(false);
  });

 test("stable output for same input", () => {
    const d = { name: "a", description: "b", tags: ["c"] };
    expect(descriptorMetadataText(d)).toBe(descriptorMetadataText(d));
  });
});

