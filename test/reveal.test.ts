import { describe, expect, test } from 'bun:test';
import { revealCommand, revealInFileManager } from '../src/reveal.ts';

describe('reveal command selection (INV-563)', () => {
  test('darwin 用 open -R', () => {
    expect(revealCommand('/tmp/a.jsonl', 'darwin')).toEqual({ argv: ['open', '-R', '/tmp/a.jsonl'], okStatuses: [0] });
  });

  test('win32 用 explorer /select, 且退出码 1 也算成功', () => {
    expect(revealCommand('C:\\l\\a.jsonl', 'win32')).toEqual({
      argv: ['explorer', '/select,C:\\l\\a.jsonl'],
      okStatuses: [0, 1],
    });
  });

  test('linux 打开所在目录', () => {
    const cmd = revealCommand('/home/u/.claude/a.jsonl', 'linux');
    expect(cmd?.argv).toEqual(['xdg-open', '/home/u/.claude']);
  });

  test('未知平台返回 null,执行器显式报错', () => {
    expect(revealCommand('/x', 'sunos')).toBeNull();
    expect(revealInFileManager('/x', 'sunos')).toEqual({ ok: false, error: '当前平台不支持在文件管理器中显示' });
  });
});
