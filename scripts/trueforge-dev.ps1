. (Join-Path $PSScriptRoot "trueforge-common.ps1")

Assert-TrueForgeRuntime
Ensure-TrueForgeDependencies
Ensure-TrueForgeEnvironment
Prepare-TrueForgeDevelopment

$apiPort = if ([string]::IsNullOrWhiteSpace($env:TRUEFORGE_API_PORT)) { 8790 } else { [int]$env:TRUEFORGE_API_PORT }
$uiPort = if ([string]::IsNullOrWhiteSpace($env:TRUEFORGE_UI_PORT)) { 3000 } else { [int]$env:TRUEFORGE_UI_PORT }
if ($apiPort -lt 1 -or $apiPort -gt 65535 -or $uiPort -lt 1 -or $uiPort -gt 65535) {
  throw "TRUEFORGE_API_PORT and TRUEFORGE_UI_PORT must be valid TCP ports."
}

$previousStandalone = $env:STANDALONE
$previousNodeEnvironment = $env:NODE_ENV
$previousNodeOptions = $env:NODE_OPTIONS
$previousPort = $env:PORT
$previousHost = $env:HOST
$previousFrontendPort = $env:FRONTEND_PORT
$previousViteServerUrl = $env:VITE_SERVER_URL
$env:STANDALONE = "true"
$env:NODE_ENV = "development"
$env:PORT = $apiPort.ToString()
$env:HOST = "127.0.0.1"
$env:FRONTEND_PORT = $uiPort.ToString()
$env:VITE_SERVER_URL = "http://127.0.0.1:$apiPort"
$env:NODE_OPTIONS = if ([string]::IsNullOrWhiteSpace($previousNodeOptions)) {
  "--conditions=trueforge-dev"
} else {
  "$previousNodeOptions --conditions=trueforge-dev"
}

$server = $null
$frontend = $null
try {
  Write-Host "Starting vendored TrueForge API at http://localhost:$apiPort"
  Write-Host "Starting vendored TrueForge UI at http://localhost:$uiPort"
  Write-Host "Press Ctrl+C to stop both processes."

  $server = Start-Process -FilePath $Script:CorepackCommand -ArgumentList @(
    "pnpm", "exec", "tsx", "watch", "--env-file=.env", "src/main.ts"
  ) -WorkingDirectory $Script:ServerRoot -NoNewWindow -PassThru
  $frontend = Start-Process -FilePath $Script:CorepackCommand -ArgumentList @(
    "pnpm", "exec", "vite", "--host", "127.0.0.1"
  ) -WorkingDirectory $Script:FrontendRoot -NoNewWindow -PassThru

  if ($env:TRUEFORGE_SMOKE_TEST -eq "1") {
    $deadline = (Get-Date).AddSeconds(120)
    $apiReady = $false
    $uiReady = $false
    while ((Get-Date) -lt $deadline -and -not $server.HasExited -and -not $frontend.HasExited) {
      try {
        $health = Invoke-WebRequest -Uri "http://127.0.0.1:$apiPort/healthz" -UseBasicParsing -TimeoutSec 2
        $apiReady = $health.StatusCode -eq 200
      }
      catch {
        $apiReady = $false
      }
      try {
        $page = Invoke-WebRequest -Uri "http://127.0.0.1:$uiPort/" -UseBasicParsing -TimeoutSec 2
        $pageContent = if ($page.Content -is [byte[]]) {
          [System.Text.Encoding]::UTF8.GetString($page.Content)
        } else {
          [string]$page.Content
        }
        $uiReady = $page.StatusCode -eq 200 -and $pageContent -match 'id="root"'
      }
      catch {
        $uiReady = $false
      }
      if ($apiReady -and $uiReady) {
        Write-Host "STARTUP_SMOKE_API=OK"
        Write-Host "STARTUP_SMOKE_UI=OK"
        return
      }
      Start-Sleep -Seconds 1
      $server.Refresh()
      $frontend.Refresh()
    }
    throw "TrueForge startup smoke test did not observe healthy API and UI endpoints within 120 seconds."
  }

  while (-not $server.HasExited -and -not $frontend.HasExited) {
    Start-Sleep -Milliseconds 500
    $server.Refresh()
    $frontend.Refresh()
  }

  if ($server.HasExited -and $server.ExitCode -ne 0) {
    throw "TrueForge API exited with code $($server.ExitCode)."
  }
  if ($frontend.HasExited -and $frontend.ExitCode -ne 0) {
    throw "TrueForge UI exited with code $($frontend.ExitCode)."
  }
}
finally {
  foreach ($process in @($server, $frontend)) {
    if ($null -ne $process -and -not $process.HasExited) {
      & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
      $process.WaitForExit()
    }
  }
  $env:STANDALONE = $previousStandalone
  $env:NODE_ENV = $previousNodeEnvironment
  $env:NODE_OPTIONS = $previousNodeOptions
  $env:PORT = $previousPort
  $env:HOST = $previousHost
  $env:FRONTEND_PORT = $previousFrontendPort
  $env:VITE_SERVER_URL = $previousViteServerUrl
}
