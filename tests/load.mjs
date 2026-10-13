import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { base, second, create, read } from './helpers.mjs';
import { writeBenchmark } from './report.mjs';

const connections = Number(process.env.CONNECTIONS ?? 1000);
const rooms = Number(process.env.ROOMS ?? 10);
const durationSeconds = Number(process.env.DURATION ?? 30);
const warmupSeconds = Number(process.env.WARMUP ?? 5);
const editIntervalMs = Number(process.env.EDIT_INTERVAL ?? 200);
if (
  ![connections, rooms, durationSeconds, warmupSeconds, editIntervalMs].every(Number.isFinite) ||
  connections < rooms * 2 ||
  rooms > 15 ||
  durationSeconds < 1 ||
  editIntervalMs < 50
)
  throw new Error('Invalid load-test settings (2+ clients per room, at most 15 rooms).');
const documents = [];
const sockets = [];
const samples = [];
const crossInstanceSamples = [];
const sent = new Map();
let failures = 0;
let active = 0;
let maxActive = 0;
let peakDuringMeasurement = 0;
let minimumDuringMeasurement = Infinity;
let measuring = false;
let stopping = false;
let expectedDeliveries = 0;
let commits = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = new Date().toISOString();
try {
  for (let i = 0; i < rooms; i++) documents.push(await create(`Load test ${i + 1}`));
  for (let i = 0; i < connections; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, connections - i) }, (_, j) => {
        const index = i + j,
          room = index % rooms,
          replica = Math.floor(index / rooms) % 2;
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(
            `${(replica ? second : base).replace(/^http/, 'ws')}/ws/documents/${documents[room].id}`,
          );
          const peer = { ws, room, replica, seen: new Set(), joined: false };
          sockets.push(peer);
          const timeout = setTimeout(() => {
            ws.terminate();
            reject(new Error(`Connection ${index} timed out`));
          }, 15_000);
          ws.on('open', () => ws.send(JSON.stringify({ type: 'join', key: documents[room].key })));
          ws.on('message', (raw) => {
            const event = JSON.parse(raw.toString());
            if (event.type === 'joined' && !peer.joined) {
              peer.joined = true;
              active++;
              maxActive = Math.max(maxActive, active);
              clearTimeout(timeout);
              resolve();
            }
            if (event.type === 'error') failures++;
            if (event.type === 'edit' && !peer.seen.has(event.batchId)) {
              peer.seen.add(event.batchId);
              const source = sent.get(event.batchId);
              if (source?.measure && peer !== source.writer) {
                const latency = performance.now() - source.at;
                samples.push(latency);
                if (peer.replica !== source.writer.replica) crossInstanceSamples.push(latency);
              }
            }
          });
          ws.on('error', (error) => {
            failures++;
            reject(error);
          });
          ws.on('close', () => {
            if (peer.joined) active--;
            if (!stopping) failures++;
          });
        });
      }),
    );
  }
  console.log(`Connected ${active} WebSockets across two API instances and ${rooms} documents.`);
  const writers = documents.map((_, room) => sockets.find((p) => p.room === room));
  const clocks = Array(rooms).fill(0);
  const editTimer = setInterval(() => {
    for (let room = 0; room < rooms; room++) {
      const writer = writers[room];
      if (writer.ws.readyState !== WebSocket.OPEN) continue;
      const batchId = randomUUID(),
        id = `${String(++clocks[room]).padStart(12, '0')}:load${room}`;
      sent.set(batchId, { at: performance.now(), writer, measure: measuring });
      if (measuring) {
        commits++;
        expectedDeliveries += sockets.filter((p) => p.room === room && p !== writer).length;
      }
      writer.ws.send(
        JSON.stringify({
          type: 'edit',
          batchId,
          name: 'Load writer',
          ops: [{ kind: 'insert', id, after: '', value: 65 + (clocks[room] % 26) }],
        }),
      );
    }
  }, editIntervalMs);
  const syncTimer = setInterval(() => {
    for (const p of sockets)
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ type: 'sync' }));
  }, 5000);
  const presenceTimer = setInterval(() => {
    for (const [i, p] of sockets.entries())
      if (p.ws.readyState === WebSocket.OPEN)
        p.ws.send(JSON.stringify({ type: 'presence', name: `User ${i}`, anchor: '', head: '' }));
  }, 10_000);
  const countTimer = setInterval(() => {
    if (measuring) {
      minimumDuringMeasurement = Math.min(minimumDuringMeasurement, active);
      peakDuringMeasurement = Math.max(peakDuringMeasurement, active);
    }
  }, 100);
  await sleep(warmupSeconds * 1000);
  measuring = true;
  console.log(
    `Measuring ${durationSeconds}s, ${Math.round(1000 / editIntervalMs) * rooms} edit batches/s, periodic sync and presence enabled.`,
  );
  await sleep(durationSeconds * 1000);
  measuring = false;
  [editTimer, syncTimer, presenceTimer, countTimer].forEach(clearInterval);
  await sleep(3000);
  const sorted = samples.sort((a, b) => a - b),
    cross = crossInstanceSamples.sort((a, b) => a - b);
  const percentile = (list, p) =>
    list.length
      ? Number(list[Math.min(list.length - 1, Math.ceil(list.length * p) - 1)].toFixed(2))
      : null;
  const states = await Promise.all(documents.map((d) => read(d)));
  const persistenceConsistent = states.every((s, i) => s.revision === clocks[i]);
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      node: process.version,
      apiInstances: 2,
      transport: 'WebSocket',
      persistence: 'PostgreSQL',
      broadcast: 'Redis Pub/Sub',
      deployment:
        process.env.LOAD_ENVIRONMENT ??
        'Docker production containers; same-machine Windows load generator',
    },
    configuration: {
      connections,
      rooms,
      durationSeconds,
      warmupSeconds,
      editIntervalMs,
      syncIntervalMs: 5000,
      presenceIntervalMs: 10000,
    },
    results: {
      peakConcurrentConnections: maxActive,
      minimumConnectionsDuringMeasurement: minimumDuringMeasurement,
      peakConnectionsDuringMeasurement: peakDuringMeasurement,
      committedBatches: commits,
      expectedPeerDeliveries: expectedDeliveries,
      observedPeerDeliveries: samples.length,
      deliveryRatio: samples.length / expectedDeliveries,
      errors: failures,
      persistenceConsistent,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      crossInstanceSamples: cross.length,
      crossInstanceP95Ms: percentile(cross, 0.95),
    },
    definition:
      'Time from a writer sending an edit until another client receives the committed edit event. Excludes sender acknowledgements, duplicate broadcasts and warmup; uses one monotonic clock in the load generator.',
  };
  await mkdir('../artifacts', { recursive: true });
  await writeFile('../artifacts/load-results.json', JSON.stringify(report, null, 2) + '\n');
  await writeBenchmark(report);
  console.log(JSON.stringify(report, null, 2));
  if (
    failures ||
    !persistenceConsistent ||
    minimumDuringMeasurement !== connections ||
    samples.length < expectedDeliveries * 0.99
  )
    process.exitCode = 1;
} finally {
  stopping = true;
  await Promise.all(
    sockets.map(
      (p) =>
        new Promise((resolve) => {
          if (p.ws.readyState === WebSocket.CLOSED) return resolve();
          p.ws.once('close', resolve);
          p.ws.close();
          setTimeout(() => {
            p.ws.terminate();
            resolve();
          }, 2000).unref();
        }),
    ),
  );
}
