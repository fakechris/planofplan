import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forEachJsonlLine, firstJsonlLine } from '../src/jsonl-stream.ts';

test('JSONL decoding preserves split UTF-8 and exact byte watermarks across partial tails', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsonl-bytes-'));
  const path = join(root, 'source.jsonl');
  try {
    const first = 'x'.repeat(256 * 1024 - 1) + '中🙂文';
    writeFileSync(path, first + '\npartial');
    const rows: string[] = [];
    const end = forEachJsonlLine(path, 0, (text) => rows.push(text));
    expect(rows).toEqual([first]);
    expect(end).toBe(Buffer.byteLength(first) + 1);
    appendFileSync(path, '尾\n');
    expect(forEachJsonlLine(path, end, (text) => rows.push(text))).toBe(end + Buffer.byteLength('partial尾\n'));
    expect(rows).toEqual([first, 'partial尾']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('first-line metadata lookup skips a 1GiB transcript body and closes the descriptor', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsonl-header-'));
  const path = join(root, 'source.jsonl');
  try {
    const header = '{"type":"session_meta","payload":{"id":"header"}}';
    writeFileSync(path, header + '\n');
    truncateSync(path, 1024 * 1024 * 1024); // sparse synthetic tail, never decoded
    expect(firstJsonlLine(path)).toBe(header);
    expect(firstJsonlLine(path)).toBe(header);
    writeFileSync(path, header); // no newline at EOF still parses
    expect(firstJsonlLine(path)).toBe(header);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
