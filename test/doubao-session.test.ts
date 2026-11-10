import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectDoubaoSnapshotTouches,
  doubaoConversationsFromBytes,
  doubaoTouchesFromSnapshotFile,
  extractDoubaoSessions,
  parseBlockEntries,
  snappyDecompress,
} from '../src/doubao-session.ts';
import { extractSessionRecords, sessionKey } from '../src/sessions.ts';

const CONV_ID = '38445813239290114';

function v8Str(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x22, bytes.length]), bytes]);
}

/** two-byte string:V8 WriteTwoByteString 的 varint 是字节数(实测)。 */
function v8TwoByte(text: string): Buffer {
  const units = Buffer.from(text, 'utf16le');
  return Buffer.concat([Buffer.from([0x63]), varint(units.length), units]);
}

function varint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  for (;;) {
    const b = v & 0x7f;
    v >>>= 7;
    if (v === 0) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return Buffer.from(out);
}

/** 合成一段含会话对象的 V8 字节流(结构取自真实 chat leveldb,2026-11-10)。 */
function conversationBytes(overrides: Partial<{ id: string; name: string | null; created: string; updated: string }> = {}): Buffer {
  const id = overrides.id ?? CONV_ID;
  const parts: Buffer[] = [Buffer.from([0xff, 0x0f, 0x6f])]; // header + begin object
  parts.push(v8Str('conversation_id'), v8Str(id));
  parts.push(v8Str('message_cursor'), v8Str('1'));
  parts.push(v8Str('create_time'), v8Str(overrides.created ?? '1791425837'));
  parts.push(v8Str('update_time'), v8Str(overrides.updated ?? '1792551444'));
  parts.push(v8Str('name'), 'name' in overrides && overrides.name == null
    ? Buffer.from([0x30]) // kNull:会话未命名
    : v8TwoByte(overrides.name ?? '网站接受过程问题确认'));
  parts.push(v8Str('conversation_status'), Buffer.from([0x49]), varint(2)); // int32 zigzag(1)
  parts.push(Buffer.from([0x7b])); // end object
  return Buffer.concat(parts);
}

