. (Join-Path $PSScriptRoot "trueforge-common.ps1")

Assert-TrueForgeRuntime
Ensure-TrueForgeDependencies
Ensure-TrueForgeEnvironment
Prepare-TrueForgeDevelopment

Write-Host "Typechecking vendored TrueForge packages..."
Invoke-Pnpm -WorkingDirectory (Join-Path $Script:TrueForgeRoot "packages\trueforge-core") -Arguments @("exec", "tsc", "--noEmit")
Invoke-Pnpm -WorkingDirectory $Script:UiRoot -Arguments @("exec", "tsc", "--noEmit")
Invoke-Pnpm -WorkingDirectory $Script:UiRoot -Arguments @("exec", "tsc", "--noEmit", "-p", "test/tsconfig.json")
Invoke-Pnpm -WorkingDirectory $Script:ServerRoot -Arguments @("exec", "tsc", "--noEmit")
Invoke-Pnpm -WorkingDirectory $Script:ServerRoot -Arguments @("exec", "tsc", "--noEmit", "-p", "tests/db/tsconfig.json")
Invoke-Pnpm -WorkingDirectory $Script:ServerRoot -Arguments @("exec", "tsc", "--noEmit", "-p", "tests/unit/tsconfig.json")
Invoke-Pnpm -WorkingDirectory $Script:FrontendRoot -Arguments @("exec", "tsc", "--noEmit")

Write-Host "Running focused adaptive-control and UI wire tests..."
Invoke-Pnpm -WorkingDirectory (Join-Path $Script:TrueForgeRoot "packages\trueforge-core") -Arguments @(
  "exec", "jest", "--runInBand", "tests/core/capabilities/builtins/AdaptiveControls.test.ts", "tests/agent-session/adaptiveControls.test.ts"
)

$previousNodeOptions = $env:NODE_OPTIONS
try {
  $env:NODE_OPTIONS = "--conditions=trueforge-dev"
  Push-Location $Script:ServerRoot
  try {
    & node --env-file=.env.test .\node_modules\jest\bin\jest.js --config jest.unit.config.cjs --runInBand tests/unit/runtime/sessionResources.test.ts
    if ($LASTEXITCODE -ne 0) {
      throw "Focused TrueForge server tests failed with exit code $LASTEXITCODE."
    }
  }
  finally {
    Pop-Location
  }
}
finally {
  $env:NODE_OPTIONS = $previousNodeOptions
}

Invoke-Pnpm -WorkingDirectory $Script:UiRoot -Arguments @(
  "exec", "vitest", "run", "test/containers/ComposerContainer.test.tsx", "test/plugins/trueforge-agent-server-adapter/harnessServer.test.ts"
)

Write-Host "Vendored TrueForge focused checks passed."
