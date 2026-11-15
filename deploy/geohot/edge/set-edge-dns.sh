#!/usr/bin/env bash
# 把「国内边缘域名」指向这台机器，并在机器上签证书。
#
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ZONE=xxc2007.me EDGE_DOMAIN=cn.xxc2007.me \
#     bash deploy/geohot/edge/set-edge-dns.sh --apply
#
# 背景（2026-11-15 实测）：华为云对未备案的「注册域」在 80/443 两个端口都拦（ADM 返回 403 非法阻断374），
# 而 xxc2007.me 已有备案 ⇒ 只能用它自己的子域做国内入口，不能新开一个未备案域名。
# Cloudflare 的 API Token 只需要 Zone.DNS:Edit 一项权限（Zone 选 xxc2007.me）。
set -euo pipefail
APPLY=0
for arg in "$@"; do [[ "$arg" == "--apply" ]] && APPLY=1; done

: "${CLOUDFLARE_API_TOKEN:?需要 CLOUDFLARE_API_TOKEN（Zone.DNS:Edit）}"
: "${CLOUDFLARE_ZONE:=xxc2007.me}"
: "${EDGE_DOMAIN:=cn.xxc2007.me}"
: "${EDGE_IP:?需要 EDGE_IP（国内边缘机器的公网 IP）}"

api() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }

zone_id=$(api "https://api.cloudflare.com/client/v4/zones?name=$CLOUDFLARE_ZONE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.success){console.error(j.errors);process.exit(1)}console.log(j.result[0]?.id??"")})')
[[ -n "$zone_id" ]] || { echo "✗ 找不到 zone $CLOUDFLARE_ZONE（token 权限不够？）" >&2; exit 1; }
echo "zone=$zone_id domain=$EDGE_DOMAIN ip=$EDGE_IP"

existing=$(api "https://api.cloudflare.com/client/v4/zones/$zone_id/dns_records?type=A&name=$EDGE_DOMAIN" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.result?.[0]?.id??"")})')

# proxied=false（灰云）：国内读者直连边缘，绕开 Cloudflare 的跨境回源。
payload=$(node -e 'console.log(JSON.stringify({type:"A",name:process.argv[1],content:process.argv[2],ttl:120,proxied:false}))' "$EDGE_DOMAIN" "$EDGE_IP")

if (( ! APPLY )); then
  echo "（DRY-RUN）将写入：$payload"
  [[ -n "$existing" ]] && echo "（会更新已有记录 $existing）" || echo "（会新建记录）"
  echo "确认后加 --apply"
  exit 0
fi

if [[ -n "$existing" ]]; then
  api -X PUT "https://api.cloudflare.com/client/v4/zones/$zone_id/dns_records/$existing" --data "$payload" >/dev/null
  echo "✓ 已更新 A 记录 $EDGE_DOMAIN → $EDGE_IP"
else
  api -X POST "https://api.cloudflare.com/client/v4/zones/$zone_id/dns_records" --data "$payload" >/dev/null
  echo "✓ 已新建 A 记录 $EDGE_DOMAIN → $EDGE_IP"
fi

# 等解析生效（Cloudflare 一般几秒）
for i in $(seq 1 20); do
  got=$(getent hosts "$EDGE_DOMAIN" | awk '{print $1}' | head -1 || true)
  [[ "$got" == "$EDGE_IP" ]] && { echo "✓ 解析已生效：$EDGE_DOMAIN → $got"; break; }
  sleep 6
done

if command -v certbot >/dev/null 2>&1; then
  certbot --nginx -d "$EDGE_DOMAIN" --non-interactive --agree-tos --redirect \
    --register-unsafely-without-email || echo "✗ certbot 失败：先确认 DNS 已生效、80 端口可从公网访问"
else
  echo "！这台机器上没有 certbot，先 apt-get install -y certbot python3-certbot-nginx"
fi
