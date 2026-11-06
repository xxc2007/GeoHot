#!/usr/bin/env bash
# 新服务器（阿里云轻量 · 华中1 武汉 · 2 vCPU / 1 GiB / 30 GB · 8.148.65.89）引导脚本。
# 角色：① 24h 分析执行器（接主库只读 Job 队列，替代只在夜里开的本机）②真浏览器验证机 ③备份落地节点。
# 2026-11-06 由 lead 生成；幂等，可重复执行。
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
DEPLOY_PUB='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ4G5jMeTdomI/wgz/vhnt3jTGHUlHSOMZKSoVFV9n8Y geohot-deploy@xxc2007'

echo "== 1. 基础包 =="
# 云镜像开机后 unattended-upgrades 会攥着 dpkg 锁；等它放手，别抢（抢了会留下半装状态）。
export APT_LOCK_OPTS='-o DPkg::Lock::Timeout=600'
for i in $(seq 1 40); do
  if ! fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 && ! fuser /var/lib/dpkg/lock >/dev/null 2>&1; then break; fi
  echo "   waiting for dpkg lock ($i)"
  sleep 15
done
apt-get $APT_LOCK_OPTS update -qq
apt-get $APT_LOCK_OPTS install -y -qq git curl ca-certificates xz-utils rsync jq unzip procps cron

echo "== 2. swap（1 GiB 内存跑 worker + 浏览器，没有 swap 会被 OOM 直接打断）=="
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
free -m | sed -n 1,3p

echo "== 3. Node 24（仓库 engienes 要求 >=24.11；走 npmmirror，国内直连 nodejs.org 太慢）=="
if ! /usr/local/node/bin/node -v >/dev/null 2>&1; then
  file=$(curl -fsSL https://cdn.npmmirror.com/binaries/node/latest-v24.x/SHASUMS256.txt | grep -o 'node-v[0-9.]*-linux-x64.tar.xz' | head -1)
  echo "   downloading $file"
  curl -fsSL "https://cdn.npmmirror.com/binaries/node/latest-v24.x/$file" -o /tmp/node.tar.xz
  mkdir -p /usr/local/node && tar -xJf /tmp/node.tar.xz -C /usr/local/node --strip-components=1
  ln -sf /usr/local/node/bin/node /usr/local/bin/node
  ln -sf /usr/local/node/bin/npm /usr/local/bin/npm
  ln -sf /usr/local/node/bin/npx /usr/local/bin/npx
fi
node -v; npm -v

echo "== 4. 用户与公钥 =="
id geohot >/dev/null 2>&1 || useradd -m -s /bin/bash geohot
install -d -m 700 -o geohot -g geohot /home/geohot/.ssh
touch /home/geohot/.ssh/authorized_keys /root/.ssh/authorized_keys 2>/dev/null || true
mkdir -p /root/.ssh && chmod 700 /root/.ssh
grep -q 'geohot-deploy@xxc2007' /home/geohot/.ssh/authorized_keys || echo "$DEPLOY_PUB" >> /home/geohot/.ssh/authorized_keys
grep -q 'geohot-deploy@xxc2007' /root/.ssh/authorized_keys || echo "$DEPLOY_PUB" >> /root/.ssh/authorized_keys
chown -R geohot:geohot /home/geohot/.ssh
chmod 600 /home/geohot/.ssh/authorized_keys /root/.ssh/authorized_keys

echo "== 5. 仓库（GitHub 直连慢就走 ghfast 镜像；只取发布线）=="
if [ ! -d /home/geohot/geohot/.git ]; then
  su - geohot -c 'git clone --depth 1 https://github.com/xxc2007/GeoHot.git ~/geohot \
    || git clone --depth 1 https://ghfast.top/https://github.com/xxc2007/GeoHot.git ~/geohot'
fi
su - geohot -c 'cd ~/geohot && git log --oneline -1'

echo "== 6. 依赖（走 npmmirror）=="
su - geohot -c 'npm config set registry https://registry.npmmirror.com && cd ~/geohot && npm ci --no-audit --no-fund' 2>&1 | tail -5

echo "== 7. 结果 =="
su - geohot -c 'node -v; cd ~/geohot && node -e "console.log(require(\"node:fs\").existsSync(\"node_modules\") ? \"node_modules ok\" : \"missing\")"'
df -h / | tail -1
echo BOOTSTRAP_OK
