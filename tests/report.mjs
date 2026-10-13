import { cpus } from 'node:os';
import { writeFile } from 'node:fs/promises';

export async function writeBenchmark(report) {
  const { configuration: c, results: r } = report;
  const passed = r.errors === 0 && r.persistenceConsistent && r.minimumConnectionsDuringMeasurement === c.connections && r.deliveryRatio >= .99;
  const date = new Date(report.finishedAt).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
  const fence = String.fromCharCode(96).repeat(3);
  const text = `# Measured synchronization benchmark

Completed **${date}**. Result: **${passed ? 'PASS' : 'FAIL'}**.

| Measurement | Result |
|---|---:|
| Concurrent WebSocket connections maintained | ${r.minimumConnectionsDuringMeasurement.toLocaleString('en-US')} |
| API instances | ${report.environment.apiInstances} |
| Document rooms | ${c.rooms} |
| Measurement / warmup | ${c.durationSeconds}s / ${c.warmupSeconds}s |
| Target edit batches per second | ${1000 / c.editIntervalMs * c.rooms} |
| Committed edit batches during measurement | ${r.committedBatches.toLocaleString('en-US')} |
| Observed / expected peer deliveries | ${r.observedPeerDeliveries.toLocaleString('en-US')} / ${r.expectedPeerDeliveries.toLocaleString('en-US')} |
| Delivery ratio | ${(r.deliveryRatio * 100).toFixed(2)}% |
| p50 synchronization latency | ${r.p50Ms} ms |
| **p95 synchronization latency** | **${r.p95Ms} ms** |
| p99 synchronization latency | ${r.p99Ms} ms |
| Cross-instance p95 | ${r.crossInstanceP95Ms} ms |
| Cross-instance samples | ${r.crossInstanceSamples.toLocaleString('en-US')} |
| Errors / unexpected disconnects | ${r.errors} |
| Persisted revisions match every submitted batch | ${r.persistenceConsistent ? 'Yes' : 'No'} |

## Definition and environment

${report.definition} This includes validation, PostgreSQL commit, Redis fan-out where applicable, and peer transport delivery. It excludes the editor's 100 ms send debounce and browser rendering. These are real network connections using synthetic clients, not ${c.connections.toLocaleString('en-US')} full browser instances.

${report.environment.deployment}. CPU: ${cpus()[0]?.model ?? 'unknown'}; ${cpus().length} logical processors. The verified local Docker Desktop environment was allocated 16 CPUs and approximately 15.6 GiB RAM. Both ASP.NET Core 10 services run in Release Linux containers. PostgreSQL 17 and Redis 7.4 share Docker's local network. Each API pool is limited to 10 database connections. OpenTelemetry instrumentation and JSON logging are enabled; OTLP export is disabled for this benchmark. Load generator: Node ${report.environment.node} on ${report.environment.platform}.

Each document has approximately ${Math.ceil(c.connections / c.rooms)} clients and one synthetic writer. Edits insert one UTF-16 unit per batch; documents grow throughout the run. Clients request full snapshots every ${c.syncIntervalMs / 1000}s and publish presence every ${c.presenceIntervalMs / 1000}s, including simultaneous heartbeat bursts. This test does not represent large documents, every user typing simultaneously, geographically distributed users, or Azure performance. It establishes the measured load above, not maximum system capacity or a production SLA.

## Reproduce

${fence}powershell
docker compose --profile scale up --build -d
cd tests
npm ci
npm run load
${fence}

Set CONNECTIONS, ROOMS, DURATION, WARMUP, EDIT_INTERVAL, API_BASE and API_BASE_2 to change the workload. Run from the tests directory. The script writes [raw results](../artifacts/load-results.json) and updates this report. It fails when a connection drops, persistence does not match, or fewer than 99% of expected deliveries arrive. Rerun on your deployment before making deployment-specific claims.

${passed ? `Resume metric for this measured workload: **Load-tested ${c.connections.toLocaleString('en-US')} concurrent WebSocket connections across two ASP.NET Core instances, achieving ${r.p95Ms} ms p95 synchronization latency in a local benchmark.**` : 'This run failed its acceptance criteria; do not use its latency as a successful capacity claim.'}
`;
  await writeFile('../docs/benchmark.md', text);
}
