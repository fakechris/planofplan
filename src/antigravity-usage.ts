import { Database } from 'bun:sqlite';
import { basename } from 'node:path';

// ── Google Antigravity usage(gen_metadata protobuf 解码) ─────────────
// 2026-08-31 本机实证:新版 IDE 在 ~/.gemini/antigravity/conversations/<uuid>.db
// 落盘 SQLite(trajectory_meta/steps/gen_metadata/…),gen_metadata.data 是
// protobuf blob,含每代生成的 ModelUsageStats。字段号与校验规则参照
// agentsview(MIT,antigravity.go,其对 sidecar 交叉验证 550/550):
//   field 1 chat_model { field 4 usage { 1=model enum[1000,5000)
//     2=input(未缓存) 3=output(含思考) 4=cache_write(弃用) 5=cache_read(可选) }
//     19=response_model(str) 21=model_display_name(str) }
// 旧版只有加密 .pb(conversations/*.pb)——不可读,按无 ledger 跳过。
// gen_metadata 无逐条时间戳:记录时间用 .db 文件 mtime 近似(会话粒度的
// 日分桶够用,近似口径记录在案)。旧版 brain transcript.jsonl 可读,是
// session catalog 的后续入口,usage 不依赖它。

/** 紧凑 protobuf wire 解析:足够走 chat_model→usage 这条固定路径。 */
interface ProtoField {
  num: number;
  varint?: bigint;
  bytes?: Uint8Array;
  nested?: ProtoField[] | null;
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  const start = pos;
  for (;;) {
    const b = buf[pos]!;
    pos += 1;
    value |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [value, pos - start];
    shift += 7n;
    if (shift > 63n) throw new Error('varint overflow');
  }
}

function parseProtoFields(buf: Uint8Array, depth: number, budget: { left: number }): ProtoField[] {
  const out: ProtoField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (budget.left <= 0) return out; // 内存上界:超预算返回已解析前缀
    budget.left -= 1;
    const [tag, tagLen] = readVarint(buf, pos);
    pos += tagLen;
    const num = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const [value, len] = readVarint(buf, pos);
      pos += len;
      out.push({ num, varint: value });
    } else if (wire === 2) {
      const [len, lenBytes] = readVarint(buf, pos);
      pos += lenBytes;
      const end = pos + Number(len);
      if (end > buf.length) throw new Error('length overrun');
      const bytes = buf.slice(pos, end);
      pos = end;
      let nested: ProtoField[] | null = null;
      if (depth < 8 && bytes.length > 1) {
        try {
          nested = parseProtoFields(bytes, depth + 1, budget);
        } catch {
          nested = null; // 非消息载荷(字符串等)保持 opaque
        }
      }
      out.push({ num, bytes, nested });
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error(`wire ${wire}`);
    }
  }
  return out;
}

const find = (fields: ProtoField[] | null | undefined, num: number): ProtoField | undefined =>
  fields?.find((field) => field.num === num);

const MAX_PLAUSIBLE_TOKENS = 10_000_000;

export interface AntigravityUsageRow {
  idx: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** ModelUsageStats 校验:model 枚举域 + 量级上限(防 decoy 块),照 agentsview。 */
function tokenBlockFrom(fields: ProtoField[]): AntigravityUsageRow | null {
  const model = find(fields, 1);
  const input = find(fields, 2);
  const output = find(fields, 3);
  const cacheRead = find(fields, 5);
  if (model?.varint === undefined || input?.varint === undefined || output?.varint === undefined) return null;
  const modelEnum = Number(model.varint);
  const inTok = Number(input.varint);
  const outTok = Number(output.varint);
  if (modelEnum < 1000 || modelEnum >= 5000) return null;
  if (inTok > MAX_PLAUSIBLE_TOKENS || outTok > MAX_PLAUSIBLE_TOKENS) return null;
  if (inTok + outTok > MAX_PLAUSIBLE_TOKENS) return null;
  return {
    idx: -1,
    model: String(modelEnum),
    inputTokens: inTok,
    outputTokens: outTok,
    cacheReadTokens: cacheRead?.varint !== undefined ? Number(cacheRead.varint) : 0,
  };
}

/**
 * 从单个 conversations/<uuid>.db 提取 usage 行(带 idx 稳定身份)。
 * 任何读取/解码失败返回空数组——旧版加密 .db 或损坏文件不拖垮扫描。
 */
export function extractAntigravityUsage(dbPath: string): AntigravityUsageRow[] {
  const rows: AntigravityUsageRow[] = [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const meta = db.query('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as Array<{
      idx: number;
      data: Uint8Array | Buffer;
    }>;
    for (const row of meta) {
      try {
        const budget = { left: 1 << 20 };
        const fields = parseProtoFields(Uint8Array.from(row.data), 0, budget);
        const chatModel = find(fields, 1)?.nested;
        if (!chatModel) continue;
        const block = tokenBlockFrom(find(chatModel, 4)?.nested ?? []);
        if (!block) continue;
        const display = find(chatModel, 21)?.bytes ?? find(chatModel, 19)?.bytes;
        const name = display ? Buffer.from(display).toString('utf8') : '';
        rows.push({ ...block, idx: row.idx, model: name || block.model });
      } catch {
        /* 单条 blob 解析失败跳过 */
      }
    }
  } catch {
    return rows; // 无 gen_metadata 表/不可读:空
  } finally {
    db?.close();
  }
  return rows;
}

/** 会话 id:文件名去 .db(uuid 即 Antigravity 的会话身份)。 */
export function antigravityConversationId(dbPath: string): string {
  return basename(dbPath).replace(/\.db$/i, '');
}
