import { describe, expect, it } from "bun:test";
import { detectImageMimeFromMagic } from "./image-mime";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("detectImageMimeFromMagic", () => {
  it("detects PNG", () => {
    const buf = Buffer.from(PNG_1PX, "base64");
    expect(detectImageMimeFromMagic(buf)).toBe("image/png");
  });

  it("detects minimal JPEG", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
    expect(detectImageMimeFromMagic(buf)).toBe("image/jpeg");
  });

  it("detects GIF header", () => {
    const buf = Buffer.from("GIF89a\x00\x00\x00", "ascii");
    expect(detectImageMimeFromMagic(buf)).toBe("image/gif");
  });

  it("returns null for random bytes", () => {
    expect(detectImageMimeFromMagic(Buffer.from("hello world"))).toBeNull();
  });
});
