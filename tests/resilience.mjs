import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { create, connect, read, base, second, insert } from './helpers.mjs';
const docker = (...args) =>
  execFileSync('docker', ['compose', '--profile', 'scale', ...args], {
    cwd: new URL('..', import.meta.url),
    stdio: 'pipe',
  });
async function ready(host) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${host}/health/ready`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Service did not recover');
}
test(
  'Redis outage repairs missed events from PostgreSQL; process restart and lost-ack retry preserve history',
  { timeout: 90_000 },
  async () => {
    const doc = await create('Resilience verification');
    const a = await connect(doc);
    let b = await connect(doc, second);
    const batch = {
      type: 'edit',
      batchId: randomUUID(),
      name: 'Alice',
      ops: insert('outage', '', 'Durable during outage'),
    };
    try {
      docker('stop', 'redis');
      a.send(batch);
      await a.wait((m) => m.batchId === batch.batchId);
      b.send({ type: 'sync' });
      const repaired = await b.wait((m) => m.type === 'snapshot' && m.snapshot.revision === 1);
      assert.equal(repaired.snapshot.nodes.length, batch.ops.length);
      assert.equal(
        b.messages.some((m) => m.batchId === batch.batchId),
        false,
      );
      docker('start', 'redis');
      await ready(base);
      await ready(second);
      docker('restart', 'api2');
      await b.close();
      await ready(second);
      b = await connect(doc, second);
      assert.equal(b.messages.find((m) => m.type === 'joined').snapshot.revision, 1);
      b.send(batch);
      await b.wait((m) => m.batchId === batch.batchId);
      assert.equal((await read(doc)).revision, 1);
      assert.equal((await read(doc, '/history')).length, 1);
      assert.equal((await read(doc, '/history/1')).text, 'Durable during outage');
      const recovered = {
        type: 'edit',
        batchId: randomUUID(),
        name: 'Bob',
        ops: insert('recovered', '', 'OK'),
      };
      b.send(recovered);
      await a.wait((m) => m.batchId === recovered.batchId);
      assert.equal((await read(doc)).revision, 2);
    } finally {
      docker('start', 'redis', 'api2');
      await Promise.all([a.close(), b.close()]);
    }
  },
);
