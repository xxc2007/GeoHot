# Security policy / 安全政策

## Supported versions / 支持范围

Security fixes target the current `main` branch. Older snapshots and modified deployments should update to the current code before reporting an issue, when practical.

安全修复面向当前 `main` 分支。旧版本快照和自行修改的部署，在条件允许时请先更新到当前代码，再确认问题是否仍然存在。

## Reporting a vulnerability / 报告安全漏洞

Please report suspected vulnerabilities privately through the [GEOHOT feedback form](https://xxc2007.me/geohot/feedback). Reports are reviewed through the site's administration interface, rather than published as public issues. Include the affected URL or component, commit or version, reproduction steps, expected impact, and a minimal example with sensitive information removed. An optional contact address helps with follow-up.

发现疑似漏洞，请通过 [GEOHOT 反馈页](https://xxc2007.me/geohot/feedback) 私下报告。反馈由站点后台处理，不会作为公开 Issue 展示。请提供受影响的网址或组件、提交或版本、复现步骤、预期影响，以及已脱敏的最小示例；可选填联系方式，方便后续沟通。

Do not post exploitable details, credentials, session cookies, provider keys, database contents, or visitor information in public issues or pull requests. Do not include live secrets in the feedback form. Avoid testing that modifies production data, disrupts service, or incurs external-provider charges. Coordinate disclosure with the maintainer while a report is investigated and addressed.

请勿在公开 Issue 或 PR 中发布可直接利用的细节、凭据、会话 Cookie、服务商密钥、数据库内容或访客信息，也不要在反馈中提交有效密钥。验证时请避免修改生产数据、干扰服务或触发外部服务计费；问题调查和修复期间，请与维护者协调披露。

## Development and deployment / 开发与部署

Keep credentials in ignored local configuration or narrowly scoped deployment secrets. Keep collection, model calls and other external-access switches off during development and tests. Model-provider requests must retain receipt and budget controls. Review dependency and deployment changes before publishing them.

凭据应保存在已忽略的本地配置或权限受限的部署密钥中。开发和测试时保持采集、模型调用等外部访问开关关闭；模型请求须经过回执与预算控制。依赖更新和部署变更应在发布前经过审查。
