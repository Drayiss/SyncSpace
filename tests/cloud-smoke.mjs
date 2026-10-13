import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { base, create, connect, read, insert } from './helpers.mjs';

assert.ok(base.startsWith('https://'), 'Set API_BASE to the deployed HTTPS URL.');
const health = await fetch(`${base}/health/ready`);
assert.equal(health.status, 200);
const doc = await create('Azure deployment verification');
const peers = await Promise.all(Array.from({ length: 12 }, () => connect(doc)));
try {
  const batch = {
    type: 'edit',
    batchId: randomUUID(),
    name: 'Deployment check',
    ops: insert('azure-check', '', 'SyncSpace is live on Azure.'),
  };
  peers[0].send(batch);
  const received = await Promise.all(peers.map((p) => p.wait((m) => m.batchId === batch.batchId)));
  // Only the Redis consumer path includes the publisher's instance ID. A local delivery doesn't.
  const remoteDeliveries = received.filter((m) => m.instanceId);
  assert.ok(remoteDeliveries.length > 0, 'Expected Redis delivery to a different app replica.');
  const beforeRetry = peers[0].messages.filter((m) => m.batchId === batch.batchId).length;
  peers[0].send(batch);
  await peers[0].wait(
    (m) =>
      m.batchId === batch.batchId &&
      peers[0].messages.filter((x) => x.batchId === batch.batchId).length > beforeRetry,
  );
  const state = await read(doc);
  assert.equal(state.revision, 1);
  assert.equal((await read(doc, '/history/1')).text, 'SyncSpace is live on Azure.');
  const reconnected = await connect(doc);
  try {
    assert.equal(reconnected.messages.find((m) => m.type === 'joined').snapshot.revision, 1);
  } finally {
    await reconnected.close();
  }
  const evidence = {
    verifiedAt: new Date().toISOString(),
    url: base,
    healthStatus: health.status,
    websocketClients: peers.length,
    durableDeliveries: received.length,
    redisCrossReplicaDeliveries: remoteDeliveries.length,
    documentId: doc.id,
    persistedRevision: state.revision,
    historyText: 'SyncSpace is live on Azure.',
    idempotentRetry: true,
    reconnectSnapshot: true,
  };
  await writeFile('../artifacts/azure-smoke.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await Promise.all(peers.map((p) => p.close()));
}
