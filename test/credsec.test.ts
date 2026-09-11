import { describe, expect, test } from 'bun:test';
import { redactSecrets } from '../src/redact.ts';
import { readCredential } from '../src/auth.ts';

describe('redactSecrets 日志脱敏', () => {
  test('JSON 字段形态:常见密钥字段值被替换,普通字段保留', () => {
    const line = '{"access_token":"sk-abc123","refresh_token":"rt-xyz","model":"kimi-k3","used":500}';
    const out = redactSecrets(line);
    expect(out).toContain('"access_token":"[REDACTED]"');
    expect(out).toContain('"refresh_token":"[REDACTED]"');
    expect(out).toContain('"model":"kimi-k3"');
    expect(out).not.toContain('sk-abc123');
    expect(out).toContain('"used":500');
  });

  test('HTTP 头形态:Authorization/Cookie 被脱敏,数字统计不误杀', () => {
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'))
      .toBe('Authorization: [REDACTED]');
    expect(redactSecrets('cookie: session=deadbeef; path=/'))
      .toBe('cookie: [REDACTED]; path=/');
    // 计数文案("input token: 500")不能被当密钥吞掉
    expect(redactSecrets('input token: 500, output token: 42')).toBe('input token: 500, output token: 42');
  });

  test('k=v 形态与裸 Bearer 串', () => {
    expect(redactSecrets('refresh_token=rt-secret-999&grant_type=refresh_token'))
      .toBe('refresh_token=[REDACTED]&grant_type=refresh_token');
    expect(redactSecrets('header was Bearer abcdef123456')).toBe('header was Bearer [REDACTED]');
    expect(redactSecrets('nothing secret-ish here 纯中文日志')).toBe('nothing secret-ish here 纯中文日志');
  });
});

describe('readCredential env: 前缀', () => {
  test('env:VAR 从环境变量读,未设置返回 null,普通 id 不受影响', () => {
    const env = { KIMI_WORK_KEY: '  env-key-value  ' };
    expect(readCredential('env:KIMI_WORK_KEY', env)).toEqual({ kind: 'bearer', value: 'env-key-value' });
    expect(readCredential('env:NOT_SET_VAR', env)).toBeNull();
    // 空 var 名与裸 env: 防御
    expect(readCredential('env:', env)).toBeNull();
    expect(readCredential('env:', {})).toBeNull();
    // 普通 id 走 credentials.json 路径(此处无该文件,返回 null 或文件内容)
    const byId = readCredential('definitely-not-a-stored-id', env);
    expect(byId === null || typeof byId.value === 'string').toBe(true);
  });
});
