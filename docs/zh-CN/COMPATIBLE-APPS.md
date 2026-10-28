# 兼容客户端

[English](../COMPATIBLE-APPS.md) · 简体中文 · [日本語](../ja/COMPATIBLE-APPS.md)

所有接入共享一个 Router 服务、一套供应商选择与凭据。`TARGET` 指定要写入的客户端配置。以下命令面向 macOS/Linux；Windows 使用 `.\model-router.ps1 TARGET COMMAND`，控制命令使用 `node src/control.mjs`。

## DeepSeek Harness

`dsh` 把路由写入 `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.codex-router`，调用凭据引用写入 `.credentials.yaml`。Harness 监听设置文件并热加载。已有 Router 上执行：

```sh
./bin/model-router dsh enable
./bin/model-router dsh doctor
./bin/model-router dsh subagent-preset
./bin/model-router dsh disable
```

子代理默认继承模型；需要不同模型时，将 `subagent-preset` 输出加入自己管理的 preset。原生 GPT 的共享访问需先登录 Codex，并显式授权共享平面：

```sh
codex login
./bin/model-router codex chatgpt-session enable
./bin/model-router codex chatgpt-session disable
```

这项授权供同一系统用户的 Harness、Gemini、OpenClaw 等接入使用；访问仍需有效 Codex 会话。撤销授权保留 Codex 自身登录。

## Gemini CLI

`gemini` 在 `~/.gemini/.env` 写入受管理的端点、调用密钥和默认模型。下次启动 Gemini CLI 时读取；认证方式选择 **Use Gemini API key**。

```sh
./bin/model-router gemini enable
./bin/model-router gemini doctor
gemini --model deepseek/deepseek-v4-flash
./bin/model-router gemini disable
```

`--model` 覆盖本次模型。`settings.json` 和环境文件中的其他设置保留。Gemini 的 `:countTokens` 使用字节估算；`:embedContent` 返回明确的未实现错误，OpenAI embeddings 路由见[供应商指南](PROVIDERS.md)。

## Cursor Agent 与 Cursor App

Cursor Agent 使用 `cursor-router-agent` 本地启动器。Cursor App BYOK 通过其后端发请求，使用专用 `127.0.0.1:4214` 入口和稳定的公开 HTTPS 隧道。

控制中心 **Harness → Connect Cursor** 可安装固定连接器并引导 Cloudflare 授权、选择域名、创建专用主机名、等待 Cursor 退出、发布模型并重新打开。已有主机名可通过 CLI 配置：

```sh
./bin/model-router cursor enable --hostname cursor-router.example.com
./bin/model-router cursor doctor
cursor-router-agent --list-models
cursor-router-agent --model 'PASTE_ID_FROM_THE_LIST' --print "Reply with OK"
./bin/model-router cursor disable
```

从列表复制包含推理档位后缀的完整 ID。修改 Cursor App 设置前完全退出 Cursor。使用 Cursor 自身的模型时，将 BYOK base URL override 切回原配置。Agent 的本地读写与终端操作遵循 Cursor 权限；MCP 工具支持以当前连接器实现为准。

## Claude Code

`claude` 创建 `claude-router` 启动器，该进程连接本地 Messages 适配器；普通 `claude` 的原设置保留。

```sh
./bin/model-router claude enable
claude-router
./bin/model-router claude doctor
./bin/model-router claude disable
```

启动后通过 `/model` 选择 `codex_router/anthropic/<provider>/<model>`。路由使用所选供应商凭据。Claude.ai 登录通过下面的订阅代理桥接功能使用。

## OpenClaw

控制中心的 Set up 可安装缺少的官方 CLI，随后向 `models.providers.codex-router` 发布模型。已有 agent、渠道、插件和其他供应商设置保留。

```sh
./bin/model-router openclaw enable
./bin/model-router openclaw doctor
./bin/model-router openclaw status
./bin/model-router openclaw disable
```

模型引用使用 `codex-router/<router-slug>` 和 `openai-responses`。若首次没有默认模型，会选择 Router 的优先路由；后续保留用户选择。

## 发布到现有配置的客户端

| 客户端 | 受管理的配置文件 | 协议 |
| --- | --- | --- |
| opencode | `~/.config/opencode/opencode.json` | Responses |
| pi | `~/.pi/agent/models.json` | Responses |
| omp | `~/.omp/agent/models.yml` | Responses |
| Command Code | `~/.commandcode/providers.json` | Messages |
| Hermes Agent | `~/.hermes/config.yaml` | Messages |

控制中心 Harness 页的 Set up 与下列命令对应。omp 和 Hermes 先安装各自官方 CLI。

```sh
./bin/control client-setup opencode
./bin/control client-setup pi
./bin/control client-setup omp
./bin/control client-setup commandcode
./bin/control client-setup hermes
./bin/control client-update opencode
./bin/control client-update --all
./bin/control client-disconnect opencode
```

更新通过客户端自己的 updater 执行。Router 管理自己的供应商块，保留其他配置和 YAML 注释。`OPENCODE_CONFIG`、`PI_CODING_AGENT_DIR` 等覆盖值用于定位实际配置。

## 订阅代理桥接（实验性）

Harness 页还可连接 Claude Code、Cursor Agent、Gemini CLI 的官方代理进程和已有会话。Claude 使用官方进程，Cursor 使用 `agent acp`，Gemini 使用 `gemini --acp`。配额与账户权限由各自客户端控制；桥接的权限请求遵循当前前台支持范围。

查看状态及非推理探测：

```sh
./bin/model-router codex agents status
./bin/model-router codex agents probe anthropic
./bin/model-router codex agents probe cursor
./bin/model-router codex agents probe gemini
```

`agents prompt` 会使用该客户端的实际额度；提示从 stdin 输入。桥接索引保存有界的会话 ID、工作区和时间信息，提示及 transcript 留在各自客户端。

## T3 Code

[T3 Code](https://t3.codes/) 驱动相应官方 CLI。先为它使用的 CLI 安装 Router，然后完全退出并重新打开 T3 Code，再选择新增模型。
