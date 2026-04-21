import { describe, expect, test } from 'bun:test';
import { htmlToMarkdown } from './to-markdown';

const bothOn = { includeLinks: true, includeImages: true } as const;
const bothOff = { includeLinks: false, includeImages: false } as const;

describe('htmlToMarkdown', () => {
  test('renders ATX headings', () => {
    const html = '<h1>T1</h1><h2>T2</h2><h3>T3</h3>';
    const md = htmlToMarkdown(html, bothOn);
    expect(md).toContain('# T1');
    expect(md).toContain('## T2');
    expect(md).toContain('### T3');
  });

  test('renders ordered and unordered lists', () => {
    const html = '<ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol>';
    const md = htmlToMarkdown(html, bothOn);
    expect(md).toContain('*   a');
    expect(md).toContain('*   b');
    expect(md).toContain('1.  one');
    expect(md).toContain('2.  two');
  });

  test('renders GFM table with column alignment', () => {
    const html = `<table>
      <thead><tr>
        <th align="left">L</th><th align="center">C</th><th align="right">R</th>
      </tr></thead>
      <tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody>
    </table>`;
    const md = htmlToMarkdown(html, bothOn);
    expect(md).toContain('| L | C | R |');
    expect(md).toMatch(/:\-+|---:[\s\S]*:---:[\s\S]*-+:/);
    expect(md).toContain('| a | b | c |');
  });

  test('renders fenced code blocks', () => {
    const html = '<pre><code class="language-ts">const x = 1;\n</code></pre>';
    const md = htmlToMarkdown(html, bothOn);
    expect(md).toContain('```');
    expect(md).toContain('const x = 1;');
  });

  test('renders GFM task list items', () => {
    const html = `<ul>
      <li><input type="checkbox" checked disabled /> Done</li>
      <li><input type="checkbox" disabled /> Todo</li>
    </ul>`;
    const md = htmlToMarkdown(html, bothOn);
    expect(md).toContain('[x]');
    expect(md).toContain('[ ]');
    expect(md).toContain('Done');
    expect(md).toContain('Todo');
  });

  test('includeLinks false strips href but keeps link text', () => {
    const html = '<p>See <a href="https://ex.test/x">more</a> here.</p>';
    const withLinks = htmlToMarkdown(html, bothOn);
    const without = htmlToMarkdown(html, { ...bothOn, includeLinks: false });
    expect(withLinks).toContain('https://ex.test/x');
    expect(without).not.toContain('https://ex.test/x');
    expect(without).toContain('more');
  });

  test('includeImages false removes images from markdown', () => {
    const html = '<p>Hi <img src="https://ex.test/i.png" alt="pic" /> end</p>';
    const withImg = htmlToMarkdown(html, bothOn);
    const without = htmlToMarkdown(html, { ...bothOn, includeImages: false });
    expect(withImg).toContain('https://ex.test/i.png');
    expect(without).not.toContain('https://ex.test/i.png');
    expect(without).toMatch(/Hi\s+end/);
  });

  test('throws TypeError when input is not a convertible string', () => {
    expect(() =>
      htmlToMarkdown(42 as unknown as string, bothOff),
    ).toThrow(TypeError);
  });
});
