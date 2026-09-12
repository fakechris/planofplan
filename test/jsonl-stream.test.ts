import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forEachJsonlLine } from '../src/jsonl-stream.ts';

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
