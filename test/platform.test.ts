import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { appDataDir } from '../src/platform.ts';

describe('platform helpers (INV-563)', () => {
  test('win32 优先取 %APPDATA%', () => {
    expect(appDataDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'))
      .toBe('C:\\Users\\u\\AppData\\Roaming');
  });

  test('win32 缺 %APPDATA% 时按 USERPROFILE 布局兜底', () => {
    expect(appDataDir({}, 'win32', 'C:\\Users\\u'))
      .toBe(join('C:\\Users\\u', 'AppData', 'Roaming'));
    expect(appDataDir({ APPDATA: '  ' }, 'win32', 'C:\\Users\\u'))
      .toBe(join('C:\\Users\\u', 'AppData', 'Roaming'));
  });

  test('非 win32 恒为 null(macOS/Linux 无 %APPDATA% 概念)', () => {
    expect(appDataDir({ APPDATA: '/x' }, 'darwin', '/Users/u')).toBeNull();
    expect(appDataDir({}, 'linux', '/home/u')).toBeNull();
  });
});
