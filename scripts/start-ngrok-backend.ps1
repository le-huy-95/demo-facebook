$ErrorActionPreference = 'Stop'

# Tunnel ngrok -> backend (3002) so Facebook webhook can reach local backend.
$userConfig = Join-Path $env:LOCALAPPDATA 'Packages\ngrok.ngrok_1g87z0zv29zzc\LocalCache\Local\ngrok\ngrok.yml'

if (-not (Test-Path $userConfig)) {
  Write-Host "Khong tim thay ngrok authtoken. Chay: ngrok config add-authtoken <token>"
  exit 1
}

Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

& ngrok http 3002 --config $userConfig --log=stdout

