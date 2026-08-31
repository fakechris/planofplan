import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { extractAntigravityUsage, antigravityConversationId } from '../src/antigravity-usage.ts';

// ---- 测试用 proto 编码器:构造 gen_metadata blob ----
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}
function field(num: number, payload: number[] | string): number[] {
  const bytes = typeof payload === 'string' ? [...Buffer.from(payload, 'utf8')] : payload;
  return [...varint((num << 3) | 2), ...varint(bytes.length), ...bytes];
}
function varintField(num: number, value: number): number[] {
  return [...varint((num << 3) | 0), ...varint(value)];
}
/** chat_model{usage{model,input,output,cacheRead}, display_name} */
function genMetadataBlob(model: string, input: number, output: number, cacheRead?: number): Uint8Array {
  const usage = [
    ...varintField(1, 2000),
    ...varintField(2, input),
    ...varintField(3, output),
    ...(cacheRead ? varintField(5, cacheRead) : []),
  ];
  const chatModel = [
    ...field(4, usage),
    ...field(21, model),
  ];
  return Uint8Array.from([...field(1, chatModel)]);
}

function fixtureDb(rows: Array<{ idx: number; blob: Uint8Array }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pop-agy-'));
  const path = join(dir, '11111111-2222-3333-4444-555555555555.db');
  const db = new Database(path);
  db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER)');
  for (const row of rows) {
    db.query('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(row.idx, row.blob, row.blob.length);
  }
  db.close();
  return path;
}

describe('antigravity gen_metadata 解码', () => {
  test('usage 块 + 模型名 + 可选 cacheRead', () => {
    const path = fixtureDb([
      { idx: 0, blob: genMetadataBlob('gemini-3.7-flash', 100, 20, 5000) },
      { idx: 1, blob: genMetadataBlob('gemini-3-pro', 7, 3) },
    ]);
    const rows = extractAntigravityUsage(path);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ idx: 0, model: 'gemini-3.7-flash', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000 });
    expect(rows[1]).toMatchObject({ idx: 1, model: 'gemini-3-pro', cacheReadTokens: 0 });
    expect(antigravityConversationId(path)).toBe('11111111-2222-3333-4444-555555555555');
    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  test('decoy 块被校验拒绝;无表/损坏返回空', () => {
    const path = fixtureDb([
      { idx: 0, blob: genMetadataBlob('x', 100, 20) }, // model 枚举改在域外
    ]);
    // model=2000 在域内——再造一个域外的
    const bad = Uint8Array.from([
      ...field(1, [
        ...field(4, [...varintField(1, 100), ...varintField(2, 5), ...varintField(3, 5)]),
      ]),
    ]);
    const db = new Database(path);
    db.query('INSERT INTO gen_metadata VALUES (?, ?, ?)').run(9, bad, bad.length);
    db.close();
    const rows = extractAntigravityUsage(path);
    expect(rows).toHaveLength(1); // 只有域内的那条
    expect(rows[0].idx).toBe(0);

    const empty = join(mkdtempSync(join(tmpdir(), 'pop-agy2-')), 'none.db');
    const db2 = new Database(empty);
    db2.exec('CREATE TABLE other (x INTEGER)');
    db2.close();
    expect(extractAntigravityUsage(empty)).toEqual([]);
    rmSync(join(path, '..'), { recursive: true, force: true });
  });
});
