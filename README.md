# SyncSpace

A real-time shared plain-text workspace built with React, TypeScript, C# / ASP.NET Core 10, WebSockets, Redis, PostgreSQL and Azure deployment templates.

Live demo: **[SyncSpace on Azure](https://syncspace-app.whiteriver-3fe4479b.westus3.azurecontainerapps.io)**. Two app replicas synchronize through managed Redis and persist documents/revisions in Azure PostgreSQL. [Deployment and operating instructions](docs/azure.md) include updates, costs and cleanup.

Create a document, share its private invite link, and write together. The editor includes live presence and cursors, optimistic edits, automatic saves, offline draft recovery, version preview/restore, document search, renaming and text export. Everything runs as one application container plus PostgreSQL and Redis.

## Run with Docker

Prerequisite: Docker Desktop with Linux containers.

```powershell
docker compose up --build -d
```

Open **http://localhost:5080**. Create a document, click **Share**, then open the link in another browser. Change your display names in the sidebar to identify collaborators. Your list of documents is kept in your browser; invite links grant access to their document.

```powershell
# Start a second API instance against the same PostgreSQL and Redis.
docker compose --profile scale up --build -d
# Pause services while preserving documents.
docker compose stop
```

The second instance is at http://localhost:5081. To verify cross-instance editing, use the same document ID and key on both ports. Each origin has its own browser storage. `.env.example` documents optional local settings; default credentials are for local development only. PostgreSQL's named volume retains all documents/revisions across container restarts.

## Develop locally

Prerequisites: .NET 10 SDK, Node 24+, Docker.

```powershell
docker compose up -d postgres redis
dotnet run --project backend/SyncSpace.Api --urls http://127.0.0.1:5080
```

In a second terminal:

```powershell
npm ci --prefix frontend
npm run dev --prefix frontend
```

Open http://127.0.0.1:5173. Vite proxies API and WebSocket traffic to port 5080. `ConnectionStrings__Postgres`, `ConnectionStrings__Redis`, `AllowedOrigins` (comma-separated), `DatabasePoolSize` (default 10 per instance), and `OTEL_EXPORTER_OTLP_ENDPOINT` override backend settings. Budget the total pool size across replicas below PostgreSQL's connection limit. Production serves the built React app from ASP.NET Core on one origin.

## Verify

```powershell
dotnet test backend/SyncSpace.Tests
npm ci --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
docker compose --profile scale up --build -d
npm ci --prefix tests
npm run integration --prefix tests
# Optional: stops/restarts this project's Redis and second API container.
npm run resilience --prefix tests
```

For browser tests against the production containers:

```powershell
Push-Location tests
npx playwright install chromium
$env:WEB_BASE = 'http://127.0.0.1:5080'
npm run e2e
Pop-Location
```

The browser tests cover simultaneous edits, presence/cursors, offline merging, local draft recovery after reload, multiple tabs, version restore, and mobile layout. Integration tests use two real API instances and verify Redis fan-out, PostgreSQL atomicity, batch deduplication, authorization, reconnection and concurrent writes.

## Load test

```powershell
docker compose --profile scale up -d
Push-Location tests
npm ci
$env:CONNECTIONS = '1000'
$env:DURATION = '30'
npm run load
Pop-Location
```

The script keeps 1,000 sockets open across two API instances and ten documents, sends 50 edit batches per second, and includes periodic sync/presence traffic. It measures writer-to-other-client delivery latency, excludes duplicate broadcasts and acknowledgements, checks document durability, and writes `artifacts/load-results.json`. It exits unsuccessfully for dropped connections, inconsistent persistence, or fewer than 99% of expected deliveries. Configuration includes `API_BASE`, `API_BASE_2`, `ROOMS`, `WARMUP` and `EDIT_INTERVAL`.

See [the benchmark report](docs/benchmark.md) for measured results and the exact test environment. These are local measurements, not an Azure SLA or a maximum-capacity claim.

[Verification evidence](docs/verification.md) records the 19 passing tests, browser screenshots, dependency audits and distributed trace checks.

## How synchronization works

1. A textarea edit becomes character insertions/deletions. Each character has a Lamport ID and a stable insertion anchor. Deletions retain tombstones. Concurrent insertions sort deterministically, and both writers' contributions survive.
2. The client updates immediately and stores its pending batches in IndexedDB before sending. Only one local batch is in flight, preserving insertion dependencies. Each browser session generates a fresh client ID; journals from other tabs cannot be overwritten.
3. The API validates operations and locks the PostgreSQL document row. State and a full revision snapshot commit in one transaction. A unique batch ID provides idempotent retries after lost acknowledgements.
4. After commit, the server acknowledges the writer and publishes the event to Redis. Every API instance fans it out to its connected document peers. No session affinity is needed.
5. Clients buffer revisions and apply them in sequence, ignoring duplicates. Gaps trigger a snapshot request. Five-second reconciliation also covers an entirely missed last event, Redis outages, or a process crash after database commit and before broadcast.
6. Reconnects use exponential backoff with jitter. A durable snapshot is merged with the local journal, then pending batches are replayed. Presence/cursor heartbeats expire after 20 seconds, including ungraceful disconnects.
7. Restoring an old version emits a new CRDT edit, keeping the history and allowing concurrent work to merge.

## Observability and Azure

- `/health/live` checks the process; `/health/ready` checks PostgreSQL and Redis.
- `/metrics` exposes Prometheus-compatible connection, commit, error and latency metrics.
- JSON logs identify documents, batches and connections. Keys and document text are not logged.
- OpenTelemetry instruments HTTP, database operations, document commits, Redis publishers/consumers and service metrics. Redis events carry trace context across instances. Supply an OTLP collector endpoint to export traces and metrics.
- Optional local tracing: `docker compose -f compose.yaml -f compose.observability.yaml --profile scale --profile observability up -d`. Jaeger is at http://localhost:16686. This profile sends traces to Jaeger; metrics remain at `/metrics` because Jaeger is a trace backend. A general OTLP collector receives both traces and metrics by default; `Telemetry__ExportMetrics=false` disables only OTLP metric export.
- [Azure deployment instructions](docs/azure.md) include the compiled Bicep template and operational choices.

## Deliberate limits

This is a small, reviewable collaboration project: plain text, capability links instead of accounts, 50,000 total inserted UTF-16 units per document (including tombstones), and at most 10,000 operations per individual edit. Large pastes are rejected with a visible message. Full revision snapshots and five-second full-state reconciliation favor simplicity over large-document efficiency. The CRDT is append-only; compaction requires coordination with offline clients and is intentionally omitted. Browser storage is best-effort under quota/eviction; export text if local persistence reports an error. Use HTTPS outside localhost.

For production-scale public use, add account authorization, document quotas/retention, private managed-service networking, incremental snapshots/compaction and longer distributed load tests. The core editing, horizontal synchronization, recovery and history paths are implemented and tested against real dependencies.
