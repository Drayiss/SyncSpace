import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { base, second, create, read, connect, insert } from './helpers.mjs';

test('real PostgreSQL + Redis: two instances converge and retries are exactly once', async () => {
  const doc = await create();
  const a = await connect(doc);
  const b = await connect(doc, second);
  try {
    const left = {
      type: 'edit',
      batchId: randomUUID(),
      name: 'Alice',
      ops: insert('alice', '', 'Hello'),
    };
    const right = {
      type: 'edit',
      batchId: randomUUID(),
      name: 'Bob',
      ops: insert('bob', '', 'World'),
    };
    a.send(left);
    b.send(right);
    await Promise.all([
      a.wait((m) => m.batchId === right.batchId),
      b.wait((m) => m.batchId === left.batchId),
    ]);
    const state = await read(doc);
    assert.equal(state.revision, 2);
    assert.equal(state.nodes.length, 10);
    a.send(left);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await read(doc)).revision, 2);
    const history = await read(doc, '/history');
    assert.equal(history.length, 2);
    const version = await read(doc, '/history/2');
    assert.equal(version.text, 'WorldHello');
    const forbidden = await fetch(`${base}/api/documents/${doc.id}`);
    assert.equal(forbidden.status, 401);
    await assert.rejects(connect(doc, second, '0'.repeat(64)), /refused/);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
test('presence, leave and durable reconnect catch-up work across replicas', async () => {
  const doc = await create();
  const a = await connect(doc);
  let b = await connect(doc, second);
  try {
    a.send({ type: 'presence', name: 'Alice', anchor: '', head: '' });
    const presence = await b.wait((m) => m.type === 'presence' && m.name === 'Alice');
    assert.ok(presence.connectionId);
    await b.close();
    await a.wait((m) => m.type === 'leave');
    a.send({
      type: 'edit',
      batchId: randomUUID(),
      name: 'Alice',
      ops: insert('a', '', 'Offline catch-up'),
    });
    await a.wait((m) => m.type === 'edit');
    b = await connect(doc, second);
    const joined = b.messages.find((m) => m.type === 'joined');
    assert.equal(joined.snapshot.revision, 1);
    assert.equal((await read(doc, '/history/1')).text, 'Offline catch-up');
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
test('malformed edits are rejected atomically and unknown history returns 404', async () => {
  const doc = await create();
  const a = await connect(doc);
  try {
    a.send({
      type: 'edit',
      batchId: randomUUID(),
      name: 'Alice',
      ops: [
        ...insert('a', '', 'X'),
        { kind: 'insert', id: '000000000002:a', after: 'missing', value: 89 },
      ],
    });
    assert.equal((await a.wait((m) => m.type === 'error')).permanent, true);
    assert.equal((await read(doc)).revision, 0);
    assert.equal((await read(doc)).nodes.length, 0);
    const response = await fetch(`${base}/api/documents/${doc.id}/history/999`, {
      headers: { Authorization: `Bearer ${doc.key}` },
    });
    assert.equal(response.status, 404);
  } finally {
    await a.close();
  }
});
test('cross-instance concurrent row-lock writes retain all 30 batches', async () => {
  const doc = await create();
  const peers = await Promise.all(
    Array.from({ length: 10 }, (_, i) => connect(doc, i % 2 ? second : base)),
  );
  try {
    const batches = peers.flatMap((peer, i) =>
      Array.from({ length: 3 }, (_, j) => ({
        peer,
        batch: {
          type: 'edit',
          batchId: randomUUID(),
          name: `Writer ${i}`,
          ops: insert(`w${i}b${j}`, '', String(i)),
        },
      })),
    );
    for (const { peer, batch } of batches) peer.send(batch);
    await Promise.all(
      batches.map(({ peer, batch }) => peer.wait((m) => m.batchId === batch.batchId)),
    );
    const state = await read(doc);
    assert.equal(state.revision, 30);
    assert.equal(state.nodes.length, 30);
  } finally {
    await Promise.all(peers.map((p) => p.close()));
  }
});
