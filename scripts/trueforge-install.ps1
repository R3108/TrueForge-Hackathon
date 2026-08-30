. (Join-Path $PSScriptRoot "trueforge-common.ps1")

Assert-TrueForgeRuntime
Install-TrueForgeDependencies
Ensure-TrueForgeEnvironment

Write-Host "Vendored TrueForge dependencies are installed with pnpm $Script:RequiredPnpm."
Write-Host "Environment file: trueforge\packages\trueforge\.env"
