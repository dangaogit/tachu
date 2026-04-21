import { describe, expect, test } from "bun:test";
import { extractStructured } from "./structured";

describe("extractStructured", () => {
  test("parses a single application/ld+json block", () => {
    const html = `<!doctype html><html><head>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","name":"Hi"}</script>
    </head></html>`;
    const r = extractStructured(html);
    expect(r.jsonLd).toEqual([
      { "@context": "https://schema.org", "@type": "Article", name: "Hi" },
    ]);
    expect(r.openGraph).toEqual({});
    expect(r.twitter).toEqual({});
    expect(r.description).toBeUndefined();
  });

  test("merges multiple JSON-LD scripts into jsonLd array", () => {
    const html = `
      <script type="application/ld+json">{"@type":"Thing","name":"A"}</script>
      <script type='application/ld+json'>{"@type":"Thing","name":"B"}</script>
    `;
    const r = extractStructured(html);
    expect(r.jsonLd).toEqual([
      { "@type": "Thing", name: "A" },
      { "@type": "Thing", name: "B" },
    ]);
  });

  test("skips invalid JSON-LD without throwing", () => {
    const html = `
      <script type="application/ld+json">not json at all</script>
      <script type="application/ld+json">{"ok":true}</script>
    `;
    expect(() => extractStructured(html)).not.toThrow();
    const r = extractStructured(html);
    expect(r.jsonLd).toEqual([{ ok: true }]);
  });

  test("reads Open Graph meta properties", () => {
    const html = `<head>
      <meta property="og:title" content="OG Title" />
      <meta property="og:image" content="https://ex/img.png" />
    </head>`;
    const r = extractStructured(html);
    expect(r.openGraph).toEqual({
      title: "OG Title",
      image: "https://ex/img.png",
    });
  });

  test("returns empty containers when no structured data is present", () => {
    const html = "<html><body><p>plain</p></body></html>";
    const r = extractStructured(html);
    expect(r.jsonLd).toEqual([]);
    expect(r.openGraph).toEqual({});
    expect(r.twitter).toEqual({});
    expect(r.description).toBeUndefined();
  });

  test("reads twitter: meta names and meta description", () => {
    const html = `<meta name="twitter:card" content="summary_large_image" />
      <meta name="description" content="Page desc" />`;
    const r = extractStructured(html);
    expect(r.twitter).toEqual({ card: "summary_large_image" });
    expect(r.description).toBe("Page desc");
  });
});
