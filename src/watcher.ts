import { watch, statSync, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import { sessionWatchRoots } from './sessions.ts';

// 静默窗 + 有界等待(参照 obelisk ADR-0009 的形态):活跃 session 持续追加时,
// 每次事件重置静默计时,但 maxWait 到点强制 flush——吵闹的写入者不能饿死索引。
const QUIET_MS = 1_200;
const MAX_WAIT_MS = 5_000;

/**
 * catalog 相关的文件名粗筛:拦掉 todos/缓存/截图等无关写带来的重扫风暴。
 * kimi wire.jsonl / grok chat_history.jsonl 是消息正文文件,目录行走
 * state.json / summary.json,但两者同目录树变化,粗筛放行即可。
 */
export function isRelevantWatchName(name: string): boolean {
  return name.endsWith('.jsonl')
    || name.endsWith('.jsonl.zstd')
    || name.endsWith('.jsonl.zst')
    || name === 'state.json'
    || name === 'summary.json'
    || name === 'db.sqlite';
}

export interface FlushScheduler {
  add(path: string): void;
  /** 丢弃未 flush 的路径并停表;不触发回调。 */
  stop(): void;
}

export function createFlushScheduler(
  onFlush: (paths: string[]) => void,
  quietMs = QUIET_MS,
  maxWaitMs = MAX_WAIT_MS,
): FlushScheduler {
  const pending = new Set<string>();
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let firstAt = 0;
  const fire = (): void => {
    if (quietTimer != null) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    const paths = [...pending];
    pending.clear();
    firstAt = 0;
    if (paths.length > 0) onFlush(paths);
  };
  return {
    add(path: string): void {
      if (firstAt === 0) firstAt = Date.now();
      pending.add(path);
      if (Date.now() - firstAt >= maxWaitMs) {
        fire();
        return;
      }
      if (quietTimer != null) clearTimeout(quietTimer);
      quietTimer = setTimeout(fire, quietMs);
    },
    stop(): void {
      if (quietTimer != null) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      pending.clear();
      firstAt = 0;
    },
  };
}

export interface SessionWatcher {
  /** 成功挂上监听的根目录。 */
  roots: string[];
  stop(): void;
}

/**
 * 监听各 provider 的 session 根目录(recursive),变更聚合后回调。
 * 单个根 watch 失败(目录不存在/平台不支持 recursive)只跳过该根,
 * 该 provider 退回「打开页面触发扫描」的现状,不影响其余根。
 */
export function startSessionWatcher(
  onFlush: (paths: string[]) => void,
  rootsOverride?: string[],
): SessionWatcher {
  const candidates = rootsOverride ?? sessionWatchRoots();
  const roots = candidates.filter((root) => {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
  const watchers: FSWatcher[] = [];
  const watchedRoots: string[] = [];
  // flush 时只报告仍然存在且是普通文件的路径:临时文件/重命名残影不值得触发扫描
  const scheduler = createFlushScheduler((paths) => {
    const alive = paths.filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
    if (alive.length > 0) onFlush(alive);
  });
  for (const root of roots) {
    try {
      const w = watch(root, { recursive: true }, (_event, filename) => {
        if (typeof filename !== 'string') return;
        const path = join(root, filename);
        if (!isRelevantWatchName(basename(path))) return;
        scheduler.add(path);
      });
      // 断流(目录被删/权限变化)只关掉这一个 watcher,不拖垮进程
      w.on('error', () => {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      });
      watchers.push(w);
      watchedRoots.push(root);
    } catch {
      /* 该根不可监听:保持无监听降级 */
    }
  }
  return {
    roots: watchedRoots,
    stop(): void {
      scheduler.stop();
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