describe('doubao V8 锚定提取(INV-1790)', () => {
  test('会话对象:id/标题(two-byte)/秒级时间,another 锚定窗口不串扰', () => {
    const raw = Buffer.concat([
      conversationBytes(),
      conversationBytes({ id: '38442175826912514', name: '网站分析需求', created: '1789715034', updated: '1789715034' }),
    ]);
    const convs = doubaoConversationsFromBytes(raw);
    expect(convs).toHaveLength(2);
    expect(convs[0]).toEqual({
      conversationId: CONV_ID,
      name: '网站接受过程问题确认',
      createdAtMs: 1791425837_000,
      updatedAtMs: 1792551444_000,
    });
    expect(convs[1]).toMatchObject({ conversationId: '38442175826912514', name: '网站分析需求' });
  });

  test('name 为 null / int 时间 / 噪声窗口:容错不 crash、非法 id 不入列', () => {
    const raw = Buffer.concat([
      Buffer.from('noise preamble \x00\x01', 'latin1'),
      conversationBytes({ name: null }),
      conversationBytes({ id: 'not-an-id' }), // 非数字 id → 丢弃
      Buffer.from('trailing garbage'),
    ]);
    const convs = doubaoConversationsFromBytes(raw);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.name).toBeNull();
    expect(convs[0]!.createdAtMs).toBe(1791425837_000);
  });

  test('目录提取:.log 明文 + 损坏 .ldb 跳过,同 id 取 update_time 最新、保留 name', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-doubao-'));
    try {
      const ldbDir = join(root, 'chrome_doubaowork-chat_0.indexeddb.leveldb');
      mkdirSync(ldbDir);
      writeFileSync(join(ldbDir, '000001.ldb'), 'not an sstable at all');
      writeFileSync(join(ldbDir, '000002.log'), conversationBytes());
      // 同 id 更晚 update_time、但 name 为 null:标题保留旧值
      writeFileSync(join(ldbDir, '000003.log'), Buffer.concat([
        conversationBytes({ updated: '1799999999', name: null }),
      ]));
      const rows = extractSessionRecords('doubao', ldbDir, Date.parse('2026-11-10T00:00:00Z'));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: sessionKey('doubao', CONV_ID),
        provider: 'doubao',
        nativeId: CONV_ID,
        title: '网站接受过程问题确认',
        startedAt: 1791425837_000,
        updatedAt: 1799999999_000,
        sourceFile: ldbDir,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('目录缺席 → 空数组(降级不 crash)', () => {
    expect(extractDoubaoSessions(join(tmpdir(), 'no-such-doubao-dir'), Date.now())).toEqual([]);
  });
});

describe('doubao snappy / SSTable block 单元', () => {
  test('snappy literal + copy 解压往返', () => {
    // 手工编码:varint(len=10) + literal("hello") + copy1(len 5, offset 5)
    const literal = Buffer.from('hello');
    const compressed = Buffer.concat([
      varint(10),
      Buffer.from([(literal.length - 1) << 2]), // literal: tag t=0, len-1 在高位
      literal,
      // copy1: tag=0x05(t=1, len=((5>>2)... → ln=((0x05>>2)&7)+4=5), offset=((0x05>>5)<<8)|0x05=5
      Buffer.from([0x05, 0x05]),
    ]);
    const out = snappyDecompress(compressed);
    expect(out.toString()).toBe('hellohello');
  });

  test('block entries:restart 数组定界 + 前缀压缩 key', () => {
    const key1 = Buffer.from('aaa');
    const key2 = Buffer.from('aab'); // shares "aa"
    const val1 = Buffer.from('V1');
    const val2 = Buffer.from('V22');
    const body = Buffer.concat([
      varint(0), varint(3), varint(2), key1, val1,
      varint(2), varint(1), varint(3), Buffer.from('b'), val2,
    ]);
    const restarts = Buffer.concat([Buffer.alloc(4), Buffer.alloc(4)]); // 2 restarts
    const block = Buffer.concat([body, restarts, Buffer.from([2, 0, 0, 0])]); // count=2
    const entries = parseBlockEntries(block);
    expect(entries).toHaveLength(2);
    expect(entries[0]![0].toString()).toBe('aaa');
    expect(entries[1]![0].toString()).toBe('aab');
    expect(entries[1]![1].toString()).toBe('V22');
  });
});

describe('doubao coding/snapshot 文件触碰', () => {
  test('execution 时间窗 × files[].absolutePath → touches(幂等 id)', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-doubao-snap-'));
    try {
      const execDir = join(root, '766839959856809', CONV_ID, '96c74962-b60b-47f1-9f00-98d329b90482');
      mkdirSync(execDir, { recursive: true });
      writeFileSync(join(execDir, 'd0002e09.json'), JSON.stringify({
        execution: {
          executionKey: '96c74962-b60b-47f1-9f00-98d329b90482',
          conversationId: CONV_ID,
          startedAtMs: 1793098015835,
          endedAtMs: 1793098174456,
        },
        files: [
          { absolutePath: '/Users/chris/DoubaoWork/chats/2026-10-27/new-chat/网易严选Pro会员权益总览.html', changeType: 'created', firstToolName: 'Write', addedLines: 5 },
          { absolutePath: 'relative/no-host.txt', changeType: 'created' }, // 非绝对路径 → 跳过
        ],
        fileContents: {},
      }));
      const touches = doubaoTouchesFromSnapshotFile(join(execDir, 'd0002e09.json'));
      expect(touches).toHaveLength(1);
      expect(touches[0]).toMatchObject({
        id: `doubao:${CONV_ID}:96c74962-b60b-47f1-9f00-98d329b90482:0`,
        sessionId: `doubao:${CONV_ID}`,
        provider: 'doubao',
        filePath: '/Users/chris/DoubaoWork/chats/2026-10-27/new-chat/网易严选Pro会员权益总览.html',
        toolName: 'Write',
        op: 'write',
        ts: 1793098015835,
      });
      const byConversation = collectDoubaoSnapshotTouches(root);
      expect(byConversation.get(`doubao:${CONV_ID}`)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('坏 json / 无 conversationId → 空(容错)', () => {
    const root = mkdtempSync(join(tmpdir(), 'planofplan-doubao-bad-'));
    try {
      const f = join(root, 'bad.json');
      writeFileSync(f, '{broken json');
      expect(doubaoTouchesFromSnapshotFile(f)).toEqual([]);
      writeFileSync(f, JSON.stringify({ execution: {}, files: [{ absolutePath: '/tmp/x' }] }));
      expect(doubaoTouchesFromSnapshotFile(f)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
