import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveGeneratedImages } from "./save-generated-images";

/**
 * 为测试构造一个稳定的 fake fetch：按 URL 返回预设 Blob 字节。
 */
const installFetchMock = (
  routes: Record<string, { status?: number; bytes?: Uint8Array; error?: boolean }>,
): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const u =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const r = routes[u];
    if (!r) return new Response("not found", { status: 404 });
    if (r.error) throw new Error("network boom");
    const bytes = r.bytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    return new Response(bytes, { status: r.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
};

describe("saveGeneratedImages", () => {
  let workdir: string;
  let cleanup: (() => void) | undefined;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "tachu-save-image-"));
  });

  afterEach(async () => {
    cleanup?.();
    cleanup = undefined;
  });

  it("writes a single image to an explicit file path", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    cleanup = installFetchMock({ "https://e.com/cat.png": { bytes: payload } });
    const target = join(workdir, "nested/dir/cat.png");
    const records = await saveGeneratedImages({
      cwd: workdir,
      target,
      images: [
        { url: "https://e.com/cat.png", index: 0, mimeType: "image/png" },
      ],
    });
    expect(records.length).toBe(1);
    expect(records[0]!.path).toBe(target);
    expect(records[0]!.bytes).toBe(payload.byteLength);
    expect(records[0]!.error).toBeUndefined();
    const onDisk = await readFile(target);
    expect(onDisk.equals(Buffer.from(payload))).toBe(true);
  });

  it("writes to directory with generated-<n>.<ext> naming", async () => {
    cleanup = installFetchMock({
      "https://e.com/a.png": { bytes: new Uint8Array([0xaa]) },
      "https://e.com/b.jpg": { bytes: new Uint8Array([0xbb, 0xcc]) },
    });
    const dir = join(workdir, "imgs");
    await mkdir(dir, { recursive: true });
    const records = await saveGeneratedImages({
      cwd: workdir,
      target: dir,
      images: [
        { url: "https://e.com/a.png", index: 0, mimeType: "image/png" },
        { url: "https://e.com/b.jpg", index: 1, mimeType: "image/jpeg" },
      ],
    });
    expect(records.map((r) => r.path)).toEqual([
      resolve(dir, "generated-1.png"),
      resolve(dir, "generated-2.jpg"),
    ]);
    for (const r of records) {
      const st = await stat(r.path);
      expect(st.isFile()).toBe(true);
    }
  });

  it("auto numbers multiple images when target is a single file path", async () => {
    cleanup = installFetchMock({
      "https://e.com/1.png": { bytes: new Uint8Array([1]) },
      "https://e.com/2.png": { bytes: new Uint8Array([2]) },
      "https://e.com/3.png": { bytes: new Uint8Array([3]) },
    });
    const target = join(workdir, "out/cat.png");
    const records = await saveGeneratedImages({
      cwd: workdir,
      target,
      images: [
        { url: "https://e.com/1.png", index: 0, mimeType: "image/png" },
        { url: "https://e.com/2.png", index: 1, mimeType: "image/png" },
        { url: "https://e.com/3.png", index: 2, mimeType: "image/png" },
      ],
    });
    expect(records.map((r) => r.path)).toEqual([
      join(workdir, "out/cat.png"),
      join(workdir, "out/cat-2.png"),
      join(workdir, "out/cat-3.png"),
    ]);
  });

  it("decodes data: base64 URL into bytes", async () => {
    const base64 = Buffer.from([0x01, 0x02, 0x03]).toString("base64");
    const records = await saveGeneratedImages({
      cwd: workdir,
      target: join(workdir, "x.png"),
      images: [
        {
          url: `data:image/png;base64,${base64}`,
          index: 0,
          mimeType: "image/png",
        },
      ],
    });
    expect(records[0]!.error).toBeUndefined();
    expect(records[0]!.bytes).toBe(3);
    const onDisk = await readFile(join(workdir, "x.png"));
    expect(Array.from(onDisk)).toEqual([0x01, 0x02, 0x03]);
  });

  it("resolves relative path against cwd", async () => {
    cleanup = installFetchMock({
      "https://e.com/rel.png": { bytes: new Uint8Array([9]) },
    });
    const records = await saveGeneratedImages({
      cwd: workdir,
      target: "./out/rel.png",
      images: [{ url: "https://e.com/rel.png", index: 0 }],
    });
    expect(records[0]!.path).toBe(join(workdir, "out/rel.png"));
    const st = await stat(join(workdir, "out/rel.png"));
    expect(st.isFile()).toBe(true);
  });

  it("records per-image error without aborting the rest", async () => {
    cleanup = installFetchMock({
      "https://e.com/good.png": { bytes: new Uint8Array([0x77]) },
      "https://e.com/bad.png": { error: true },
    });
    const dir = join(workdir, "mix");
    await mkdir(dir, { recursive: true });
    const records = await saveGeneratedImages({
      cwd: workdir,
      target: dir,
      images: [
        { url: "https://e.com/good.png", index: 0 },
        { url: "https://e.com/bad.png", index: 1 },
      ],
    });
    expect(records.length).toBe(2);
    expect(records[0]!.error).toBeUndefined();
    expect(records[1]!.error).toBeTypeOf("string");
    const good = await stat(records[0]!.path);
    expect(good.isFile()).toBe(true);
  });

  it("refuses empty target", async () => {
    await expect(
      saveGeneratedImages({
        cwd: workdir,
        target: "",
        images: [{ url: "https://e.com/x.png", index: 0 }],
      }),
    ).rejects.toThrow();
  });

  it("returns empty array for empty images list", async () => {
    const records = await saveGeneratedImages({
      cwd: workdir,
      target: join(workdir, "x.png"),
      images: [],
    });
    expect(records).toEqual([]);
  });

  it("honors overwrite=false by suffixing -2 to existing files", async () => {
    cleanup = installFetchMock({
      "https://e.com/u.png": { bytes: new Uint8Array([0x55]) },
    });
    const existing = join(workdir, "u.png");
    await writeFile(existing, Buffer.from([0x11]));
    const records = await saveGeneratedImages({
      cwd: workdir,
      target: existing,
      overwrite: false,
      images: [{ url: "https://e.com/u.png", index: 0 }],
    });
    expect(records[0]!.path).toBe(join(workdir, "u-2.png"));
    const original = await readFile(existing);
    expect(original[0]).toBe(0x11);
  });
});
