#!/usr/bin/env bash
# Fix #2 for the bare /geohot path — this replaces the "no redirect at all" attempt, which was wrong.
#
# The real defect: with React Router's basename set to /geohot, the URL must be /geohot/ (or a longer
# path under it). A bare /geohot renders fine on the server (SSR normalises it) but the client-side
# router cannot resolve it and falls through to the 404 route — which is exactly "the page loads once,
# then breaks after you navigate away and come back", because every sidebar link for the home tab is
# href="/geohot".
#
# So the trailing-slash redirect is load-bearing and must stay. What was wrong with the original was
# only its TARGET: `return 308 /geohot/` is built from the connection scheme, and since Cloudflare
# reaches the origin in plaintext the Location came out as http://. Spelling the scheme out fixes that
# without removing the normalisation.
set -euo pipefail
CONF=/etc/nginx/sites-available/xxc2007.me
STAMP=$(date +%F-%H%M%S)
BAK=$CONF.bak-$STAMP
sudo cp -a "$CONF" "$BAK"
echo "backup: $BAK"
echo "before: $(sudo sha256sum "$CONF" | cut -c1-16)"

sudo cat "$CONF" > /tmp/xxc-edit.conf
python3 - /tmp/xxc-edit.conf /tmp/xxc-new.conf <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()

if re.search(r"location = /geohot \{", text):
    sys.exit("an exact-match /geohot block already exists — nothing written")

anchor = "location ^~ /geohot {"
if anchor not in text:
    sys.exit("^~ /geohot location not found — nothing written")

block = (
    "# 裸路径补斜杠：客户端路由的 basename 是 /geohot，裸路径在浏览器里解析不到首页。\n"
    "# 目标写死 https，不要用相对路径——相对 Location 按连接协议拼接，而 Cloudflare 是明文回源。\n"
    "location = /geohot {\n"
    "    return 308 https://$host/geohot/;\n"
    "}\n\n"
)
# Insert before the first `^~ /geohot` occurrence.
text = text.replace(anchor, block + anchor, 1)
open(dst, "w", encoding="utf-8").write(text)
print("added exact-match redirect to https://$host/geohot/")
PY

sudo cp /tmp/xxc-new.conf "$CONF"
echo "after:  $(sudo sha256sum "$CONF" | cut -c1-16)"
sudo grep -n -A1 "location = /geohot" "$CONF"

if sudo nginx -t 2>&1 | tail -2; then
  sudo systemctl reload nginx
  sleep 3
  echo "nginx: $(systemctl is-active nginx)"
else
  echo "TEST FAILED — restoring"; sudo cp -a "$BAK" "$CONF"; sudo nginx -t || true; exit 1
fi
