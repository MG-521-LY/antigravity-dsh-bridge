# Antigravity DSH Bridge

在 Windows 上把 CLIProxyAPI 的 Antigravity 接口接入 DeepSeek Harness，并在调用 API 时自动启动转换服务。无需一直打开命令行窗口。

本项目是本机启动与转发工具，依赖独立的 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)。不提供模型、账号、授权凭据或额外额度，也不属于 Google 或 DeepSeek 的官方产品。

## 工作方式

```text
DSH → 本机入口 127.0.0.1:8317 → 按需启动 CLIProxyAPI 127.0.0.1:8318 → Google
```

- 隐藏守护进程随 Windows 登录运行；入口异常退出后自动重启，首次 API 请求再启动转换服务。
- 等待接口和模型目录就绪后转发请求，避免首次调用拿到空模型列表。
- 多个同时到达的请求共享一次启动；转换服务退出后，下次请求会重新启动。
- 保留 OpenAI Chat Completions 的流式回复和工具调用格式。
- 仅监听本机；密钥校验由 CLIProxyAPI 执行，积分回退默认关闭。
- 内置中文网页用量面板，可分别查看全部 DSH 模型历史与反重力接口请求统计。

首次调用可能需要多等几秒。转换服务启动后保持后台运行；关闭 DSH 不会自动停止它。电脑休眠或关机期间不能处理请求。入口异常退出后会在约 1–30 秒内重启，反复失败时延长等待；隐藏启动器也会在守护进程异常退出后恢复它。恢复不会重放已发送的生成请求，断开的会话由 DSH 重试。

后台连续三次健康检查失败、且没有正在转发的请求时，会重启自己启动的后台；不会因 Google 请求慢或单次网络错误终止后台。统计扫描使用独立进程和 128 MB V8 堆上限，扫描完成即退出释放缓存；崩溃后保留上次结果并延迟重试。可用物理内存不足 1 GB 或可用虚拟内存不足 1.5 GB 时暂停扫描，显示内存不足提示；内存检查不可用时也暂停扫描。面板超过 60 秒无人访问后停止定时扫描。系统整体内存耗尽时仍可能断线，自动恢复不能替代释放系统内存。

## 安装

需要 Windows 10/11、PowerShell、支持 Zstandard 的 Node.js（22.15+ 或 24 LTS），以及具备 Antigravity 使用权限的 Google 账号。网络必须能访问 GitHub 和相关 Google 服务。

1. 下载或克隆此仓库，放到长期保留的目录。
2. 在该目录打开 PowerShell，运行：

   ```powershell
   .\setup.ps1
   ```

   安装脚本从 CLIProxyAPI 的 GitHub Release 下载固定版本 `8.0.29`，比对发布方的 SHA-256 校验值，生成随机本地 API 密钥，并注册当前用户的登录启动项，无需管理员权限。已有 `config.yaml` 会保留。

   如 Node.js 没有加入 PATH：

   ```powershell
   .\setup.ps1 -NodePath 'D:\Apps\nodejs\node.exe'
   ```

   如需为新配置指定 HTTP 代理：

   ```powershell
   .\setup.ps1 -ProxyUrl 'http://127.0.0.1:7890'
   ```

   `-ProxyUrl` 仅用于首次创建配置。已有配置请编辑 `config.yaml` 中的 `requests.proxy-url`。该端口需要是代理软件实际提供的 HTTP 或混合代理端口。

3. 双击 `01-login.cmd`，在浏览器完成 Google 账号授权。已登录 Antigravity 桌面软件不等于已授权 CLIProxyAPI。
4. 在 DSH 中添加自定义模型 API，按下表填写。

| 字段 | 值 |
| --- | --- |
| Provider ID | `antigravity-local`，也可自行指定不重复的小写标识 |
| 显示名称 | 任意名称 |
| API 地址 | `http://127.0.0.1:8317/v1` |
| API 协议 | OpenAI Chat Completions |
| API 密钥 | 本机 `config.yaml` 的 `access.api-keys` 中的值 |
| 模型 | 点击“获取可用模型”，选择实际返回的模型 ID |

保存后新建会话验证问答和工具调用。不要把客户端中的模型显示名称直接当作 API 模型 ID。

安装选项：`-NoAutostart` 不注册登录启动项；`-NoStart` 不立即启动入口；`-SkipDownload` 使用已有 `bin/cli-proxy-api.exe`。不要同时运行多套使用相同端口的安装。

## 网页用量面板

