Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$Script:TrueForgeRoot = Join-Path $Script:ProjectRoot "trueforge"
$Script:ServerRoot = Join-Path $Script:TrueForgeRoot "packages\trueforge"
$Script:UiRoot = Join-Path $Script:TrueForgeRoot "packages\trueforge-ui"
$Script:SdkRoot = Join-Path $Script:TrueForgeRoot "packages\trueforge-sdk"
$Script:FrontendRoot = Join-Path $Script:TrueForgeRoot "packages\frontend"
$Script:RequiredNode = [version]"22.14.0"
$Script:RequiredPnpm = "11.16.0"

function Assert-TrueForgeRuntime {
  if (-not (Test-Path -LiteralPath (Join-Path $Script:TrueForgeRoot "pnpm-lock.yaml"))) {
    throw "Vendored TrueForge workspace is missing at $Script:TrueForgeRoot"
  }

  $nodeCommand = Get-Command node -ErrorAction Stop
  $nodeText = (& $nodeCommand.Source --version).Trim().TrimStart("v")
  $nodeVersion = [version]$nodeText
  if ($nodeVersion -lt $Script:RequiredNode) {
    throw "Node.js $Script:RequiredNode or newer is required; found $nodeText."
  }

  $Script:CorepackCommand = (Get-Command corepack -ErrorAction Stop).Source
  & $Script:CorepackCommand prepare "pnpm@$Script:RequiredPnpm" --activate
  if ($LASTEXITCODE -ne 0) {
    throw "Corepack could not activate pnpm $Script:RequiredPnpm."
  }

  Push-Location $Script:TrueForgeRoot
  try {
    $pnpmVersion = (& $Script:CorepackCommand pnpm --version).Trim()
    if ($LASTEXITCODE -ne 0) {
      throw "Corepack could not resolve pnpm from the vendored workspace."
    }
  }
  finally {
    Pop-Location
  }

  if ($pnpmVersion -ne $Script:RequiredPnpm) {
    throw "The vendored workspace requires pnpm $Script:RequiredPnpm through Corepack; resolved $pnpmVersion."
  }
}

function Invoke-Pnpm {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$WorkingDirectory = $Script:TrueForgeRoot
  )

  Push-Location $WorkingDirectory
  try {
    & $Script:CorepackCommand pnpm @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
  }
  finally {
    Pop-Location
  }
}

function Install-TrueForgeDependencies {
  Invoke-Pnpm -Arguments @("install", "--frozen-lockfile")
}

function Ensure-TrueForgeDependencies {
  if (-not (Test-Path -LiteralPath (Join-Path $Script:TrueForgeRoot "node_modules\.pnpm"))) {
    Write-Host "Vendored dependencies are missing; installing them first..."
    Install-TrueForgeDependencies
  }
}

function Ensure-TrueForgeEnvironment {
  $environmentPath = Join-Path $Script:ServerRoot ".env"
  if (-not (Test-Path -LiteralPath $environmentPath)) {
    Copy-Item -LiteralPath (Join-Path $Script:ServerRoot ".env.example") -Destination $environmentPath
    Write-Host "Created trueforge\packages\trueforge\.env from .env.example."
  }
}

function Build-TrueForgeSdkForWindows {
  $distPath = Join-Path $Script:SdkRoot "dist"
  if (Test-Path -LiteralPath $distPath) {
    Remove-Item -LiteralPath $distPath -Recurse -Force
  }
  Invoke-Pnpm -WorkingDirectory $Script:SdkRoot -Arguments @("exec", "tsc", "--project", "tsconfig.cjs.json")
  Invoke-Pnpm -WorkingDirectory $Script:SdkRoot -Arguments @("exec", "tsc", "--project", "tsconfig.esm.json")
  Push-Location $Script:SdkRoot
  try {
    & node scripts/rename-to-esm-files.js dist/esm
    if ($LASTEXITCODE -ne 0) {
      throw "TrueForge SDK ESM rename failed with exit code $LASTEXITCODE."
    }
  }
  finally {
    Pop-Location
  }
}

function Build-TrueForgeUiForWindows {
  Build-TrueForgeSdkForWindows

  $distPath = Join-Path $Script:UiRoot "dist"
  if (Test-Path -LiteralPath $distPath) {
    Remove-Item -LiteralPath $distPath -Recurse -Force
  }
  Invoke-Pnpm -WorkingDirectory $Script:UiRoot -Arguments @(
    "exec", "tailwindcss", "--input", "src/build-styles.css", "--output", "dist/styles.css", "--minify"
  )
  Invoke-Pnpm -WorkingDirectory $Script:UiRoot -Arguments @("exec", "tsup")
}

function Prepare-TrueForgeDevelopment {
  Invoke-Pnpm -Arguments @("--filter", "@truefoundry/trueforge-core", "build:gen")
  Push-Location $Script:ServerRoot
  try {
    & node scripts/generate-local-sandbox-scripts.mjs
    if ($LASTEXITCODE -ne 0) {
      throw "TrueForge local-sandbox generation failed with exit code $LASTEXITCODE."
    }
    & node scripts/generate-catalog.mjs
    if ($LASTEXITCODE -ne 0) {
      throw "TrueForge catalog generation failed with exit code $LASTEXITCODE."
    }
  }
  finally {
    Pop-Location
  }
  Build-TrueForgeUiForWindows
}
