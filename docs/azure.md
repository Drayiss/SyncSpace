# Azure deployment

`infra/main.bicep` creates an Azure Container Apps environment and two API replicas, PostgreSQL Flexible Server 17, Azure Managed Redis, and Log Analytics. React is served from the API image, so HTTPS and WebSockets use one origin. The template uses managed service TLS and Container Apps secrets. `registry.bicep` creates a private Basic Azure Container Registry and a managed identity with only `AcrPull` permission on that registry.

## Deploy using the private registry

Prerequisites: Azure CLI authenticated to the intended subscription, Docker Desktop using Linux containers, and permission to create resources and role assignments. This creates billable services. Inspect the selected subscription and its permitted regions before running:

```powershell
az account show
./infra/deploy.ps1 -ResourceGroup syncspace-demo -Location eastus2
```

The script builds and uploads the release image, creates the infrastructure, and writes the public URL and resource names to `artifacts/azure-deployment.json`. It generates a strong PostgreSQL password and stores it encrypted with Windows DPAPI in the ignored `.azure/` directory. Temporary plaintext deployment parameters are removed in `finally`. Keep the encrypted credential for repeat deployments under the same Windows account; do not commit or share `.azure/`. If the credential is lost, reset the database administrator password and update the Container Apps secret together.

The registry uses the resource group's region; app/data services use `-Location`. An existing resource group's region is preserved. Student subscriptions can limit Container Apps environments to one globally. In that case, pass `-ExistingEnvironmentResourceId` for an existing Consumption environment in the same region. This creates an independent app without updating the shared environment or other apps. Logs go to that environment's existing Log Analytics workspace. To retry with an already uploaded image, supply the same `-ImageTag` and `-SkipImageBuild`. For normal application updates, rerun the script with a fresh image tag and the same group/location/environment.

On this subscription, the deployment uses the existing `opsflow-standard-environment` in West US 3 because the student offer permits only one Container Apps environment globally. Once `artifacts/azure-deployment.json` exists, the script reuses its region and shared environment by default for the same resource group. All SyncSpace-owned resources are in `syncspace-demo`; the shared environment and its Log Analytics workspace remain owned by `opsflow-demo`.

## Cloud verification

```powershell
$deployment = Get-Content artifacts/azure-deployment.json -Raw | ConvertFrom-Json
$env:API_BASE = $deployment.url
$env:API_BASE_2 = $deployment.url
$env:WEB_BASE = $deployment.url
$env:SCREENSHOT_PREFIX = 'azure-editor'
Push-Location tests
node cloud-smoke.mjs
npm run integration
npm run e2e
Pop-Location
```

The smoke check requires a durable Redis event to arrive at a different replica, verifies PostgreSQL state/history and a deduplicated retry, and checks reconnect catch-up. It saves evidence without the document capability key in `artifacts/azure-smoke.json`. Tests use disposable documents; do not use the Docker outage test against the cloud. The local 1,000-connection benchmark remains a local result.

## Costs and cleanup

The subscription's spending limit was enabled at deployment time. Resources consume student credit while running. The remaining credit was not available from the account metadata and is not asserted here; check Cost Management and the student credit balance in the Azure portal.

Retail rates checked October 11, 2026 for West US 3 are saved in `artifacts/azure-retail-prices.json`:

| Resource | Configured allocation | Retail rate before grants/credits |
|---|---|---|
| Container Apps | 2 minimum replicas, each 0.5 vCPU / 1 GiB; scales up to 4 | Active: $0.000024 per vCPU-second + $0.000003 per GiB-second; idle: $0.000003 for each |
| PostgreSQL compute | B1ms | $0.017/hour, approximately $12.41 per 730 hours |
| PostgreSQL storage | 32 GB | $0.115/GB/month, approximately $3.68/month |
| Managed Redis | Balanced B0, HA enabled | $0.016/hour cache meter; budget approximately $23.36/month for two nodes |
| Private registry | Basic | $0.1666/day, approximately $5/month |
| Log Analytics | Shared environment workspace | $2.30/GB ingestion after applicable grants |

