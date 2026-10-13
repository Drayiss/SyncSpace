targetScope = 'resourceGroup'

@description('Container image containing both the API and React frontend.')
param image string
@description('Optional private ACR name created by registry.bicep. Leave empty for a public image.')
param registryName string = ''
@description('User-assigned image pull identity created by registry.bicep.')
param imagePullIdentityName string = '${prefix}-image-pull'
@description('Optional existing Container Apps environment ID for subscriptions with a one-environment quota.')
param existingEnvironmentResourceId string = ''
param location string = resourceGroup().location
@minLength(3)
@maxLength(18)
param prefix string = 'syncspace'
param postgresUser string = 'syncspaceadmin'
@secure()
@minLength(16)
param postgresPassword string
@description('Optional OTLP collector URL. Leave empty when no collector is available.')
param otlpEndpoint string = ''
@minValue(2)
param minReplicas int = 2
@minValue(2)
param maxReplicas int = 4
@description('Disable Redis HA to reduce demo costs. PostgreSQL reconciliation repairs missed broadcasts.')
@allowed(['Enabled', 'Disabled'])
param redisHighAvailability string = 'Enabled'

var suffix = uniqueString(resourceGroup().id)
var appName = '${prefix}-app'
var tags = { project: 'SyncSpace' }
var environmentId = empty(existingEnvironmentResourceId) ? environment!.id : sharedEnvironment!.id
var environmentDomain = empty(existingEnvironmentResourceId) ? environment!.properties.defaultDomain : sharedEnvironment!.properties.defaultDomain

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = if (!empty(registryName)) {
  name: registryName
}
resource imagePullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (!empty(registryName)) {
  name: imagePullIdentityName
}

resource sharedEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' existing = if (!empty(existingEnvironmentResourceId)) {
  name: last(split(existingEnvironmentResourceId, '/'))
  scope: resourceGroup(split(existingEnvironmentResourceId, '/')[2], split(existingEnvironmentResourceId, '/')[4])
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (empty(existingEnvironmentResourceId)) {
  name: '${prefix}-logs-${suffix}'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}
resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = if (empty(existingEnvironmentResourceId)) {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs!.properties.customerId
        sharedKey: logs!.listKeys().primarySharedKey
      }
    }
  }
}
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    administratorLogin: postgresUser
    administratorLoginPassword: postgresPassword
    version: '17'
    storage: { storageSizeGB: 32 }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'syncspace'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
resource firewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}
resource redis 'Microsoft.Cache/redisEnterprise@2025-07-01' = {
  name: '${prefix}-redis-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Balanced_B0' }
  properties: { minimumTlsVersion: '1.2', highAvailability: redisHighAvailability, publicNetworkAccess: 'Enabled' }
}
resource redisDatabase 'Microsoft.Cache/redisEnterprise/databases@2025-07-01' = {
  parent: redis
  name: 'default'
  properties: {
    clientProtocol: 'Encrypted'
    clusteringPolicy: 'EnterpriseCluster'
    evictionPolicy: 'NoEviction'
    port: 10000
    accessKeysAuthentication: 'Enabled'
  }
}
resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: tags
  identity: !empty(registryName) ? {
    type: 'UserAssigned'
    userAssignedIdentities: { '${imagePullIdentity!.id}': {} }
  } : { type: 'None' }
  properties: {
    managedEnvironmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: !empty(registryName) ? [{ server: registry!.properties.loginServer, identity: imagePullIdentity!.id }] : []
      ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false }
      secrets: [
        { name: 'postgres', value: 'Host=${postgres.properties.fullyQualifiedDomainName};Database=syncspace;Username=${postgresUser};Password="${replace(postgresPassword, '"', '""')}";SSL Mode=VerifyFull' }
        { name: 'redis', value: '${redis.properties.hostName}:10000,password=${redisDatabase.listKeys().primaryKey},ssl=true,abortConnect=false' }
      ]
    }
    template: {
      containers: [{
        name: 'syncspace'
        image: image
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: [
          { name: 'ConnectionStrings__Postgres', secretRef: 'postgres' }
          { name: 'ConnectionStrings__Redis', secretRef: 'redis' }
          { name: 'AllowedOrigins', value: 'https://${appName}.${environmentDomain}' }
          { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: otlpEndpoint }
        ]
        probes: [
          { type: 'Startup', httpGet: { path: '/health/live', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 5, failureThreshold: 60 }
          { type: 'Liveness', httpGet: { path: '/health/live', port: 8080 }, periodSeconds: 20 }
          { type: 'Readiness', httpGet: { path: '/health/ready', port: 8080 }, periodSeconds: 10 }
        ]
      }]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '100' } } }]
      }
    }
  }
  dependsOn: [database, firewall]
}
output url string = 'https://${app.properties.configuration.ingress!.fqdn}'
output appName string = app.name
output postgresHost string = postgres.properties.fullyQualifiedDomainName
