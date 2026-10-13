# Measured synchronization benchmark

Completed **10/11/2026, 1:07:45 PM EDT**. Result: **PASS**.

| Measurement | Result |
|---|---:|
| Concurrent WebSocket connections maintained | 1,000 |
| API instances | 2 |
| Document rooms | 10 |
| Measurement / warmup | 30s / 5s |
| Target edit batches per second | 50 |
| Committed edit batches during measurement | 1,480 |
| Observed / expected peer deliveries | 146,520 / 146,520 |
| Delivery ratio | 100.00% |
| p50 synchronization latency | 14.99 ms |
| **p95 synchronization latency** | **48.44 ms** |
| p99 synchronization latency | 219.98 ms |
| Cross-instance p95 | 50.24 ms |
| Cross-instance samples | 74,000 |
| Errors / unexpected disconnects | 0 |
| Persisted revisions match every submitted batch | Yes |

## Definition and environment

Time from a writer sending an edit until another client receives the committed edit event. Excludes sender acknowledgements, duplicate broadcasts and warmup; uses one monotonic clock in the load generator. This includes validation, PostgreSQL commit, Redis fan-out where applicable, and peer transport delivery. It excludes the editor's 100 ms send debounce and browser rendering. These are real network connections using synthetic clients, not 1,000 full browser instances.

Docker production containers; same-machine Windows load generator. CPU: AMD Ryzen 7 5800X3D 8-Core Processor           ; 16 logical processors. The verified local Docker Desktop environment was allocated 16 CPUs and approximately 15.6 GiB RAM. Both ASP.NET Core 10 services run in Release Linux containers. PostgreSQL 17 and Redis 7.4 share Docker's local network. Each API pool is limited to 10 database connections. OpenTelemetry instrumentation and JSON logging are enabled; OTLP export is disabled for this benchmark. Load generator: Node v24.18.0 on win32.

Each document has approximately 100 clients and one synthetic writer. Edits insert one UTF-16 unit per batch; documents grow throughout the run. Clients request full snapshots every 5s and publish presence every 10s, including simultaneous heartbeat bursts. This test does not represent large documents, every user typing simultaneously, geographically distributed users, or Azure performance. It establishes the measured load above, not maximum system capacity or a production SLA.

## Reproduce

```powershell
docker compose --profile scale up --build -d
cd tests
npm ci
npm run load
```

Set CONNECTIONS, ROOMS, DURATION, WARMUP, EDIT_INTERVAL, API_BASE and API_BASE_2 to change the workload. Run from the tests directory. The script writes [raw results](../artifacts/load-results.json) and updates this report. It fails when a connection drops, persistence does not match, or fewer than 99% of expected deliveries arrive. Rerun on your deployment before making deployment-specific claims.

Resume metric for this measured workload: **Load-tested 1,000 concurrent WebSocket connections across two ASP.NET Core instances, achieving 48.44 ms p95 synchronization latency in a local benchmark.**
