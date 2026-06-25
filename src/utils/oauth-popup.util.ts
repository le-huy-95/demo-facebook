/**
 * Sinh trang HTML tự đóng popup dùng sau OAuth callback.
 */
export function renderOAuthCallbackPage(
  status: 'success' | 'error',
  message: string,
): string {
  const isSuccess = status === 'success';
  const accent = isSuccess ? '#16a34a' : '#dc2626';
  const bgAccent = isSuccess ? '#f0fdf4' : '#fef2f2';
  const ringColor = isSuccess ? '#bbf7d0' : '#fecaca';
  const icon = isSuccess ? '✓' : '✕';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  display:flex;align-items:center;justify-content:center;min-height:100vh;
  background:linear-gradient(135deg,#f8fafc 0%,#f1f5f9 100%);}
.card{background:#fff;border-radius:20px;padding:40px 48px;text-align:center;
  box-shadow:0 8px 40px rgba(0,0,0,.08),0 1px 3px rgba(0,0,0,.06);
  animation:rise .35s cubic-bezier(.34,1.56,.64,1) both;}
@keyframes rise{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:none}}
.ring{width:72px;height:72px;border-radius:50%;background:${bgAccent};
  border:2px solid ${ringColor};display:flex;align-items:center;justify-content:center;
  margin:0 auto 20px;animation:pop .4s .1s cubic-bezier(.34,1.56,.64,1) both;}
@keyframes pop{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:scale(1)}}
.icon{font-size:2rem;color:${accent};font-weight:700;line-height:1}
h2{font-size:1rem;font-weight:600;color:#111827;margin-bottom:6px}
p{font-size:0.82rem;color:#9ca3af}
.bar{width:80px;height:3px;background:#f1f5f9;border-radius:99px;margin:20px auto 0;overflow:hidden}
.bar-fill{height:100%;width:0%;background:${accent};border-radius:99px;
  animation:fill 1.5s .2s linear forwards;}
@keyframes fill{to{width:100%}}
</style></head>
<body><div class="card">
  <div class="ring"><span class="icon">${icon}</span></div>
  <h2>${message}</h2>
  <p>${isSuccess ? 'Cửa sổ này sẽ tự đóng...' : 'Vui lòng kiểm tra lại'}</p>
  ${isSuccess ? '<div class="bar"><div class="bar-fill"></div></div>' : ''}
</div>
${
  isSuccess
    ? `<script>
if (window.opener) {
  window.opener.postMessage({ type: 'FACEBOOK_OAUTH_SUCCESS', message: ${JSON.stringify(message)} }, '*');
}
setTimeout(()=>window.close(),1500);
</script>`
    : `<script>
if (window.opener) {
  window.opener.postMessage({ type: 'FACEBOOK_OAUTH_ERROR', message: ${JSON.stringify(message)} }, '*');
}
</script>`
}
</body></html>`;
}