启动本机入口后，打开 **[http://127.0.0.1:8317/dashboard/](http://127.0.0.1:8317/dashboard/)**。

面板提供今天、7 天、30 天和全部历史筛选，以及两套独立的统计视图：

- **DSH 全部模型**：只读分析 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`），覆盖不同提供商。显示 Token、模型步骤、缓存命中率、完整步骤耗时、趋势、模型分布与近期记录。分支继承的历史不重复累计，同一步骤的最终 usage 与流式 usage 只计一次。
- **反重力接口**：从监控功能启用后记录经过此入口的请求次数、状态、总耗时和提供商已上报的 Token。统计保存在本机 `bridge-usage.json`，最多保留最近 10,000 条请求。

同一次反重力请求可能同时出现在 DSH 与接口视图中，应分别查看。未上报 Token 的调用仍计入次数，显示为“未上报”，不会当作零消耗估算。DSH 的“平均耗时”来自完整步骤边界，可能包含工具执行；接口耗时包含冷启动等待。

DSH 历史由独立子进程扫描，每 30 秒检查文件变化，网页每 5 秒刷新。面板读取最高版本的 v2-v4 JSONL/Zstandard 日志，不进行格式迁移或修复。未支持的格式、不完整文件、读取错误和缺失继承边界会明确提示，统计可能因此不完整。打开面板本身不会启动转换服务或调用模型。

**官方剩余额度、套餐余额和实际账单未接入。** 本机 Token 消耗与官方额度是不同信息，不会显示虚构的剩余百分比或费用。统计页可导出当前视图；不读取 `~/.dsh/.credentials.yaml`，不保存提示词、回复正文或 API 密钥。页面仅允许本机同源读取，无外部图表或字体依赖。

`AG_DSH_TIMEZONE` 可配置统计时区，默认 `Asia/Shanghai`。面板的日期筛选按该时区的自然日计算。

已有旧版安装时，在更新后的源码目录执行：

```powershell
.\update-installed.ps1 -InstallDir 'D:\Apps\antigravity-dsh-bridge'
```

脚本会备份代码、核对监听进程的身份、确认没有模型请求后更新，并保留原来的 `config.yaml` 与 `auth/`。它会重新启动本机入口并更新登录启动项。可先加 `-WhatIf` 查看计划，不执行更新。不要在模型请求处理中升级。

## 日常使用与排查

- 正常使用时直接在 DSH 调用，不需要保持 CMD 或 Antigravity 桌面程序打开。
- 健康检查：`http://127.0.0.1:8317/__bridge/health`。此检查不会启动转换服务。
- DSH 到本机的连接应直连 `127.0.0.1`。本机服务到 Google 的网络则按实际环境配置代理；仅开启 Windows 系统代理不保证覆盖所有程序。
- 不要把 DSH 改到内部端口 `8318`，否则会绕过自动启动入口。
- 修改 `config.yaml` 或更新入口代码后，重新登录 Windows 加载新配置。`config.backend.yaml` 是生成文件，不要直接修改。
- 运行状态在 `bridge-state.json`；入口日志在 `bridge.log`；恢复及退出诊断在 `lifecycle.log`；上游日志在 `logs/`。这些文件均不纳入 Git。
- Google 账号原有额度和速率限制仍然适用，具体模型可用性取决于上游。

登录启动项是 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `AntigravityDshBridge`。可在 Windows“启动应用”中关闭；如需删除该项，可在 PowerShell 执行：

```powershell
Remove-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AntigravityDshBridge'
```

关闭或删除启动项不会立即停止正在运行的进程；退出 Windows 后它们会结束。

## 验证

不需要 Google 账号的语法检查：

```powershell
node --check .\lazy-api.cjs
node --check .\verify-lazy-api.cjs
node --check .\web\app.js
node --test --test-concurrency=1 .\tests\dashboard.test.cjs .\tests\lifecycle.test.cjs
```

安装并授权后，可在独立本机端口 `8327/8328` 执行真实集成验证：

```powershell
node .\verify-lazy-api.cjs --isolated
```

验证覆盖冷启动、并发请求、鉴权、问答、SSE 流式回复、工具调用、面板实际记账和后端退出后的恢复。测试会真实调用模型，消耗少量账号额度；结束时关闭自己创建的测试进程，不停止日常使用的接口。模型默认 `gemini-3-flash`，也可通过 `AG_DSH_TEST_MODEL` 指定实际可用的模型。

可通过 `AG_DSH_CONFIG`、`AG_DSH_BACKEND` 环境变量让测试使用本机其他目录的配置和上游程序，无需复制凭据。`AG_DSH_TEST_REPORT` 可指定本地验证报告路径。报告默认生成 `verification.json`，不会提交到仓库。

## 文件与凭据

公开仓库只包含源代码、安装脚本、示例配置和说明。`config.yaml`、`auth/`、`bridge-usage.json`、下载的程序、日志、机器路径和测试产物均已在 `.gitignore` 中排除。提交前仍应检查 Git 暂存区，不要使用强制添加命令提交这些文件。

## 相关项目

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)：负责上游账号授权与协议转换；其授权文件和软件许可证由上游项目管理。
- [DeepSeek Harness 模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。

## License

本仓库代码使用 MIT License。CLIProxyAPI 按其自身许可证分发，本仓库不包含其程序或源代码。
