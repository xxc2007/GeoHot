# 服务器 Magpie 模型网关与后台代理

GEOHOT 的网站、数据库、队列、内容执行器和模型网关都部署在服务器节点上；工作站关机不是模型渠道的必需条件，生产不依赖本机 worker 或本机 Magpie。Magpie 网关部署在协调/执行节点（杭州），只绑回环地址：模型网关 `127.0.0.1:3426`，Web 控制台 `127.0.0.1:3430`，**不向公网开放管理界面或模型端口**。

## 节点与代理边界

- 模型网关与 Web 控制台绑在网关所在节点的本机回环；读者节点不直连网关公网，是否存在本地 Magpie 进程以最终部署为准。
- 后台 Magpie 面板由读者节点 API 代理访问：上游由 `MAGPIE_WEB_BASE_URL` 配置，默认 `http://127.0.0.1:3430`，只允许 http loopback（`localhost`/`::1`/`127.*`），不接受真实公网 IP，跨机访问走本机 SSH 隧道，代理里不硬编码对端地址。生产 Azure 最终方案：读者节点 API 设 `MAGPIE_WEB_BASE_URL=http://127.0.0.1:3431`，本机 3431 经隧道转发到杭州节点网关 `127.0.0.1:3430`；直连 3430 只兼容旧的本地进程。代理实现见 `apps/api/src/routes/server-console.ts`。
- 代理边界：
  - 必须有后台会话 + CSRF；上游 secret cookie 优先取 `MAGPIE_WEB_COOKIE` 环境变量，否则读 `MAGPIE_WEB_KEY_FILE`（默认 `/etc/geohot/magpie-web-key`），密钥不回传浏览器，文档与日志不写 cookie 值。
  - 屏蔽模型网关 `/v1`、`/_magpie`、登录/换 token 路由、`k` 查询参数、路径穿越、反斜杠、Origin 不一致与跨源跳转。
  - 静态资源（js/css/字体/图片）走浏览器缓存、不限流；面板 API 调用 300/分钟。
- 不要把网关地址改成工作站 IP，不要把旧反向隧道恢复成日常依赖；任何情况下都不把 3426/3430 端口绑到公网网卡。

## 安装与身份边界

- Magpie 来源为 [yetone/magpie 官方发布](https://github.com/yetone/magpie/releases)。2026-10-25 安装记录：Linux amd64 CLI 版本 `0.1.1489`，SHA-256 `860be361a1da152d00b07534b2b809d21c47e15baaf59f22e4a427e917eaf6b8`，与官方 `SHA256SUMS` 一致；版本与哈希以那次安装为准，升级另走 `magpie-update.sh` 复核。
- 运行账户为专用系统用户 `geohot-magpie`，HOME 为 `/var/lib/geohot-magpie`。凭据只保存在其私有 `.config/magpie/`，不提交到 Git、不放到网站目录。
- 只迁移网站使用的渠道及其既有账号；国际 WorkBuddy AI 与国内 WorkBuddy 是不同渠道。插件版本固定在安装记录里；保留刷新凭据、设备身份和账号顺序；不复制本机其他应用的整个用户目录、浏览器资料或历史会话。
- 线上服务单元实际名为 `geohot-magpie.service`；仓库另有 `deploy/geohot/systemd/geohot-magpie-hangzhou.service` 模板变体。运行目录 0700，凭据文件 0600。网关的无窗口运行和 token 刷新由上游程序及插件提供，不需要桌面常驻。

## 网站配置

以下三项保留原有 `/v1` 后缀，指向本机回环端口，通过 `/etc/geohot/magpie-server.env` 覆盖 API、协调器和内容执行器的进程环境：

```dotenv
QODER_CN_BASE_URL=http://127.0.0.1:3426/v1
CODEARTS_BASE_URL=http://127.0.0.1:3426/v1
MINIMAX_CODE_BASE_URL=http://127.0.0.1:3426/v1
```

`.env` 中的对应地址同步更新。模型名称、预算、权重、并发和回执机制保持既有配置。三个应用服务的覆盖文件包含启动顺序：系统启动时先起网关；网关短暂退出不连带停止工作流，由现有重试和预算机制处理。

## 维护与验证

```sh
systemctl is-enabled geohot-magpie.service
systemctl status geohot-magpie.service --no-pager
systemctl show geohot-magpie.service -p NRestarts -p MemoryCurrent
curl --fail http://127.0.0.1:3426/v1/models
```

模型目录只证明账号被识别。真实调用要经过 GEOHOT 的 `paidRequest`、预算和回执；用现有工作流的新回执与入库结果验证，不直接用裸请求绕过账本。验证期间不清理 unknown 回执、不提高并发、不绕过读者保护门禁。

进程退出由 systemd 自动重启，开机由 `multi-user.target` 启动。网关设有内存上限；不要同时安装桌面环境或无界限提高执行器并发。服务自动启动不能保证上游账号永不过期或供应商永不故障，账号失效仍需在网关侧重新授权。

## 凭据与备份

- 渠道凭据在服务器网关侧维护；上游轮换或失效后，通过网关自己的授权流程在服务器上重新登录，不从工作站目录回拷整份资料。
- 备份含凭据，必须保持私有；不能打包进公开仓库或通用网站备份。

## 回退

切换前的 `.env` 和迁移核验材料保存在服务器私有目录（见 2026-10-25 迁移记录）。需要回退时先确认旧地址与对应隧道确实可用，再恢复原地址、移除本次覆盖文件，正常收尾后重启相应进程；不得仅恢复旧地址而忘记重新启用对应隧道。
