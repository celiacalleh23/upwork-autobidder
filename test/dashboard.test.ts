import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Oct 30: the Keyword trends search box reused id="kwInput" from Settings → Keywords, so getElementById found the
// trends box first and "Add" in Settings added nothing. Every id must be unique, and every $('…') must exist.
const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');

describe('dashboard.html ids', () => {
  it('uses each id once', () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
  it('shows a note only for a real failure and never an amber missing note', () => {
    expect(html).toContain("p.note_error ? 'small note bad' : 'small note neutral'");
    expect(html).toContain("r.note_error ? 'note bad' : 'note neutral'");
    expect(html).toContain('.card .note, .st-cell .note{background:transparent');
    expect(html).not.toContain('note quiet');
    expect(html).not.toContain('shownNote');
    expect(html).not.toContain('missing:');
    expect(html).not.toContain('come straight from Upwork');
    expect(html).not.toContain('Refresh from Upwork');
    expect(html).toContain("Figures come from this app's own records");
    expect(html).toContain('>Recalculate<');
    expect(html).toContain("$('sConnects').textContent = fmtNum(r.today.total.connects)");
    expect(html).toContain('text: fmtNum(r.today.total.connects)');
  });
  it('looks up only ids that exist', () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = [...new Set([...html.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
    expect(used.filter((id) => !ids.has(id))).toEqual([]);
  });
});
