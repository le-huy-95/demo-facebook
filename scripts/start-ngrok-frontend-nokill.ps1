$ErrorActionPreference = 'Stop'

# Tunnel ngrok -> frontend (3001) WITHOUT killing other ngrok processes.
$userConfig = Join-Path $env:LOCALAPPDATA 'Packages\ngrok.ngrok_1g87z0zv29zzc\LocalCache\Local\ngrok\ngrok.yml'

if (-not (Test-Path $userConfig)) {
  Write-Host "Khong tim thay ngrok authtoken. Chay: ngrok config add-authtoken <token>"
  exit 1
}

& ngrok http 3001 --config $userConfig --log=stdout

