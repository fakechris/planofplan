import { describe, expect, test } from 'bun:test';
import { buildConversationTail, type TailMessage } from '../src/handoff-tail.ts';

function conversation(n: number, size = 300): TailMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    ordinal: i + 1,
    role: i % 3 === 2 ? 'tool' : i % 3 === 0 ? 'user' : 'assistant',
    toolName: i % 3 === 2 ? 'Bash' : null,
    text: `message ${i + 1} ${'x'.repeat(size)}`,
  }));
}

describe('buildConversationTail', () => {
  test('stays within the budget however long the session is', () => {
    for (const n of [1, 10, 200, 3000]) {
      for (const budget of [2_000, 8_000, 16_000]) {
        const tail = buildConversationTail(conversation(n), { charBudget: budget, sessionId: 'claude:s' });
        expect(tail.markdown.length).toBeLessThanOrEqual(budget);
        expect(tail.verbatim + tail.condensed + tail.omitted).toBe(n);
      }
    }
  });

  test('keeps the newest messages verbatim and drops the oldest first', () => {
    const tail = buildConversationTail(conversation(500), { charBudget: 6_000, sessionId: 'claude:s' });
    expect(tail.markdown).toContain('message 500 ');
    expect(tail.markdown).not.toContain('message 1 x');
    expect(tail.omitted).toBeGreaterThan(0);
    // omitted messages are the oldest ones and the reader is told how to fetch them
    expect(tail.markdown).toContain(`read_session`);
    expect(tail.markdown).toContain(`offset=1`);
    expect(tail.markdown).toContain(`${tail.omitted} `);
  });

  test('tool output is compressed to a short preview with the dropped size stated', () => {
    const messages: TailMessage[] = [
      { ordinal: 1, role: 'user', toolName: null, text: 'run the tests' },
      { ordinal: 2, role: 'tool', toolName: 'Bash', text: 'y'.repeat(5_000) },
      { ordinal: 3, role: 'assistant', toolName: null, text: 'all green' },
    ];
    const tail = buildConversationTail(messages, { charBudget: 8_000, sessionId: 'claude:s' });
    expect(tail.verbatim).toBe(3);
    expect(tail.markdown).not.toContain('y'.repeat(500));
    expect(tail.markdown).toMatch(/\[tool:Bash\] y+…\(\+4\d{3} chars omitted\)/);
    expect(tail.toolCompressed).toBe(1);
  });

  test('reports its size as characters with an explicitly estimated token count', () => {
    const tail = buildConversationTail(conversation(20), { charBudget: 8_000, sessionId: 'claude:s' });
    expect(tail.chars).toBe(tail.markdown.length);
    expect(tail.markdown).toContain(`${tail.chars} chars`);
    expect(tail.markdown).toMatch(/≈\d+ tokens \(estimated\)/);
  });

  test('an empty session says so instead of rendering nothing', () => {
    const tail = buildConversationTail([], { charBudget: 4_000, sessionId: 'claude:s' });
    expect(tail.markdown).toContain('没有已索引的消息');
    expect(tail.verbatim + tail.condensed + tail.omitted).toBe(0);
  });

  test('a scoped tail points at its own omitted ordinals with a bounded page', () => {
    // requirement span: session ordinals 40..339, older ones belong to another requirement
    const scoped = conversation(300).map((m) => ({ ...m, ordinal: m.ordinal + 39 }));
    const tail = buildConversationTail(scoped, { charBudget: 4_000, sessionId: 'claude:s' });
    expect(tail.omitted).toBeGreaterThan(100);
    expect(tail.markdown).toContain('offset=40 limit=100');
    expect(tail.markdown).toContain(`第 40–${39 + tail.omitted} 条`);
    expect(tail.markdown).not.toContain('offset=1 ');
  });
});

