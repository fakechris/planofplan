/**
 * 豆包桌面版(DoubaoWork)会话源(INV-1790)。
 *
 * 数据源(实测 2026-11-10):
 * - 会话目录:`~/Library/Application Support/DoubaoWork/Default/IndexedDB/
 *   chrome_doubaowork-chat_0.indexeddb.leveldb`。会话对象(conversation_id /
 *   name / create_time / update_time,时间为秒级)以 V8 ValueSerializer 格式
 *   存于 leveldb value;sdk_storage/*.db 全部加密,本地无 token 消耗数据
 *   (消耗按 Unknown 处理,严禁捏造)。
 * - 编程 agent 文件快照:`~/Library/Application Support/DoubaoWork/coding/
 *   snapshot/<userId>/<conversationId>/<executionKey>/*.json`:execution 时间窗 ×
 *   files[].absolutePath,作为豆包会话的文件触碰证据(供 M3 commit 归因)。
 *
 * 读法选型(合同要求写明):Chromium 写入的 V8 payload 含 deserializer 拒收的
 * host tag,Node/Bun 的 v8.deserialize 均无法整体反序列化(实测 2026-11-10);
 * 完整自研 deserializer 的对齐在嵌套对象处失步。因此采用「锚定二进制模式
 * 提取」:以 `"conversation_id"` 属性名的 V8 字节序列(`22 0f` + 名)为锚,
 * 在锚点窗口内取 name/create_time/update_time 的标量值。.ldb(SSTable)需
 * 自研 footer→index→snappy→block 读取;.log(WAL)为明文直接扫。
 * 所有解析单点容错:任一文件/锚点失败跳过并记日志,不拖垮 daemon。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { SessionFileTouch, SessionRecord } from './types.ts';
import { opOfTool } from './file-touches.ts';

export function doubaoWorkRoot(): string {
  return process.env.DOUBAOWORK_HOME
    ?? join(homedir(), 'Library', 'Application Support', 'DoubaoWork');
}

/** chat 会话库(Chromium IndexedDB leveldb 目录)。 */
export function doubaoChatLdbDir(root?: string): string {
  return join(root ?? doubaoWorkRoot(), 'Default', 'IndexedDB', 'chrome_doubaowork-chat_0.indexeddb.leveldb');
}

/** 编程 agent 文件快照根。 */
export function doubaoSnapshotRoot(root?: string): string {
  return join(root ?? doubaoWorkRoot(), 'coding', 'snapshot');
}

// ── leveldb SSTable 读取(自研,只读) ────────────────────────────────

const LDB_MAGIC = 0xdb4775248b80fb57n;

function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    const b = buf[p++]!;
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result, p];
}

/** snappy 原始格式解压(literal/copy 指令流)。 */
export function snappyDecompress(data: Buffer): Buffer {
  const [length, start] = readVarint(data, 0);
  const out = new Uint8Array(length);
  let written = 0;
  let pos = start;
  const push = (byte: number): void => {
    if (written >= length) throw new Error('snappy output overflow');
    out[written++] = byte;
  };
  while (pos < data.length) {
    const tag = data[pos++]!;
    const t = tag & 3;
    if (t === 0) {
      let ln = tag >> 2;
      if (ln >= 60) {
        const extra = ln - 59;
        ln = 0;
        for (let i = 0; i < extra; i++) ln |= data[pos++]! << (8 * i);
      }
      ln += 1;
      if (pos + ln > data.length) throw new Error('snappy literal overrun');
      for (let i = 0; i < ln; i++) out[written++] = data[pos++]!;
    } else {
      let ln = 0;
      let offset = 0;
      if (t === 1) {
        ln = ((tag >> 2) & 7) + 4;
        offset = ((tag >> 5) << 8) | data[pos++]!;
      } else if (t === 2) {
        ln = (tag >> 2) + 1;
        offset = data[pos++]! | (data[pos++]! << 8);
      } else {
        ln = (tag >> 2) + 1;
        offset = data[pos++]! | (data[pos++]! << 8) | (data[pos++]! << 16) | (data[pos++]! << 24);
      }
      if (offset <= 0 || offset > written) throw new Error('snappy bad offset');
      for (let i = 0; i < ln; i++) {
        // 注意赋值左边引用先于右边求值:out[written++] = out[written-offset]
        // 会先自增再取源,offset 偏 1(实测踩坑)。先取值再写。
        const byte = out[written - offset]!;
        out[written] = byte;
        written += 1;
      }
    }
  }
  if (written !== length) throw new Error(`snappy length ${written} != ${length}`);
  return Buffer.from(out.buffer, 0, written);
}

