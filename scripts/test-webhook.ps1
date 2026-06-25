Write-Host "=== LOCAL health ===" -ForegroundColor Cyan
try {
  (Invoke-RestMethod "http://localhost:3000/health" -TimeoutSec 5) | ConvertTo-Json
} catch { Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red }

Write-Host "`n=== PUBLIC health ===" -ForegroundColor Cyan
try {
  (Invoke-RestMethod "https://forward.kindergartenmng.vn/health" -TimeoutSec 10) | ConvertTo-Json
} catch { Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red }

Write-Host "`n=== LOCAL /webhook/facebook/status ===" -ForegroundColor Cyan
try {
  $s = Invoke-RestMethod "http://localhost:3000/webhook/facebook/status" -TimeoutSec 5
  "OK signatureEnabled=$($s.data.signatureEnabled)"
} catch { Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red }

Write-Host "`n=== PUBLIC /webhook/facebook/status ===" -ForegroundColor Cyan
try {
  $s2 = Invoke-RestMethod "https://forward.kindergartenmng.vn/webhook/facebook/status" -TimeoutSec 10
  "OK signatureEnabled=$($s2.data.signatureEnabled)"
} catch { Write-Host "FAIL (404 = dang tro server CU, chua tro local): $($_.Exception.Message)" -ForegroundColor Red }

$body = '{"object":"page","entry":[{"id":"113286170349939","messaging":[{"sender":{"id":"27873407178918913"},"recipient":{"id":"113286170349939"},"message":{"mid":"m_test","text":"test"}}]}]}'

Write-Host "`n=== POST local ===" -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest "http://localhost:3000/webhook/facebook" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 8 -UseBasicParsing
  "OK $($r.StatusCode) $($r.Content)"
} catch { Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red }

Write-Host "`n=== POST public ===" -ForegroundColor Cyan
try {
  $r2 = Invoke-WebRequest "https://forward.kindergartenmng.vn/webhook/facebook" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 15 -UseBasicParsing
  "OK $($r2.StatusCode) $($r2.Content)"
} catch {
  if ($_.Exception.Response) {
    Write-Host "FAIL HTTP $($_.Exception.Response.StatusCode.value__) — Facebook webhook bi chan" -ForegroundColor Red
  } else { Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red }
}

Write-Host "`nNeu PUBLIC health khong co instance=local-dev HOAC /status 404 => Cloudflare dang tro server cu." -ForegroundColor Yellow
