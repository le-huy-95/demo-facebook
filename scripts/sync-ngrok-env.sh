#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
WEB_ENV_FILE="$ROOT/apps/web/.env.local"

BASE_URL="$(curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "
import sys, json
data = json.load(sys.stdin)
tunnel = next((t for t in data.get('tunnels', []) if t.get('proto') == 'https'), None)
if not tunnel:
    raise SystemExit(1)
print(tunnel['public_url'].rstrip('/'))
")"

set_env_line() {
  local file="$1"
  local key="$2"
  local value="$3"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

set_env_line "$ENV_FILE" 'PUBLIC_BASE_URL' "$BASE_URL"
set_env_line "$ENV_FILE" 'FRONTEND_URL' "$BASE_URL"
set_env_line "$ENV_FILE" 'FACEBOOK_OAUTH_REDIRECT_URI' "$BASE_URL/facebook-page/oauth/callback"
# Frontend kết nối thẳng Nest: Socket/SSE ổn định hơn qua Next.js dev proxy
set_env_line "$WEB_ENV_FILE" 'NEXT_PUBLIC_API_URL' 'http://localhost:3000'
set_env_line "$WEB_ENV_FILE" 'NEXT_PUBLIC_SOCKET_URL' 'http://localhost:3000'

echo "Ngrok HTTPS: $BASE_URL"
echo "Mo app: $BASE_URL/login"
echo "OAuth redirect: $BASE_URL/facebook-page/oauth/callback"
echo "Webhook URL: $BASE_URL/webhook/facebook"
