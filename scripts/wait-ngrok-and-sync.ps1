# Doi ngrok san sang roi cap nhat .env (PUBLIC_BASE_URL, OAuth redirect, ...)
$ErrorActionPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot

for ($i = 0; $i -lt 90; $i++) {
  try {
    $tunnels = (Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2).tunnels
    $https = $tunnels | Where-Object { $_.proto -eq 'https' } | Select-Object -First 1
    if ($https?.public_url) {
      Push-Location $projectRoot
      & npm run sync:ngrok 2>&1 | Out-Host
      Pop-Location
      exit 0
    }
  } catch {
    # ngrok chua len
  }
  Start-Sleep -Seconds 2
}

Write-Host '[wait-ngrok] Timeout — chay thu: npm run sync:ngrok' -ForegroundColor Yellow
exit 1
