import { expect, test } from 'bun:test';
import { openMemoryDb } from '../src/db.ts';
import { createServer } from '../src/server.ts';

test('startup and HTTP refresh use the same scanner queue, including usage', async () => {
  const store = openMemoryDb();
  const calls: string[][] = [];
  const finish: Array<(code: number) => void> = [];
  const app = createServer(store, {} as never, { port: 9291, plans: [] }, {
    startupScan: true,
    spawnScan: (args) => { calls.push(args); return { exited: new Promise<number>((resolve) => finish.push(resolve)) }; },
  });
  try {
    expect(calls).toEqual([['sessions', '--refresh', '--days', '90']]);
    for (let i = 0; i < 3; i++) expect((await app.request('http://localhost/api/sessions?refresh=1')).status).toBe(200);
    expect(calls).toHaveLength(1);
    finish.shift()!(0); await Bun.sleep(0);
    expect(calls[1]).toEqual(['tokens', '--days', '3', '--no-official']);
    finish.shift()!(0); await Bun.sleep(0);
    expect(calls[2]).toEqual(['sessions', '--refresh', '--days', '30']);
    finish.shift()!(0); await Bun.sleep(0);
    expect(calls).toHaveLength(3);
  } finally { store.close(); }
});
