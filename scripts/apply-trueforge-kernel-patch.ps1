[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$TrueForgePath,

  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$ExpectedRemote = 'https://github.com/truefoundry/trueforge.git'
$ExpectedBase = 'a3a13956e99c2f90cca37b48c324812ad03b493a'
$ExpectedSha256 = 'EED16D5B8458A5BCA0CC3BE7FC4E5B52CBF863911B7EBD5DBB9297F0EB9E0B2B'
$PatchPath = Join-Path $PSScriptRoot '..\patches\trueforge-adaptive-kernel.patch'

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $output = & git -C $TrueForgePath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed:`n$($output -join "`n")"
  }
  return $output
}

$resolvedTarget = (Resolve-Path $TrueForgePath).Path
$resolvedPatch = (Resolve-Path $PatchPath).Path
$TrueForgePath = $resolvedTarget

$remote = (Invoke-Git remote get-url origin | Select-Object -First 1).Trim()
if ($remote -ne $ExpectedRemote) {
  throw "Unexpected origin '$remote'. Expected '$ExpectedRemote'."
}

$head = (Invoke-Git rev-parse HEAD | Select-Object -First 1).Trim()
if ($head -ne $ExpectedBase) {
  throw "Target HEAD is '$head'. Expected exact base '$ExpectedBase'."
}

$status = @(Invoke-Git status --porcelain)
if ($status.Count -ne 0) {
  throw "Target working tree is not clean. Refusing to mix the patch with existing changes."
}

$actualSha256 = (Get-FileHash $resolvedPatch -Algorithm SHA256).Hash
if ($actualSha256 -ne $ExpectedSha256) {
  throw "Patch checksum mismatch. Expected $ExpectedSha256, got $actualSha256."
}

Invoke-Git apply --check --whitespace=error-all $resolvedPatch | Out-Null
Write-Host 'Patch validation passed.' -ForegroundColor Green

if (-not $Apply) {
  Write-Host 'No files changed. Re-run with -Apply to apply the patch.'
  exit 0
}

Invoke-Git apply --whitespace=error-all $resolvedPatch | Out-Null
Write-Host 'Patch applied. No commit or push was created.' -ForegroundColor Green
