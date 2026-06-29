# Cap nhat URL ngrok (frontend + backend API qua cung domain)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$webEnvFile = Join-Path $projectRoot 'apps\web\.env.local'

try {
  $tunnels = (Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 5).tunnels
  $https = $tunnels | Where-Object { $_.proto -eq 'https' } | Select-Object -First 1
  if (-not $https) {
    Write-Host 'Chua co tunnel HTTPS. Chay: npm run dev:ngrok'
    exit 1
  }
  $baseUrl = $https.public_url.TrimEnd('/')
} catch {
  Write-Host 'Khong ket noi duoc ngrok API (port 4040). Chay: npm run dev:ngrok'
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

# Cung 1 domain ngrok cho frontend UI + API (proxy) + Facebook OAuth/webhook
Set-EnvLine $envFile 'PUBLIC_BASE_URL' $baseUrl
Set-EnvLine $envFile 'FRONTEND_URL' $baseUrl
Set-EnvLine $envFile 'FACEBOOK_OAUTH_REDIRECT_URI' "$baseUrl/facebook-page/oauth/callback"
Set-EnvLine $webEnvFile 'NEXT_PUBLIC_API_URL' $baseUrl
Set-EnvLine $webEnvFile 'NEXT_PUBLIC_SOCKET_URL' $baseUrl

Write-Host "Ngrok HTTPS (frontend + API): $baseUrl"
Write-Host "Mo app: $baseUrl/login"
Write-Host "OAuth redirect: $baseUrl/facebook-page/oauth/callback"
Write-Host "Webhook URL:    $baseUrl/webhook/facebook"
