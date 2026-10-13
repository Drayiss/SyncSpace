# Verification evidence

Verified locally on October 11, 2026 against PostgreSQL 17, Redis 7.4 and two Release ASP.NET Core 10 containers.

| Check | Result |
|---|---|
| Backend CRDT tests | 5 passed |
| Frontend CRDT and recovered-journal tests | 5 passed, including 200 randomized concurrency schedules |
| Real PostgreSQL / Redis integration tests | 4 passed |
| Chromium browser tests | 4 passed |
| Redis outage / backend restart resilience test | 1 passed |
| Production React build and Docker image build | Passed |
| Azure Bicep compilation | Passed; deployed successfully to Azure (see cloud verification below) |
| npm frontend and test package audits | No known vulnerabilities |
| .NET dependency audit, including transitive packages | No known vulnerabilities |

Browser verification covers two independent users, live presence/cursors, concurrent offline/live edits, two tabs sharing browser storage, pending drafts recovered after reload, version restore, mobile overflow, reordered/duplicated events and an entirely missed final event repaired by reconciliation. Desktop and mobile screenshots are in `artifacts/`.

The resilience test stops this project's Redis container, commits an edit on one API instance, repairs another instance from PostgreSQL, restarts the second API, and replays a previously committed batch. State/history remain consistent, and cross-instance broadcasting recovers.

Distributed tracing was verified with Jaeger. [Saved trace evidence](../artifacts/trace-verification.json) records a PostgreSQL commit, Redis publication and Redis consumption under the same trace ID, across two distinct backend instance IDs. `/metrics` was checked for active connection, successful commit, error and duration histogram output.

[The benchmark](benchmark.md) records the final measured workload and limits. The raw result is retained separately so the reported concurrency and latency can be checked. These checks demonstrate the implemented paths; they do not certify Azure performance or an enterprise production deployment. GitHub Actions configuration repeats the build, unit, integration, resilience and browser checks when the repository is pushed.

## Azure deployment verification

Deployed on October 11, 2026 to [SyncSpace on Azure](https://syncspace-app.whiteriver-3fe4479b.westus3.azurecontainerapps.io), using two healthy ASP.NET Core replicas, PostgreSQL Flexible Server 17 B1ms, Azure Managed Redis Balanced B0 with HA, and a private Basic container registry. SyncSpace owns its resources in `syncspace-demo`; the app shares the existing West US 3 Container Apps environment to respect the student subscription's global one-environment quota.

- Cloud smoke verification passed: HTTPS readiness, 12 WebSocket clients, durable delivery to all 12, five confirmed deliveries through Redis to another replica, PostgreSQL revision/history persistence, idempotent retry, and reconnect catch-up. [Evidence](../artifacts/azure-smoke.json) contains no document capability key.
- All four PostgreSQL/Redis integration tests passed against the public Azure endpoint, including 30 concurrent edit batches.
- All four Chromium tests passed against the Azure endpoint: live presence/cursors, offline merging, reload recovery, history restore, mobile layout, and reordered/duplicated/missed-event reconciliation.
- Both replicas were running and ready. `/health/ready` and `/metrics` returned HTTP 200. [Structured logging evidence](../artifacts/azure-logging.json) includes edit logs with trace IDs from each replica. An OTLP collector was not provisioned in Azure; full distributed spans were verified locally as described above.
- Desktop and mobile screenshots are saved as `artifacts/azure-editor-desktop.png` and `artifacts/azure-editor-mobile.png`.
- The temporary plaintext deployment parameter file was removed; the repeat-deployment PostgreSQL credential is encrypted with Windows DPAPI in the ignored `.azure/` directory.

[Deployment metadata](../artifacts/azure-deployment.json), [cloud check results](../artifacts/azure-verification.json), and [update/cost/cleanup instructions](azure.md) are saved. The 1,000-connection / 48.44 ms p95 benchmark remains **local**, and was not rerun against Azure.
