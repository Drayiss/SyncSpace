[CmdletBinding()]
param(
    [string]$ResourceGroup = 'syncspace-demo',
    [string]$Location = 'westus3',
    [string]$Prefix = 'syncspace',
    [string]$ImageTag = (Get-Date -Format 'yyyyMMdd-HHmmss'),
    [string]$ExistingEnvironmentResourceId = '',
    [switch]$SkipImageBuild
)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path $PSScriptRoot -Parent
Set-Location $projectDirectory
$previousRecordPath = Join-Path $projectDirectory 'artifacts/azure-deployment.json'
if (Test-Path -LiteralPath $previousRecordPath) {
    $previous = Get-Content -LiteralPath $previousRecordPath -Raw | ConvertFrom-Json
    if ($previous.resourceGroup -eq $ResourceGroup) {
        if (!$PSBoundParameters.ContainsKey('Location')) { $Location = $previous.region }
        if (!$PSBoundParameters.ContainsKey('ExistingEnvironmentResourceId')) {
            $ExistingEnvironmentResourceId = $previous.existingEnvironmentResourceId
        }
    }
}

function Assert-NativeSuccess([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit $LASTEXITCODE)." }
}

$account = az account show --output json | ConvertFrom-Json
Assert-NativeSuccess 'Azure authentication'
Write-Host "Deploying to $($account.name), resource group $ResourceGroup, region $Location."
$groupExists = az group exists --name $ResourceGroup --output tsv
Assert-NativeSuccess 'Resource group lookup'
if ($groupExists -ne 'true') {
    az group create --name $ResourceGroup --location $Location --tags project=SyncSpace --output none
    Assert-NativeSuccess 'Resource group creation'
}

$bootstrap = az deployment group create --name syncspace-registry --resource-group $ResourceGroup --template-file infra/registry.bicep --parameters "prefix=$Prefix" --query properties.outputs --output json | ConvertFrom-Json
Assert-NativeSuccess 'Private registry deployment'
$registryName = $bootstrap.registryName.value
$image = "$($bootstrap.loginServer.value)/syncspace:$ImageTag"

if (!$SkipImageBuild) {
    az acr login --name $registryName --output none
    Assert-NativeSuccess 'Registry authentication'
    docker build --tag $image .
    Assert-NativeSuccess 'Release image build'
    docker push $image
    Assert-NativeSuccess 'Release image upload'
}

$privateDirectory = Join-Path $projectDirectory '.azure'
New-Item -ItemType Directory -Path $privateDirectory -Force | Out-Null
$credentialPath = Join-Path $privateDirectory "$ResourceGroup-postgres.xml"
if (Test-Path -LiteralPath $credentialPath) {
    $password = Import-Clixml -LiteralPath $credentialPath
} else {
    $bytes = New-Object byte[] 32
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $password = ConvertTo-SecureString ('Ss1!' + [Convert]::ToBase64String($bytes)) -AsPlainText -Force
    # Windows DPAPI encrypts this credential for the current Windows account.
    $password | Export-Clixml -LiteralPath $credentialPath
}
$parameterPath = Join-Path $privateDirectory 'deployment.parameters.json'
try {
    $parameters = @{
        '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters = @{
            prefix = @{ value = $Prefix }
            location = @{ value = $Location }
            existingEnvironmentResourceId = @{ value = $ExistingEnvironmentResourceId }
            image = @{ value = $image }
            registryName = @{ value = $registryName }
            imagePullIdentityName = @{ value = $bootstrap.identityName.value }
            postgresPassword = @{ value = [System.Net.NetworkCredential]::new('', $password).Password }
        }
    }
    $parameters | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $parameterPath -Encoding UTF8
    $outputs = az deployment group create --name syncspace-platform --resource-group $ResourceGroup --template-file infra/main.bicep --parameters "@$parameterPath" --query properties.outputs --output json | ConvertFrom-Json
    Assert-NativeSuccess 'Application deployment'
    $record = @{
        deployedAt = [DateTime]::UtcNow.ToString('o')
        subscriptionId = $account.id
        resourceGroup = $ResourceGroup
        region = $Location
        existingEnvironmentResourceId = $ExistingEnvironmentResourceId
        image = $image
        url = $outputs.url.value
        appName = $outputs.appName.value
        postgresHost = $outputs.postgresHost.value
        registryName = $registryName
    }
    $record | ConvertTo-Json | Set-Content artifacts/azure-deployment.json -Encoding UTF8
    Write-Host "Deployment complete: $($outputs.url.value)"
} finally {
    if (Test-Path -LiteralPath $parameterPath) { Remove-Item -LiteralPath $parameterPath }
    $parameters = $null
}
