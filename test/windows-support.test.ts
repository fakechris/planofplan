/**
 * INV-563 Windows 平台适配:在 darwin 开发机上以注入 platform='win32'
 * 验证各模块 Windows 分支的纯函数行为,不依赖真实 Windows 环境。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { cursorDbCandidates } from '../src/adapters/cursor.ts';
import { claudeCredentialsFilePath, readClaudeCredentialsFile } from '../src/adapters/claude.ts';
import { parseWin32ProxySettings } from '../src/adapters/agy.ts';
import {
  WINDOWS_STARTUP_SCRIPT,
  getStartupSettings,
  isLaunchOnStartupSupported,
  setLaunchOnStartup,
  windowsStartupDir,
  windowsStartupScriptPath,
} from '../src/startup.ts';
import {
  _clearBinCache,
  binNameVariants,
  codexPlatformVariant,
  cmdQuote,
  findExecutable,
  resolveCodexNative,
  resumeFor,
  windowsLaunchArgv,
} from '../src/resume.ts';
import type { SessionRecord } from '../src/types.ts';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'planofplan-win32-'));
  tempDirs.push(dir);
  return dir;
}

function writeBin(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('cursor: state.vscdb 平台路径 (INV-563)', () => {
  test('win32 解析 %APPDATA%\\Cursor', () => {
    const home = tempDir();
    const candidates = cursorDbCandidates('win32', home, { APPDATA: join(home, 'AppData', 'Roaming') });
    expect(candidates).toEqual([
      join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    ]);
  });

  test('win32 缺 %APPDATA% 时兜底 AppData/Roaming', () => {
    const home = tempDir();
    const candidates = cursorDbCandidates('win32', home, {});
    expect(candidates[0]).toContain(join('AppData', 'Roaming'));
  });

  test('darwin/linux 分支保持原样', () => {
    const home = tempDir();
    expect(cursorDbCandidates('darwin', home, {})).toEqual([
      join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    ]);
    expect(cursorDbCandidates('linux', home, {})).toEqual([
      join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    ]);
  });
});

describe('claude: ~/.claude/.credentials.json 兜底 (INV-563)', () => {
  test('解析 claudeAiOauth JSON 并支持刷新后原位回写', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.claude'), { recursive: true });
    const credPath = claudeCredentialsFilePath(home);
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: 'tok-1', refreshToken: 'r1', expiresAt: 123, scopes: ['user:profile'] },
    }), { encoding: 'utf8' });

    const cred = readClaudeCredentialsFile(home);
    expect(cred).not.toBeNull();
    expect(cred!.kind).toBe('bearer');
    expect(cred!.source).toBe('auto');
    expect(cred!.value).toBe('tok-1');
    expect(cred!.refreshToken).toBe('r1');
    expect(cred!.expiresAt).toBe(123);

    await cred!.persist!({ accessToken: 'tok-2', refreshToken: 'r2', expiresAt: 456 });
    const rotated = readClaudeCredentialsFile(home);
    expect(rotated!.value).toBe('tok-2');
    expect(rotated!.refreshToken).toBe('r2');
    expect(rotated!.expiresAt).toBe(456);
  });

  test('文件缺失或结构不符返回 null', () => {
    const home = tempDir();
    expect(readClaudeCredentialsFile(home)).toBeNull();

    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(claudeCredentialsFilePath(home), '{"other":1}', { encoding: 'utf8' });
    expect(readClaudeCredentialsFile(home)).toBeNull();
  });
});

describe('agy: Windows 注册表代理解析 (INV-563)', () => {
  test('ProxyEnable=1 + host:port → HTTP/HTTPS 代理', () => {
    const out = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ    127.0.0.1:7890',
      '    ProxyOverride    REG_SZ    localhost;<local>',
    ].join('\r\n');
    expect(parseWin32ProxySettings(out)).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      http_proxy: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
    });
  });

  test('per-protocol 形式与 socks 协议', () => {
    const out = 'ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    http=10.0.0.1:8080;https=10.0.0.1:8443;socks=10.0.0.2:1080';
    const env = parseWin32ProxySettings(out);
    expect(env.HTTP_PROXY).toBe('http://10.0.0.1:8080');
    expect(env.HTTPS_PROXY).toBe('http://10.0.0.1:8443');
    expect(env.ALL_PROXY).toBe('socks5://10.0.0.2:1080');
  });

  test('未启用(0x0)或输出为空 → 空 env', () => {
    expect(parseWin32ProxySettings('ProxyEnable    REG_DWORD    0x0')).toEqual({});
    expect(parseWin32ProxySettings('')).toEqual({});
  });
});

describe('startup: Windows 启动文件夹自启 (INV-563)', () => {
  test('win32 支持自启;开关写/删 planofplan-daemon.cmd', () => {
    const dir = tempDir();
    process.env.PLANOFPPLAN_STARTUP_DIR = dir;
    try {
      expect(isLaunchOnStartupSupported('win32')).toBe(true);
      expect(windowsStartupDir('win32', process.env)).toBe(dir);
      expect(getStartupSettings('win32').launchOnStartup).toEqual({ available: true, enabled: false });

      const result = setLaunchOnStartup(true, 'win32');
      expect(result.ok).toBe(true);
      expect(result.enabled).toBe(true);
      expect(result.restarting).toBe(false);

      const scriptPath = windowsStartupScriptPath('win32');
      expect(scriptPath).toBe(join(dir, WINDOWS_STARTUP_SCRIPT));
      const content = readFileSync(scriptPath!, 'utf8');
      expect(content).toContain('serve');
      expect(content).toContain(process.execPath);

      expect(getStartupSettings('win32').launchOnStartup.enabled).toBe(true);

      const off = setLaunchOnStartup(false, 'win32');
      expect(off.enabled).toBe(false);
      expect(existsSync(scriptPath!)).toBe(false);
    } finally {
      delete process.env.PLANOFPPLAN_STARTUP_DIR;
    }
  });

  test('linux 不支持自启', () => {
    expect(isLaunchOnStartupSupported('linux')).toBe(false);
    expect(getStartupSettings('linux').launchOnStartup).toEqual({ available: false, enabled: false });
    expect(() => setLaunchOnStartup(true, 'linux')).toThrow();
  });
});

describe('resume: Windows 二进制定位与终端启动 (INV-563)', () => {
  test('codexPlatformVariant:win32 三元组与 npm 包名', () => {
    expect(codexPlatformVariant('win32', 'x64')).toEqual({
      triple: 'x86_64-pc-windows-msvc',
      pkg: '@openai/codex-win32-x64',
      binNames: ['codex.exe', 'codex'],
    });
    expect(codexPlatformVariant('win32', 'arm64')?.pkg).toBe('@openai/codex-win32-arm64');
    expect(codexPlatformVariant('darwin', 'arm64')?.triple).toBe('aarch64-apple-darwin');
    expect(codexPlatformVariant('linux', 'x64')).toBeNull();
  });

  test('resolveCodexNative 定位 win32 vendor codex.exe', () => {
    const pkgRoot = tempDir();
    const vendorBin = writeBin(
      join(pkgRoot, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex'),
      'codex.exe',
    );
    // wrapper 路径只用于推导 pkgRoot(<pkgRoot>/bin/codex),文件本身无需存在
    const resolved = resolveCodexNative(join(pkgRoot, 'bin', 'codex'), 'win32', 'x64');
    expect(resolved).toBe(vendorBin);
  });

  test('binNameVariants:win32 补 .cmd/.exe/.bat 后缀', () => {
    expect(binNameVariants('claude', 'win32')).toEqual(['claude', 'claude.cmd', 'claude.exe', 'claude.bat']);
    expect(binNameVariants('codex.exe', 'win32')).toEqual(['codex.exe']);
    expect(binNameVariants('claude', 'darwin')).toEqual(['claude']);
  });

  test('win32 以分号分隔 PATH 并能命中 npm shim(.cmd)', () => {
    const home = tempDir();
    const shimDir = join(home, 'AppData', 'Roaming', 'npm');
    const shim = writeBin(shimDir, 'claude.cmd');
    _clearBinCache();
    const lookup = { home, path: `C:\\Windows\\System32;${shimDir}`, platform: 'win32' };
    expect(findExecutable(['claude'], lookup)).toBe(shim);
  });

  test('windowsLaunchArgv:优先 wt,退回 cmd start;env 以 set 注入', () => {
    const command = { argv: ['/usr/bin/claude', '--resume', 's1'], env: { FOO: 'bar' } };
    const withWt = windowsLaunchArgv(command, { cwd: 'C:\\work' }, true);
    expect(withWt[0]).toBe('wt.exe');
    expect(withWt).toContain('C:\\work');
    expect(withWt.at(-1)).toContain('set "FOO=bar"');
    expect(withWt.at(-1)).toContain('--resume s1');

    const withoutWt = windowsLaunchArgv(command, { cwd: null }, false);
    expect(withoutWt.slice(0, 4)).toEqual(['cmd.exe', '/c', 'start', 'planofplan']);
    expect(withoutWt).toContain('.');
  });

  test('cmdQuote:含空格时双引号包裹', () => {
    expect(cmdQuote('plain')).toBe('plain');
    expect(cmdQuote('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
    expect(cmdQuote('')).toBe('""');
  });

  test('resumeFor:win32 下可发现 .cmd shim 并给出 cmd 风格展示', () => {
    const home = tempDir();
    const shimDir = join(home, 'AppData', 'Roaming', 'npm');
    writeBin(shimDir, 'claude.cmd');
    _clearBinCache();
    const info = resumeFor(
      {
        id: 'claude:1',
        provider: 'claude',
        nativeId: 'abc',
        cwd: 'C:\\work',
        title: 'demo',
        sourceFile: 'C:\\l\\a.jsonl',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: null,
        seenAt: Date.now(),
      } satisfies SessionRecord,
      { home, platform: 'win32' },
    );
    expect(info.available).toBe(true);
    expect(info.command).toContain('claude.cmd');
  });
});