For two replicas kept running for 730 hours, estimate approximately **$68/month mostly idle** or **$123/month continuously active**, before free grants, student credits, logs, requests, excess backups and bandwidth. Four active replicas cost more. This is a planning estimate, not a bill or spending cap, and excludes your existing OpsFlow resources. Container Apps' monthly free grants are shared across the subscription. See [Microsoft's retail prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices), [Container Apps billing](https://learn.microsoft.com/en-us/azure/container-apps/billing), and [Managed Redis pricing](https://azure.microsoft.com/en-us/pricing/details/managed-redis/).

To remove SyncSpace and its ongoing resource costs after exporting any documents you want to keep:

```powershell
az group delete --name syncspace-demo
```

This deletes SyncSpace's database, revisions, cache, app, registry and image-pull identity. It preserves the shared environment, OpsFlow app, and shared log workspace. Already ingested logs remain subject to that workspace's retention policy. Removing only the app will leave database/cache/registry charges running.

## Publish the image

Use an existing public container registry (for example, a public GHCR package). Substitute your registry and version:

```powershell
docker build -t ghcr.io/YOUR-GITHUB-USERNAME/syncspace:1.0.0 .
# Authenticate using your registry's credential manager or stdin; do not commit a token.
docker push ghcr.io/YOUR-GITHUB-USERNAME/syncspace:1.0.0
```

The alternative public-image path does not require `registry.bicep`. For the private ACR path, the deployment script supplies `registryName` and `imagePullIdentityName`; no registry password or administrator account is used.

## Deploy

Choose a region that offers PostgreSQL 17 and Azure Managed Redis Balanced B0. Check the portal's regional availability and pricing for your subscription before creating resources. Deployment incurs Azure charges.

```powershell
az login
az group create --name syncspace-rg --location eastus2
Copy-Item infra/main.bicepparam.example infra/main.bicepparam
# Edit the image parameter. The password is read from an environment variable.
$secret = Read-Host 'Choose a strong PostgreSQL password' -AsSecureString
$env:SYNCSPACE_POSTGRES_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password
az deployment group create --resource-group syncspace-rg --template-file infra/main.bicep --parameters infra/main.bicepparam
Remove-Item Env:SYNCSPACE_POSTGRES_PASSWORD
```

Use the returned `url`. Verify `/health/ready`, create a document, and share its link with a second browser. Test load separately against the deployed URL; local results do not describe Azure performance. When using a load balancer, both load-test URLs can point to the same public address; verify routing across replicas using backend logs.

## Operational choices

- Minimum replicas is two. Existing sockets stay with their instance; PostgreSQL row locks order commits and Redis broadcasts to other instances. A restart reconnects clients and replays their local journals. No sticky sessions are required.
- The small PostgreSQL tier is suitable for a demo. Use a larger tier, HA and longer backup retention for production. Full revision snapshots trade storage for implementation simplicity.
- Redis uses the smallest Balanced B0 tier with HA enabled. Set `redisHighAvailability=Disabled` for a cheaper single-node demo. Durable document state remains in PostgreSQL, and clients reconcile missed Redis broadcasts.
- This minimal template exposes managed service endpoints with TLS and credentials. PostgreSQL's `AllowAzureServices` firewall rule admits Azure-hosted connections broadly. For a public production service, place Container Apps, PostgreSQL and Redis behind a VNet/private endpoints and replace that firewall rule. Do not treat the demo networking as an enterprise perimeter.
- A document invite link is an edit capability. There are no accounts, organizations, read-only roles or key rotation in this intentionally small project. Keep links private. Add identity and resource quotas before offering public signup.
- Metrics are available at `/metrics`. OTLP traces and metrics are enabled when `otlpEndpoint` is supplied. JSON console logs go to Log Analytics. Protect metrics via ingress/access rules when publishing beyond a demo.
- Container Apps upgrades can interrupt WebSockets. The client reconnects with jitter and resends unacknowledged batches. Redis Pub/Sub is ephemeral; five-second snapshot reconciliation repairs missed changes.

Reference: [Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview), [Azure Managed Redis Bicep](https://learn.microsoft.com/en-us/azure/redis/redis-cache-bicep-provision), [PostgreSQL Flexible Server](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/overview).
