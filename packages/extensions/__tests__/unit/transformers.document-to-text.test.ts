import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DocumentToTextTransformer } from "../../src/transformers/document-to-text";
import { cleanupTempDir, createTempDir } from "../helpers";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

describe("DocumentToTextTransformer", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  it("reads plain text files", async () => {
    const path = `${root}/a.txt`;
    await writeFile(path, "hello doc");
    const transformer = new DocumentToTextTransformer();
    const output = await transformer.transform({
      content: { path, mimeType: "text/plain" },
      metadata: { modality: "document", mimeType: "text/plain" },
    });
    expect(output.content).toBe("hello doc");
    expect(output.metadata.modality).toBe("text");
  });

  it("extracts text from PDF via pdf-parse", async () => {
    const path = join(FIXTURES_DIR, "sample.pdf");
    const transformer = new DocumentToTextTransformer();
    const output = await transformer.transform({
      content: { path, mimeType: "application/pdf" },
      metadata: { modality: "document", mimeType: "application/pdf" },
    });
    expect(typeof output.content).toBe("string");
    expect((output.content as string).length).toBeGreaterThan(0);
    expect(output.metadata.modality).toBe("text");
    expect(output.metadata.mimeType).toBe("text/plain");
  });

  it("extracts text from DOCX via mammoth", async () => {
    const path = join(FIXTURES_DIR, "sample.docx");
    const transformer = new DocumentToTextTransformer();
    const output = await transformer.transform({
      content: {
        path,
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      metadata: {
        modality: "document",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    });
    expect(typeof output.content).toBe("string");
    expect((output.content as string).length).toBeGreaterThan(0);
    expect(output.metadata.modality).toBe("text");
    expect(output.metadata.mimeType).toBe("text/plain");
  });
});