/** SSTable block 内 entry 列表(尾部 restart array 定界)。 */
export function parseBlockEntries(block: Buffer): Array<[Buffer, Buffer]> {
  const restartCount = block.readUInt32LE(block.length - 4);
  const limit = block.length - 4 - restartCount * 4;
  if (limit < 0) throw new Error('bad restart array');
  const entries: Array<[Buffer, Buffer]> = [];
  let pos = 0;
  let prev = Buffer.alloc(0);
  while (pos < limit) {
    let shared: number, nonShared: number, valueLen: number;
    [shared, pos] = readVarint(block, pos);
    [nonShared, pos] = readVarint(block, pos);
    [valueLen, pos] = readVarint(block, pos);
    if (shared > prev.length || pos + nonShared + valueLen > limit) throw new Error('bad block entry');
    const key = Buffer.concat([prev.subarray(0, shared), block.subarray(pos, pos + nonShared)]);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLen);
    pos += valueLen;
    entries.push([key, value]);
    prev = key;
  }
  return entries;
}

function readBlock(raw: Buffer, offset: number, size: number): Buffer {
  const body = raw.subarray(offset, offset + size);
  const ctype = raw[offset + size] ?? 0;
  return ctype === 1 ? snappyDecompress(Buffer.from(body)) : Buffer.from(body);
}

/** 遍历一个 .ldb(SSTable)的全部 (key, value)。footer/index 损坏时返回已读部分。 */
export function iterLdbEntries(path: string): Array<[Buffer, Buffer]> {
  const raw = readFileSync(path);
  if (raw.length < 48) return [];
  const footer = raw.subarray(raw.length - 48);
  if (footer.readBigUInt64LE(footer.length - 8) !== LDB_MAGIC) return [];
  let pos = 0;
  let iOff = 0, iSize = 0;
  [, pos] = readVarint(footer, pos);
  [, pos] = readVarint(footer, pos);
  [iOff, pos] = readVarint(footer, pos);
  [iSize, pos] = readVarint(footer, pos);
  const out: Array<[Buffer, Buffer]> = [];
  let indexEntries: Array<[Buffer, Buffer]>;
  try {
    indexEntries = parseBlockEntries(readBlock(raw, iOff, iSize));
  } catch {
    return out;
  }
  for (const [, handle] of indexEntries) {
    let bOff = 0, bSize = 0, p = 0;
    [bOff, p] = readVarint(handle, p);
    [bSize, p] = readVarint(handle, p);
    try {
      out.push(...parseBlockEntries(readBlock(raw, bOff, bSize)));
    } catch {
      /* 单 block 损坏跳过 */
    }
  }
  return out;
}

// ── V8 锚定提取 ────────────────────────────────────────────────────

/** one-byte string 属性名的 V8 字节模式(`22 <len> <name>`)。 */
function attr(name: string): Buffer {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length > 127) throw new Error('attr too long');
  return Buffer.concat([Buffer.from([0x22, bytes.length]), bytes]);
}

const CID_ATTR = attr('conversation_id');
const NAME_ATTR = attr('name');
const CREATE_ATTR = attr('create_time');
const UPDATE_ATTR = attr('update_time');

export interface DoubaoConversation {
  conversationId: string;
  name: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

/** 属性名字节后的第一个标量值(string/int32/uint32/double;two-byte 的
 *  varint 是字节数——V8 WriteTwoByteString 写 byte length,实测 2026-11-10)。 */
function scalarAfter(win: Buffer, needle: Buffer): { value: string | number; end: number } | null {
  const at = win.indexOf(needle);
  if (at < 0) return null;
  const pos = at + needle.length;
  const tag = win[pos];
  if (tag === 0x22) {
    const [ln, p] = readVarint(win, pos + 1);
    if (p + ln > win.length) return null;
    return { value: win.subarray(p, p + ln).toString('utf8'), end: p + ln };
  }
  if (tag === 0x63) {
    const [ln, p] = readVarint(win, pos + 1);
    if (p + ln > win.length || ln % 2 !== 0) return null;
    return { value: win.subarray(p, p + ln).toString('utf16le'), end: p + ln };
  }
  if (tag === 0x49 || tag === 0x55) {
    const [v, p] = readVarint(win, pos + 1);
    const value = tag === 0x49 ? (v >> 1) ^ -(v & 1) : v;
    return { value, end: p };
  }
  if (tag === 0x4e) {
    if (pos + 9 > win.length) return null;
    const b = win.subarray(pos + 1, pos + 9);
    const value = b.readDoubleLE(0);
    return { value, end: pos + 9 };
  }
  return null;
}

/** 秒级时间戳(字符串或数字)→ ms;范围外视为无效。 */
function secondsToMs(value: string | number): number | null {
  const sec = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(sec) || sec < 1e9 || sec > 4e9) return null;
  return sec * 1000;
}

/**
 * 从一段原始字节(leveldb value 或 WAL 明文)锚定提取会话对象。
 * 锚 = `"conversation_id"` 属性名;窗口 = 到下一个锚(≤6KB)。
 */
