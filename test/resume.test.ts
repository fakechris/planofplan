import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { _clearBinCache, findExecutable, resumeFor } from '../src/resume.ts';
import type { SessionRecord } from '../src/types.ts';

function session(partial: Partial<SessionRecord> & Pick<SessionRecord, 'id' | 'provider' | 'nativeId'>): SessionRecord {
  return {
    cwd: '/tmp/demo',
    title: 'demo',
    sourceFile: '/tmp/x',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    seenAt: Date.now(),
    ...partial,
  };
}

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'planofplan-bins-'));
}

function writeBin(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

describe('resume CLI discovery', () => {
  test('finds grok/droid/kimi in home bins when PATH is empty', () => {
    const home = fakeHome();
    try {
      const grok = writeBin(join(home, '.grok', 'bin'), 'grok');
      const droid = writeBin(join(home, '.local', 'bin'), 'droid');
      const kimi = writeBin(join(home, '.kimi-code', 'bin'), 'kimi');
      _clearBinCache();
      const lookup = { home, path: '/usr/bin:/bin' };
      expect(findExecutable(['grok'], lookup)).toBe(grok);
      expect(findExecutable(['droid'], lookup)).toBe(droid);
      expect(findExecutable(['kimi', 'kimi-cli'], lookup)).toBe(kimi);

      const grokResume = resumeFor(session({
        id: 'grok:abc',
        provider: 'grok',
        nativeId: 'abc',
      }), lookup);
      expect(grokResume.available).toBe(true);
      expect(grokResume.command).toContain('--resume');
      expect(grokResume.command).toContain('abc');

      const droidResume = resumeFor(session({
        id: 'factory:abc',
        provider: 'factory',
        nativeId: 'abc',
      }), lookup);
      expect(droidResume.available).toBe(true);
      expect(droidResume.command).toContain(droid);

      const kimiResume = resumeFor(session({
        id: 'kimi:abc',
        provider: 'kimi',
        nativeId: 'abc',
      }), lookup);
      expect(kimiResume.available).toBe(true);
      expect(kimiResume.command).toContain('--session');
    } finally {
      rmSync(home, { recursive: true, force: true });
      _clearBinCache();
    }
  });

  test('broken Homebrew Codex node wrapper is skipped for a working binary', () => {
    const home = fakeHome();
    const brokenDir = join(home, 'broken');
    const goodDir = join(home, 'good');
    try {
      mkdirSync(join(brokenDir, 'node_modules'), { recursive: true });
      const wrapper = join(brokenDir, 'codex');
      writeFileSync(wrapper, '#!/usr/bin/env node\nprocess.exit(1)\n');
      chmodSync(wrapper, 0o755);
      const good = writeBin(goodDir, 'codex');
      _clearBinCache();
      const found = findExecutable(['codex'], { home, path: '', extraDirs: [brokenDir, goodDir] });
      expect(found).toBe(good);
    } finally {
      rmSync(home, { recursive: true, force: true });
      _clearBinCache();
    }
  });

  test('claude prefers claude.sh over bare claude', () => {
    const home = fakeHome();
    try {
      const wrapper = writeBin(join(home, '.local', 'bin'), 'claude.sh');
      writeBin(join(home, '.local', 'bin'), 'claude');
      _clearBinCache();
      const info = resumeFor(session({
        id: 'claude:abc',
        provider: 'claude',
        nativeId: 'abc',
      }), { home, path: '', extraDirs: [join(home, '.local', 'bin')], resume: {} });
      expect(info.available).toBe(true);
      expect(info.command).toContain(wrapper);
      expect(info.command).toContain('--resume');
    } finally {
      rmSync(home, { recursive: true, force: true });
      _clearBinCache();
    }
  });

  test('config bin override wins for claude', () => {
    const home = fakeHome();
    try {
      writeBin(join(home, '.local', 'bin'), 'claude.sh');
      const glm = writeBin(join(home, '.local', 'bin'), 'glm-claude.sh');
      _clearBinCache();
      const info = resumeFor(session({
        id: 'claude:abc',
        provider: 'claude',
        nativeId: 'abc',
      }), {
        home,
        path: '',
        extraDirs: [join(home, '.local', 'bin')],
        resume: { claude: { bin: glm } },
      });
      expect(info.command).toContain(glm);
    } finally {
      rmSync(home, { recursive: true, force: true });
      _clearBinCache();
    }
  });

  test('dsh resume is a web URL, not TUI', () => {
    const info = resumeFor(session({
      id: 'dsh:session-1',
      provider: 'dsh',
      nativeId: 'session-1',
    }), { resume: { dsh: { kind: 'url', url: 'http://127.0.0.1:3080/' } } });
    expect(info.available).toBe(true);
    expect(info.kind).toBe('url');
    expect(info.label).toBe('打开 DSH');
    expect(info.command).toBe('http://127.0.0.1:3080/');
  });

  test('zcode without the GUI app is unavailable', () => {
    const info = resumeFor(session({
      id: 'zcode:1',
      provider: 'zcode',
      nativeId: '1',
    }), { resume: { zcode: { kind: 'app', app: 'NoSuchZCodeApp' } } });
    expect(info.available).toBe(false);
  });
});
