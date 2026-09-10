import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAgentStatus,
  pollClaude,
  pollCodex,
  resetAgentStatusCache,
  updateSlots,
  type AgentView,
} from '../src/agent-status.ts';

const view = (source: string, name: string, state: number): AgentView =>
  ({ source, name, state, progress: 255, text: name });

describe('agent-status slot merge', () => {
  test('caps at four and evicts low priority when needs-you arrives', () => {
    resetAgentStatusCache();
    const working = Array.from({ length: 9 }, (_, i) => view('codex', `job${i}`, 1));
    expect(updateSlots(working)).toHaveLength(4);
    const urgent = view('dsh', 'approval', 2);
    const visible = updateSlots([...working, urgent]).filter(Boolean);
    expect(visible).toHaveLength(4);
    expect(visible).toContainEqual(urgent);
  });

  test('keeps a session in its slot across polls until it disappears', () => {
    resetAgentStatusCache();
    updateSlots([view('codex', 'alpha', 1), view('codex', 'beta', 1)]);
    const still = updateSlots([view('codex', 'alpha', 1), view('codex', 'beta', 1)]);
    expect(still.map((v) => v?.name ?? null)).toEqual(['alpha', 'beta', null, null]);
    const gone = updateSlots([view('codex', 'beta', 1)]);
    expect(gone[0]).toBeNull();
    expect(gone[1]?.name).toBe('beta');
  });
});

describe('agent-status pollers (injected roots)', () => {
  let home = '';
  const now = Date.now();

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'planofplan-agent-'));
    // codex: fresh active / failed / stale completed
    const sess = join(home, '.codex', 'sessions', 's1');
    mkdirSync(sess, { recursive: true });
    writeFileSync(join(sess, 'meta.json'), JSON.stringify({ status: 'active', title: 'refactor', updated_at: now / 1000 }));
    const sess2 = join(home, '.codex', 'sessions', 's2');
    mkdirSync(sess2, { recursive: true });
    writeFileSync(join(sess2, 'meta.json'), JSON.stringify({ status: 'failed', title: 'broken', updated_at: now / 1000 }));
    // claude: fresh hook file
    const hookDir = join(home, '.config', 'deskpet-sender');
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'claude-1.json'), JSON.stringify({ state: 'needs', cwd: '/tmp/proj', text: 'approve rm -rf', time: now / 1000 }));
    // zcode: fresh rollout
    const rollout = join(home, '.zcode', 'cli', 'rollout');
    mkdirSync(rollout, { recursive: true });
    writeFileSync(join(rollout, 'a.jsonl'), 'x');
    utimesSync(join(rollout, 'a.jsonl'), new Date(), new Date());
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('codex maps status+freshness to the 6-state model', () => {
    const views = pollCodex(home);
    const byName = Object.fromEntries(views.map((v) => [v.name, v.state]));
    expect(byName.refactor).toBe(1);
    expect(byName.broken).toBe(4);
  });

  test('claude hook file wins with needs-you state', () => {
    const views = pollClaude(home);
    expect(views).toHaveLength(1);
    expect(views[0].state).toBe(2);
    expect(views[0].text).toBe('approve rm -rf');
  });

  test('full pipeline: fresh zcode surfaces, down sources stay absent', async () => {
    resetAgentStatusCache();
    const snap = await getAgentStatus({ home, disabled: 'amp,droid,grok,agy', force: true });
    expect(snap.slots).toHaveLength(4);
    const occupied = snap.slots.filter((s) => s.occupied);
    expect(occupied.map((s) => s.source)).toContain('zcode');
    for (const s of occupied) {
      expect(s.state).toBeGreaterThanOrEqual(0);
      expect(s.state).toBeLessThanOrEqual(5);
    }
    for (const s of snap.slots.filter((s) => !s.occupied)) {
      expect(s.state).toBe(0);
    }
  });
});
