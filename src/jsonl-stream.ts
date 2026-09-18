import { closeSync, openSync, readSync } from 'node:fs';

/** Read complete JSONL lines without repeatedly copying/decoding a growing string.
 * Byte offsets belong to L0 bytes, never re-encoded replacement characters. */
export function forEachJsonlLine(path: string, fromBytes: number, visit: (text: string, end: number) => void, includeTail = false): number {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let position = fromBytes;
  let consumed = fromBytes;
  let pieces: Buffer[] = [];
  let length = 0;
  try {
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, position)) > 0) {
      const chunkStart = position;
      position += count;
      let start = 0;
      while (start < count) {
        const newline = buffer.indexOf(10, start);
        const complete = newline >= 0 && newline < count;
        const end = complete ? newline : count;
        const piece = buffer.subarray(start, end);
        if (!complete) {
          pieces.push(Buffer.from(piece));
          length += piece.length;
          break;
        }
        let text: string;
        if (pieces.length === 0) text = piece.toString('utf8');
        else {
          pieces.push(piece);
          text = Buffer.concat(pieces, length + piece.length).toString('utf8');
          pieces = [];
          length = 0;
        }
        consumed = chunkStart + newline + 1;
        visit(text, consumed);
        start = newline + 1;
      }
    }
    if (includeTail && length > 0) {
      visit(Buffer.concat(pieces, length).toString('utf8'), position);
      consumed = position;
    }
    return consumed; // Incremental callers leave incomplete tails behind the watermark.
  } finally { closeSync(fd); }
}

/** Stop reading immediately after the header; never load the transcript body. */
export function firstJsonlLine(path: string): string | null {
  const found = {};
  let first: string | null = null;
  try {
    forEachJsonlLine(path, 0, (line) => { first = line; throw found; }, true);
  } catch (error) {
    if (error !== found) throw error;
  }
  return first;
}
