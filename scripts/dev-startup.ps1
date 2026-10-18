# Shared by the local Windows launcher; loading this file does not start services.
#requires -Version 7.0

function Test-ScienceEvolveDevReady {
  param(
    [Parameter(Mandatory = $true)][string]$WebUrl,
    [Parameter(Mandatory = $true)][string]$ApiUrl
  )
  try {
    $health = Invoke-RestMethod -Uri "$($ApiUrl.TrimEnd('/'))/api/health" -TimeoutSec 5 -NoProxy -ErrorAction Stop
    if ($health.status -ne 'ok' -or -not $health.codexVersion) { return $false }
    $web = Invoke-WebRequest -Uri $WebUrl -TimeoutSec 5 -NoProxy -ErrorAction Stop
    if ($web.StatusCode -ne 200 -or $web.Content -notmatch '<div\s+id="root"') { return $false }
    $proxyHealth = Invoke-RestMethod -Uri "$($WebUrl.TrimEnd('/'))/api/health" -TimeoutSec 5 -NoProxy -ErrorAction Stop
    return $proxyHealth.status -eq 'ok' -and $proxyHealth.codexVersion -eq $health.codexVersion
  } catch {
    return $false
  }
}

function Wait-ScienceEvolveDevReady {
  param(
    [Parameter(Mandatory = $true)][string]$WebUrl,
    [Parameter(Mandatory = $true)][string]$ApiUrl,
    [ValidateRange(1, 600)][int]$TimeoutSeconds = 120,
    [ValidateRange(1, 5000)][int]$PollMilliseconds = 500
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-ScienceEvolveDevReady -WebUrl $WebUrl -ApiUrl $ApiUrl) { return $true }
    Start-Sleep -Milliseconds $PollMilliseconds
  }
  return $false
}
