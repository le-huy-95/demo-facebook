$ErrorActionPreference = 'Stop'

# Tunnel ngrok -> backend (3002) WITHOUT killing other ngrok processes.
$userConfig = Join-Path $env:LOCALAPPDATA 'Packages\ngrok.ngrok_1g87z0zv29zzc\LocalCache\Local\ngrok\ngrok.yml'

if (-not (Test-Path $userConfig)) {
  Write-Host "Khong tim thay ngrok authtoken. Chay: ngrok config add-authtoken <token>"
  exit 1
}

& ngrok http 3002 --config $userConfig --log=stdout

