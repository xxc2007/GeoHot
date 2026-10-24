# GEOHOT 本机恢复检查器

此目录是独立的周期检查入口，不修改旧 supervisor、owner lock 或旧任务定义。
`watch.ps1` 每次检查后退出；常驻来自计划任务每两分钟调度。当前尚未注册、执行或启动任何服务。

动作边界：

- 新目录的 `disabled.flag` 或旧目录的 `operator.stop` 存在时全局停止动作。
- 只有没有 Magpie 进程且端口3425未被任何监听占用，才隐藏启动现有 `D:\magpie-windows-amd64.exe`。不杀进程，不修改其配置。
- 旧任务 Running 不触碰。Ready 仅在 owner lock 不存在、同路径 Magpie 正在监听127.0.0.1:3425，且旧记录明确为正常 deadline、LastTaskResult=0时重启。
- “首次恢复”严格限定旧记录不存在且任务结果为267011（任务从未运行）。缺失记录与任意失败结果不构成首次许可。
- authentication、host_key、forward_bind、unclassified、operator_stop、异常结果和不完整记录均停在人工核验。
- 每个正常 deadline 只尝试一次；在调用旧任务前先持久化 token，启动失败也不循环重试。
- 重启电脑遗留的旧 owner lock 永不自动删除、覆盖或解释为失效。检查器仅记录 `owner_lock_requires_operator_review`；需管理员核验原进程和远端监听后自行处理。
- 使用 Local 命名 mutex 及计划任务 IgnoreNew；默认仅当前用户交互登录会话。没有HTTP请求、模型调用、权限或网络设置修改。
- watch-state.json 仅保存时间、固定原因码及动作标记，不保存异常原文、命令行、密钥、环境变量或服务响应。

离线回归命令（尚未执行，根任务统一运行）：

```powershell
node --test D:\geohot-runtime\gateway-watch-20261024\decision.test.mjs
$parseErrors = $null
$tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile('D:\geohot-runtime\gateway-watch-20261024\watch.ps1', [ref]$tokens, [ref]$parseErrors) | Out-Null
$parseErrors
```

以下是根任务可审阅并执行的注册示例。它只增加新检查任务，运行身份为当前用户 Interactive、非提权；应先决定当前机器上的 node.exe 绝对路径并检查现有同名任务，避免覆盖。

```powershell
$watchRoot = 'D:\geohot-runtime\gateway-watch-20261024'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}\watch.ps1" -NodePath "{1}"' -f $watchRoot, $nodeExe) -WorkingDirectory $watchRoot
$logon = New-ScheduledTaskTrigger -AtLogOn -User $identity
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'GEOHOT-Gateway-Watch-20261024' -Action $action -Trigger @($logon, $periodic) -Principal $principal -Settings $settings
```

该注册只适用于用户保持登录时的恢复；用户注销后不保证网关存活。机器启动后若旧锁仍存在，此检查器按上述规则停止旧任务恢复。TCP监听证据只说明本机端口有监听，不代表模型、反向SSH或远端服务健康。
