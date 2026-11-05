# nginx 片段（`/etc/nginx/conf.d/*.conf` 的那一层）

这些文件此前只活在服务器上（`/etc/nginx/conf.d/`），仓库里没有副本 —— 任何人都无法照仓库重建这台机器的边缘行为，
`verify-github-sync.sh` 也证不了它们。2026-11-05 起逐步收进来，**改动必须先进仓库再部署**：

| 文件 | 服务器位置 | 干什么 |
| --- | --- | --- |
| `28-geohot-public-admission.conf` | `/etc/nginx/conf.d/28-geohot-public-admission.conf` | 按「动态页 / 静态资源 / 后台与 API」分桶限并发；读者请求按真实客户端 IP 限速 2r/s；**本机回环不进限速桶**（部署验收一口气取 16 个页面，否则它会把自己打成 503） |

装法（仓库 HEAD → 机器）：

```bash
scp deploy/geohot/nginx/*.conf "$TARGET:/tmp/" && ssh "$TARGET" \
  'sudo cp /tmp/28-geohot-public-admission.conf /etc/nginx/conf.d/ && sudo nginx -t && sudo systemctl reload nginx'
```

`nginx -t` 不过就别 reload —— 这一层的错误会直接影响读者面。
