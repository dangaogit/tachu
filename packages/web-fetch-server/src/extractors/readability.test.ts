import { describe, expect, test } from 'bun:test';

import { extractReadable } from './readability';

const BASE = 'https://example.com/article';

function longBody(): string {
  return `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed vitae urna non velit faucibus fermentum. `.repeat(
    4,
  );
}

describe('extractReadable', () => {
  test('extracts typical article HTML with title and body', () => {
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>News Title</title></head>
<body><article><p>${longBody()}</p><p>Second paragraph for readability.</p></article></body></html>`;
    const article = extractReadable(html, BASE);
    expect(article).not.toBeNull();
    expect(article!.title).toContain('News Title');
    expect(article!.contentHtml.toLowerCase()).toContain('<p>');
    expect(article!.textContent.length).toBeGreaterThan(100);
    expect(article!.contentHtml.toLowerCase()).not.toContain('<script');
  });

  test('returns null for empty page with no reader content', () => {
    const html = '<!DOCTYPE html><html><head></head><body></body></html>';
    expect(extractReadable(html, BASE)).toBeNull();
  });

  test('still extracts when <title> is missing but article body exists', () => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body><main><article><h1>Headline Only</h1><p>${longBody()}</p></article></main></body></html>`;
    const article = extractReadable(html, BASE);
    expect(article).not.toBeNull();
    expect(article!.textContent).toContain('Lorem ipsum');
    expect(article!.textContent).toContain('Headline Only');
  });

  test('strips heavy script/style noise and keeps article text', () => {
    const html = `<!DOCTYPE html><html><head><title>Ad heavy</title>
<script>window.ads=[];for(var i=0;i<99;i++){window.ads.push(i)}</script>
<style>.ad{display:none}</style></head>
<body><div id="content"><article><p>${longBody()}</p></article></div>
<script>console.log('track')</script></body></html>`;
    const article = extractReadable(html, BASE);
    expect(article).not.toBeNull();
    expect(article!.contentHtml.toLowerCase()).not.toContain('<script');
    expect(article!.contentHtml.toLowerCase()).not.toContain('<style');
    expect(article!.textContent).toContain('Lorem ipsum');
  });

  test('accepts non-ASCII content as a JS string without throwing', () => {
    const html = `<!DOCTYPE html><html><head><meta charset="iso-8859-1"><title>T</title></head>
<body><article><p>Caf\u00E9 na\u00EFve r\u00E9sum\u00E9 — ${longBody()}</p></article></body></html>`;
    const article = extractReadable(html, BASE);
    expect(article).not.toBeNull();
    expect(article!.textContent).toContain('Caf');
  });

  test('returns null on empty input without throwing', () => {
    expect(extractReadable('', BASE)).toBeNull();
  });

  test('respects <base href> for document URL resolution', () => {
    const html = `<!DOCTYPE html><html><head><base href="https://cdn.example.com/pub/"><title>B</title></head>
<body><article><p>${longBody()}</p></article></body></html>`;
    const article = extractReadable(html, 'https://example.com/page');
    expect(article).not.toBeNull();
  });
});
