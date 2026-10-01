#!/usr/bin/env bash
# Fix: https://xxc2007.me/geohot (no trailing slash) rendered the app's 404 in the browser.
#
# Root cause: nginx answered the bare path with `return 308 /geohot/`, and because Cloudflare reaches
# the origin over plaintext HTTP, the Location came out as `http://…`. An HTTPS page that bounces the
# visitor to plaintext is fragile: it relies on the edge rewriting the scheme, and this zone does not
# force http->https (verified: http://xxc2007.me/geohot/ answers 200 directly).
#
# The redirect is also unnecessary — the app serves byte-identical bytes for `/geohot` and `/geohot/`
# (147116 bytes, same title, no 404 marker, verified on the origin). So: stop redirecting, and widen
# the location to `^~ /geohot` so the bare path reaches the app. One fewer hop, one fewer way to fail.
#
# `^~` is kept for the reason recorded in the snippet: a `~* \.(css|js|…)$` location in the same vhost
# would otherwise win and every asset would 404.
#
# Writes via /tmp then sudo cp: an unprivileged python3 cannot write /etc/nginx.
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
lines = open(src, encoding="utf-8").read().split("\n")

out, i, removed = [], 0, 0
while i < len(lines):
    if re.match(r"^\s*location = /geohot \{", lines[i]):
        i += 1
        while i < len(lines) and lines[i].strip() != "}":
            i += 1
        i += 1
        removed += 1
        if i < len(lines) and lines[i].strip() == "":
            i += 1
        continue
    out.append(lines[i])
    i += 1
print("removed bare-path redirect blocks:", removed)

text = "\n".join(out)
if "location ^~ /geohot/ {" in text:
    text = text.replace("location ^~ /geohot/ {", "location ^~ /geohot {", 1)
    print("widened ^~ /geohot/ -> ^~ /geohot")
elif "location ^~ /geohot {" in text:
    print("already widened")
else:
    sys.exit("geohot location not found — nothing written")
open(dst, "w", encoding="utf-8").write(text)
PY

sudo cp /tmp/xxc-new.conf "$CONF"
echo "after:  $(sudo sha256sum "$CONF" | cut -c1-16)"
sudo grep -n "location.*geohot" "$CONF"

if sudo nginx -t 2>&1 | tail -2; then
  sudo systemctl reload nginx
  sleep 3
  echo "nginx: $(systemctl is-active nginx)"
else
  echo "TEST FAILED — restoring"; sudo cp -a "$BAK" "$CONF"; sudo nginx -t || true; exit 1
fi
