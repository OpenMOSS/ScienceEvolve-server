#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-startup.ps1')

# No service startup, browser opening, dependency installs or user-data writes.
$script:case = 'ready'
function Invoke-RestMethod {
  param($Uri, $TimeoutSec, [switch]$NoProxy, $ErrorAction)
  if (-not $NoProxy) { throw 'Local probes must bypass external proxies' }
  if ($script:case -eq 'backend-down') { throw 'Connection refused' }
  if ($script:case -eq 'proxy-down' -and $Uri -like '*:5173/*') { throw 'Bad gateway' }
  if ($script:case -eq 'other-server') { return @{ status = 'ok' } }
  return @{ status = 'ok'; codexVersion = 'test-version' }
}
function Invoke-WebRequest {
  param($Uri, $TimeoutSec, [switch]$NoProxy, $ErrorAction)
  if (-not $NoProxy) { throw 'Local probes must bypass external proxies' }
  if ($script:case -eq 'frontend-down') { throw 'Connection refused' }
  return @{ StatusCode = 200; Content = if ($script:case -eq 'wrong-page') { '<p>Other application</p>' } else { '<div id="root"></div>' } }
}

foreach ($scenario in @('ready', 'backend-down', 'proxy-down', 'other-server', 'frontend-down', 'wrong-page')) {
  $script:case = $scenario
  $actual = Test-ScienceEvolveDevReady -WebUrl 'http://127.0.0.1:5173' -ApiUrl 'http://127.0.0.1:4311'
  if ($actual -ne ($scenario -eq 'ready')) { throw "Readiness assertion failed: $scenario" }
}
$script:attempts = 0
function Test-ScienceEvolveDevReady {
  param($WebUrl, $ApiUrl)
  $script:attempts++
  return $script:attempts -ge 3
}
if (-not (Wait-ScienceEvolveDevReady -WebUrl 'web' -ApiUrl 'api' -TimeoutSeconds 1 -PollMilliseconds 1)) { throw 'Readiness retry failed' }
if ($script:attempts -ne 3) { throw 'Readiness returned before both services were ready' }
function Test-ScienceEvolveDevReady { param($WebUrl, $ApiUrl); return $false }
if (Wait-ScienceEvolveDevReady -WebUrl 'web' -ApiUrl 'api' -TimeoutSeconds 1 -PollMilliseconds 10) { throw 'Timeout must not open the browser' }
Write-Output 'PASS: 8 startup readiness checks'
