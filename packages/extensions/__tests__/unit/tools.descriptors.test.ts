import { describe, expect, test } from "bun:test";
import { toolDescriptors } from "../../src/tools";

describe("built-in tool descriptors", () => {
 test("external-source tools declare dataSource=external", () => {
    for (const name of ["fetch-url", "web-fetch", "web-search"]) {
      expect(toolDescriptors.find((descriptor) => descriptor.name === name)?.dataSource).toBe(
        "external",
      );
    }
  });
});
