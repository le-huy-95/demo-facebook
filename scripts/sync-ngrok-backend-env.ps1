$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'

try {
  $tunnels = (Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 5).tunnels
  $https = $tunnels | Where-Object { $_.proto -eq 'https' } | Select-Object -First 1
  if (-not $https) {
    Write-Host 'Chua co tunnel HTTPS. Chay: npm run dev:ngrok:backend'
    exit 1
  }
  $baseUrl = $https.public_url.TrimEnd('/')
} catch {
  Write-Host 'Khong ket noi duoc ngrok API (port 4040). Chay: npm run dev:ngrok:backend'
  exit 1
}

function Set-EnvLine {
  param([string]$File, [string]$Key, [string]$Value)
  $content = if (Test-Path $File) { Get-Content $File -Raw } else { '' }
  if ($content -match "(?m)^$Key=") {
    $content = $content -replace "(?m)^$Key=.*$", "$Key=$Value"
  } else {
    if ($content -and -not $content.EndsWith("`n")) { $content += "`n" }
    $content += "$Key=$Value`n"
  }
  Set-Content -Path $File -Value $content.TrimEnd() -Encoding UTF8 -NoNewline
  Add-Content -Path $File -Value '' -Encoding UTF8
}

# Backend public base for uploads + Facebook OAuth/webhook callbacks.
Set-EnvLine $envFile 'PUBLIC_BASE_URL' $baseUrl
Set-EnvLine $envFile 'FRONTEND_URL' $baseUrl
Set-EnvLine $envFile 'FACEBOOK_OAUTH_REDIRECT_URI' "$baseUrl/facebook-page/oauth/callback"

Write-Host "Ngrok HTTPS (backend): $baseUrl"
Write-Host "Webhook URL:         $baseUrl/webhook/facebook"
Write-Host "OAuth redirect:      $baseUrl/facebook-page/oauth/callback"

