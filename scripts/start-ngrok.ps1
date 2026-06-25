# Chi 1 tunnel ngrok -> frontend (3001). API backend duoc proxy qua Next.js rewrites.
$ErrorActionPreference = 'Stop'
$userConfig = Join-Path $env:LOCALAPPDATA 'Packages\ngrok.ngrok_1g87z0zv29zzc\LocalCache\Local\ngrok\ngrok.yml'

if (-not (Test-Path $userConfig)) {
  Write-Host "Khong tim thay ngrok authtoken. Chay: ngrok config add-authtoken <token>"
  exit 1
}

Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

& ngrok http 3001 --config $userConfig --log=stdout