export function doubaoConversationsFromBytes(raw: Buffer): DoubaoConversation[] {
  const out: DoubaoConversation[] = [];
  let from = 0;
  for (;;) {
    const at = raw.indexOf(CID_ATTR, from);
    if (at < 0) break;
    const next = raw.indexOf(CID_ATTR, at + 1);
    const win = raw.subarray(at, next > 0 && next - at <= 6144 ? next : Math.min(raw.length, at + 6144));
    const id = scalarAfter(win, CID_ATTR);
    const idText = id == null ? null
      : typeof id.value === 'string' ? (/^\d{6,24}$/.test(id.value) ? id.value : null)
      : /^\d{6,24}$/.test(String(id.value)) ? String(id.value) : null;
    if (idText) {
      const nameHit = scalarAfter(win, NAME_ATTR);
      const createdHit = scalarAfter(win, CREATE_ATTR);
      const updatedHit = scalarAfter(win, UPDATE_ATTR);
      const name = nameHit == null ? null
        : typeof nameHit.value === 'string' && nameHit.value.trim() ? nameHit.value.trim() : null;
      out.push({
        conversationId: idText,
        name,
        createdAtMs: createdHit ? secondsToMs(createdHit.value) : null,
        updatedAtMs: updatedHit ? secondsToMs(updatedHit.value) : null,
      });
    }
    from = at + CID_ATTR.length;
  }
  return out;
}

/** 会话目录:遍历 leveldb 目录(.ldb 解 SSTable + .log 明文),同 id 取 update_time 最新。 */
export function extractDoubaoSessions(ldbDir: string, mtimeMs: number): SessionRecord[] {
  if (!existsSync(ldbDir)) return [];
  const byId = new Map<string, DoubaoConversation>();
  let names: string[] = [];
  try {
    names = readdirSync(ldbDir).filter((n) => n.endsWith('.ldb') || n.endsWith('.log'));
  } catch {
    return [];
  }
  for (const name of names.sort()) {
    const path = join(ldbDir, name);
    try {
      const chunks: Buffer[] = name.endsWith('.ldb')
        ? iterLdbEntries(path).map(([, v]) => v)
        : [readFileSync(path)];
      for (const chunk of chunks) {
        for (const conv of doubaoConversationsFromBytes(chunk)) {
          const prev = byId.get(conv.conversationId);
          if (!prev || (conv.updatedAtMs ?? 0) >= (prev.updatedAtMs ?? 0)) {
            byId.set(conv.conversationId, prev && conv.name == null && prev.name != null
              ? { ...conv, name: prev.name, createdAtMs: conv.createdAtMs ?? prev.createdAtMs }
              : conv);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[doubao] skip ${path}: ${message}`);
    }
  }
  return [...byId.values()].map((conv) => ({
    id: `doubao:${conv.conversationId}`,
    provider: 'doubao',
    nativeId: conv.conversationId,
    cwd: null,
    title: conv.name,
    sourceFile: ldbDir,
    startedAt: conv.createdAtMs,
    updatedAt: conv.updatedAtMs ?? mtimeMs,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
  }));
}

// ── coding/snapshot 文件触碰 ───────────────────────────────────────

/** snapshot json → 该次 execution 的文件触碰(execution 时间窗 × files[].absolutePath)。 */
export function doubaoTouchesFromSnapshotFile(path: string): SessionFileTouch[] {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const root = doc as Record<string, unknown>;
  const execution = root.execution && typeof root.execution === 'object'
    ? root.execution as Record<string, unknown> : {};
  const conversationId = typeof execution.conversationId === 'string' ? execution.conversationId : null;
  const executionKey = typeof execution.executionKey === 'string' ? execution.executionKey : basename(path).replace(/\.json$/i, '');
  const startedAtMs = typeof execution.startedAtMs === 'number' && Number.isFinite(execution.startedAtMs)
    ? execution.startedAtMs : null;
  if (!conversationId) return [];
  const files = Array.isArray(root.files) ? root.files : [];
  const touches: SessionFileTouch[] = [];
  files.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const file = entry as Record<string, unknown>;
    const filePath = typeof file.absolutePath === 'string' && file.absolutePath.startsWith('/')
      ? file.absolutePath : null;
    if (!filePath) return;
    const toolName = typeof file.firstToolName === 'string' && file.firstToolName
      ? file.firstToolName
      : typeof file.changeType === 'string' && file.changeType ? file.changeType : 'snapshot';
    touches.push({
      id: `doubao:${conversationId}:${executionKey}:${index}`,
      sessionId: `doubao:${conversationId}`,
      provider: 'doubao',
      filePath,
      toolName,
      op: opOfTool(toolName),
      ts: startedAtMs,
      ordinal: index,
    });
  });
  return touches;
}

/** snapshot 目录 → conversationId → touches(供 catalog 每轮全量重导,幂等 id)。 */
export function collectDoubaoSnapshotTouches(root?: string): Map<string, SessionFileTouch[]> {
  const snapRoot = root ?? doubaoSnapshotRoot();
  const byConversation = new Map<string, SessionFileTouch[]>();
  if (!existsSync(snapRoot)) return byConversation;
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        for (const touch of doubaoTouchesFromSnapshotFile(path)) {
          const list = byConversation.get(touch.sessionId) ?? [];
          list.push(touch);
          byConversation.set(touch.sessionId, list);
        }
      }
    }
  };
  visit(snapRoot);
  return byConversation;
}
