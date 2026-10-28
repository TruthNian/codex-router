# 故障排查

[English](../TROUBLESHOOTING.md) · 简体中文 · [日本語](../ja/TROUBLESHOOTING.md)

先从已安装源码目录运行诊断与状态检查。Windows 使用 `.\model-router.ps1 codex doctor` 和 `.\model-router.ps1 codex status`。

```sh
./bin/model-router codex doctor
./bin/model-router codex status
```

## 新的原生模型没有出现

确认当前 ChatGPT 账户能使用该型号、Codex 已更新且登录有效。Router 的原生捕获取自实际账户目录。后台会周期检查差异；手动刷新后完全退出并重新打开 Codex，新建任务再查看。

若仍然缺失，比较原生目录与合并目录，并查看诊断报告的捕获或 schema 错误。

```sh
./bin/refresh-catalog
```

<a id="external-models-are-missing-from-the-picker"></a>

## 外部模型没有出现在菜单

检查供应商已启用、认证为 ready、目标模型在显示列表中。仅提供实时目录的供应商需要先选择模型。兼容层关闭时，依赖网关的模型会退出有效目录；按需要恢复兼容层后准备依赖并重新发布。

下面以 DeepSeek 和 Groq 为例：

```sh
./bin/model-router codex providers
./bin/model-router codex providers enable deepseek
./bin/model-router codex provider-key deepseek set
./bin/curate-models groq
```

## 状态目录属于另一份源码

安装清单记录拥有该状态的源码目录。切换到报告的所属目录再进行更新或修复；自定义状态使用 `MODEL_ROUTER_STATE_DIR` / `CODEX_ROUTER_STATE_DIR`。先确认自己的服务实际使用哪份配置。

## 供应商认证失败

Kimi OAuth 先在官方 CLI 检查登录及区域；Grok OAuth 在官方 Grok CLI 登录。Windows 如果拦截程序，检查该文件来源和系统策略的具体拒绝记录。

API 密钥通过 `provider-key PROVIDER set` 重新输入。环境变量或 Keychain 仍保留同一密钥时，移除 Router 文件后也可能仍被检测为可用；诊断会标注来源。API 计划权限和密钥有效性分别检查。

Windows 报进程隔离能力不可用时，检查 PowerShell `FullLanguage`、`Add-Type`、AppLocker/WDAC 策略，按组织的策略配置环境。

## 模型 ID 或能力变化

刷新供应商目录，选择当前 ID，核对本机覆层中的上下文、图片、推理和协议字段。保留旧模型的手动设置；需要改名时使用明确的迁移条目。验证模型会使用供应商额度。

## 上下文与压缩

会话超过窗口时，先核对实际模型 ID、上下文窗口与压缩阈值，以及供应商报告的输入 token。若每轮都压缩，检查已压缩 checkpoint 是否正常回放、模型限制是否误设、输入是否每次被重复加入。

工具输出老化和原文回读见 [Codex 指南](CODEX.md)。字节节省量、缓存命中和实际账单一起评估。

## 子代理缺失或一直显示 Working

检查该模型是否有已验证的 v2 能力，是否在 picker 和 subagent 列表中启用。刷新会同时修复受管理的代理定义。已完成的子代理应按当前 Codex v2 接口调用 `interrupt_agent`；状态标签和 FINAL_ANSWER 是不同事件。

## 代理提前结束

检查客户端最后一条消息、工具调用和 Router 的对应请求状态。外部模型只返回最终文本后，客户端会结束该轮；确认配套 skills 已注入并且模型实际调用了工具。

## 原生 GPT 失败或 502 连接超时

先检查 ChatGPT 登录、选中的模型和 `native-redirect` / 登录模式。如果错误明确显示连接 `chatgpt.com` 超时，检查出站代理配置和网络日志。`NODE_USE_ENV_PROXY=1` 与 HTTP/HTTPS 代理变量需进入后台服务定义；回环地址需在 `no_proxy` 中。

终端正常、GUI 失败且 Router 未收到请求时，检查 GUI 的系统代理和回环例外。步骤见[安装指南](INSTALL.md)。

## 端口冲突或服务未运行

诊断会指出冲突端口、已注册服务和真实进程。确认占用者后，调整自己管理的配置或停止已确认的旧服务。然后启动 Router：

```sh
./bin/model-router codex start
./bin/model-router codex status
```

## 更新失败

更新日志会同时报告安装和恢复结果。需要手动回退时使用已缓存的旧源码版本。旧安装迁移的回退使用单独的 `migrate rollback`。

```sh
./bin/model-router codex rollback
./bin/migrate rollback
```

## Responses WebSocket 或语音连接

`401` 常见于旧的本地调用 URL，修复受管理配置后重启客户端。`426` 带支持协议提示时，客户端可按协议回退 HTTP。WebSocket edge 使用同一认证 HTTP 路由，供应商错误可在 Responses 事件中查看。

语音的 `/v1/live` 使用原生实时端点。更新后可重新启用接入并重启 Codex，使受管理的 realtime 设置生效。

```sh
./bin/model-router codex enable
```

## 归档占用磁盘

诊断会报告原文数量、大小、最老条目和 TTL。默认保留七天；读操作拒绝过期证据，写入或手动到期清理时回收文件。清理前可以预览：

```sh
./bin/control tool-result-aging purge
./bin/control tool-result-aging purge --expired
./bin/control tool-result-aging purge --expired --yes
```

删除后的原文无法通过旧句柄恢复；现有对话可能需要将对应历史标记为证据缺失。策略见[归档读回](tool-result-readback-proof.md)。

## 支持包与卸载保留数据

生成支持包：

```sh
./bin/support-bundle
```

支持包包含版本、诊断、服务状态、配置归属和文件元数据，并在本地生成。分享前查看内容并按需要提交。卸载保留凭据、日志、目录缓存和恢复数据；需要清除时先确认状态目录及所需数据。
