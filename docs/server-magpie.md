# 服务器独立模型网关

GEOHOT 的网站、数据库、队列、内容执行器和模型网关都部署在服务器。工作站关机不再是模型渠道的必需条件。服务器使用 Magpie Linux CLI，监听 `127.0.0.1:3426`，不向公网开放管理界面或模型端口。

## 安装与身份边界

- Magpie 来源为 [yetone/magpie 官方发布](https://github.com/yetone/magpie/releases)，部署版本 `0.1.1489`。Linux amd64 CLI SHA-256：`860be361a1da152d00b07534b2b809d21c47e15baaf59f22e4a427e917eaf6b8`，与官方 `SHA256SUMS` 一致。
- 运行账户为专用系统用户 `geohot-magpie`，HOME 为 `/var/lib/geohot-magpie`。凭据只保存在其私有 `.config/magpie/`，不提交到 Git、不放到网站目录。
- 只迁移网站使用的 `workbuddy-ai`、`qoder-cn`、`codearts`、`minimax-code` 及其既有账号。国际 WorkBuddy AI 与国内 WorkBuddy 是不同渠道；原有服务器 3065/3066 桥不受本次迁移影响。
- 插件版本固定为 WorkBuddy `0.1.31`、Qoder `0.2.33`、CodeArts `0.2.1`、MiniMax `0.1.5`。保留刷新凭据、设备身份和账号顺序；不复制本机其他应用的整个用户目录、浏览器资料或历史会话。
- 服务单元模板为 `deploy/geohot/systemd/geohot-magpie.service`；运行目录设为 0700，凭据文件为 0600。网关的无窗口运行和 token 刷新由上游程序及插件提供，不需要 Windows 桌面常驻。

## 网站配置

以下三项保留原有 `/v1` 后缀，改为服务器端口，并通过 `/etc/geohot/magpie-server.env` 覆盖 API、协调器和内容执行器的进程环境：

```dotenv
QODER_CN_BASE_URL=http://127.0.0.1:3426/v1
CODEARTS_BASE_URL=http://127.0.0.1:3426/v1
MINIMAX_CODE_BASE_URL=http://127.0.0.1:3426/v1
```

`.env` 中的对应地址同步更新。模型名称、预算、权重、并发和回执机制保持既有配置。不要把网关地址改成工作站 IP，不要恢复 3425 反向隧道作为日常依赖。

## 维护与验证

```sh
systemctl is-enabled geohot-magpie
systemctl status geohot-magpie --no-pager
systemctl show geohot-magpie -p NRestarts -p MemoryCurrent
curl --fail http://127.0.0.1:3426/v1/models
```

模型目录只证明账号被识别。真实调用要经过 GEOHOT 的 `paidRequest`、预算和回执；用现有工作流的新回执与入库结果验证，不直接用裸请求绕过账本。验证期间不清理 unknown 回执、不提高并发、不绕过读者保护门禁。

进程退出由 systemd 自动重启，开机由 `multi-user.target` 启动。服务器最初只有约 891 MB 内存，网关设有资源上限；不要同时安装桌面环境或无界限提高执行器并发。服务自动启动不能保证上游账号永不过期或供应商永不故障，账号失效仍需重新授权。

## 回退

切换前的 `.env` 和迁移核验材料保存在服务器私有 `/var/lib/geohot-magpie-migration-20261025/`。需要回退时先确认本机和旧隧道确实可用，再恢复原地址和移除本次 `90-magpie-server.conf` 覆盖文件，正常收尾后重启相应进程。不得仅恢复旧地址而忘记重新启用对应隧道。

备份含凭据，必须保持私有；不能打包进公开仓库或通用网站备份。
