import { describe, expect, test } from "bun:test";
import { isBaseDescriptor } from "./descriptor";

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

