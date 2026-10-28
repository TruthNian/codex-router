# 供应商、认证与模型选择

[English](../PROVIDERS.md) · 简体中文 · [日本語](../ja/PROVIDERS.md)

供应商和内置模型由[注册表](../../config/)定义，本机添加的模型保存在受保护的 `user-models.json`。每条路由使用各自的凭据、账单、上下文和能力设置。

以下命令从已安装源码目录执行。Windows 将 `./bin/model-router codex` 替换为 `.\model-router.ps1 codex`，`./bin/curate-models` 替换为 `.\codex-router.ps1 curate-models`，`./bin/control` 替换为 `node src/control.mjs`。

## 连接供应商

在本机隐藏提示中输入密钥，启用供应商，再查看就绪状态。

```sh
./bin/model-router codex provider-key deepseek set
./bin/model-router codex providers enable deepseek
./bin/model-router codex providers
```

## 平台与认证差异

| 供应商 | 选择与认证 |
| --- | --- |
| Kimi | `kimi-oauth` 复用 Kimi Code CLI 会话；`kimi-api` 与 `kimi-api-cn` 分别使用国际/中国平台密钥 |
| StepFun | `stepfun-api` 与 `stepfun-api-cn` 分别使用 `api.stepfun.ai` 与 `api.stepfun.com`，各自配置密钥 |
| Qwen | `qwen-plan` 使用 Model Studio 计划密钥，`QWEN_PLAN_BASE_URL` 选择对应端点 |
| Z.ai | `zai-coding` 使用 Coding Plan，`zai-api` 使用平台 API；后者环境变量为 `ZAI_PLATFORM_API_KEY` |
| ClinePass | `clinepass` 使用 Cline API 密钥；订阅模型还需要相应 ClinePass 权限 |
| GitHub Copilot | `github-copilot` 使用带 **Copilot Requests** 权限的细粒度 PAT，随后从账户目录选择模型 |
| Meta | `meta` 使用 Meta Model API 密钥和 Responses 端点 |
| Command Code | `commandcode` 及其 Messages 变体共用密钥，API 权限取决于账户计划 |
| opencode Go / Zen | 同一密钥连接 Go 订阅和按量计费 Zen，模型协议由相应变体处理 |

Kimi 平台的账户、账单和密钥分别管理。Kimi Code CLI 的国际账户使用 `kimi login --region global`，中国账户使用 `kimi login`；Router 读取 CLI 保存的地区。

Grok OAuth 复用官方 CLI 的会话。`grok-api` 则使用独立 xAI API 密钥。

```sh
npm install -g @xai-official/grok
grok login --oauth
./bin/model-router codex providers enable grok-oauth
```

## 模型目录与手动添加

Groq、Together、Fireworks、Cerebras、Mistral、NVIDIA NIM、SiliconFlow、Hugging Face、Gemini API、Copilot、Chutes、OrcaRouter 等提供目录选择。连接后运行：

```sh
./bin/curate-models groq
./bin/curate-models groq --models MODEL_ID --efforts low,high
./bin/curate-models groq --remove MODEL_ID
```

交互式选择会保存上下文窗口、图片支持、推理档位和请求配置。使用供应商公开的窗口值作为起点，按实际路由验证。`--models` 以追加方式保存既有元数据，`--remove` 显式删除。

只接受自动工具选择的模型，可使用 `--request-profile auto-tool-choice`。已有模型在本机覆层中调整对应字段，保留其余手动配置。

OrcaRouter 的免费部署仍需要账户密钥；可以使用 `./bin/curate-models orca --free-only --apply`。OpenRouter、NanoGPT、Venice 和 Nous Research 也支持本机目录选择，使用各自账户的 API 权限。

模型验证会发送实际请求并使用额度：

```sh
./bin/test-model 'groq/MODEL_ID' --live --yes
```

## opencode Go 与 Zen

设置一次 `opencode-go` 密钥并启用该家族。Chat、Messages 和 Responses 变体按协议分发，Zen 的模型通过 `./bin/curate-models opencode-zen` 选择。Go 与 Zen 的额度和账单分别遵循其服务。

可选 API 密钥池引用允许的环境变量。添加新的环境来源后，从同一终端重新运行安装器更新服务定义。池支持暂停、恢复和轮换，状态可查看：

```sh
./bin/model-router codex provider-key opencode-go set
./bin/model-router codex providers enable opencode-go
./bin/model-router codex key-pool opencode-go status
```

## 匿名服务与自定义端点

`opencode-free` 和 `kilo-free` 需要明确启用并选择当前目录里的免费型号。匿名服务共享出口 IP 的限制，供应商可调整免费规则。

```sh
./bin/model-router codex providers enable opencode-free
./bin/curate-models opencode-free
./bin/model-router codex providers enable kilo-free
./bin/curate-models kilo-free
```

控制中心 **Models → Custom → Add endpoint** 可保存名称、协议、地址和密钥，再读取该端点的模型目录。**By name** 用于添加目录未列出的私有或预览型号。各端点有自己的编辑、添加和移除操作。

CLI 示例：

```sh
./bin/model-router codex providers generic add my-endpoint \
  --name "My Endpoint" --base-url https://api.example.com/v1 --adapter openai-chat
./bin/model-router codex providers generic credential my-endpoint set
./bin/curate-models my-endpoint
./bin/model-router codex providers generic add-model my-endpoint private-preview-1
```

凭据通过隐藏提示保存。添加端点会验证地址和目录访问；模型推理、图片及工具能力通过实际测试确认。发送到自定义端点的内容由该端点运营方处理。

## 搜索

Grok OAuth 使用供应商托管搜索。已验证的模型路由通过 `searchTool` 声明 Codex standalone 搜索。其他路由可显式绑定 Perplexity Search 侧车；绑定要求独立密钥及可信的公共 HTTPS 端点。

配置侧车：

```sh
./bin/model-router codex providers generic add perplexity-search \
  --name "Perplexity Search" --base-url https://api.perplexity.ai --adapter openai-chat
./bin/model-router codex providers generic credential perplexity-search set
./bin/model-router codex search-sidecar set PROVIDER/MODEL perplexity-search
./bin/model-router codex search-sidecar status PROVIDER/MODEL
```

侧车使用 Perplexity `/search` 的受支持查询子集，按模型绑定和认证范围隔离缓存。更改绑定后重启 Codex 以加载菜单能力。

## Antigravity OAuth

需要自己拥有的 Google OAuth **Desktop app** 客户端，以及已获准使用 `cloudcode-pa.googleapis.com` 的项目。配对的客户端 ID 和 secret 在命令打开的本地页面输入。先登录，再显式探测，然后启用：

```sh
./bin/model-router codex providers login antigravity-oauth
./bin/model-router codex providers probe antigravity-oauth --live --yes
./bin/model-router codex providers enable antigravity-oauth
```

探测会使用实际额度，成功后记录待激活代次，安装服务重启并完成健康检查后才生效。`SERVICE_DISABLED` 表示该项目尚未获得私有 API 权限。创建项目需要额外显式选择 `--provision-project`。

## Vertex、Devin 与模型别名

Vertex 使用 `gcloud auth application-default login` 的 ADC，再运行 `./bin/control vertex set PROJECT_ID LOCATION` 和 `./bin/curate-models vertex`。`--static --models MODEL_ID` 从已审查支持列表选择，仍需实际项目和模型访问权限。

Devin CLI 在 `devin auth login` 后读取该账户可见配置，实际能力以兼容性结果为准。历史 Ox Alpha 名称及迁移别名用于兼容旧选择；当前型号和协议以注册表、目录及测试结果为准。

验证步骤见 [Devin CLI 探测](DEVIN-CLI-PROBE.md)。

## Embeddings 与 Decisions

`/v1/embeddings` 由明确声明 `supportedEndpoints` 的模型提供；专用 embedding 模型设为 `listed: false`。OpenRouter Decisions 使用隐藏的 `openrouter-decisions/jev-latest` 路由和 `/v1/decisions`，用于显式配置的结构化工具客户端。

这两类接口按自己的请求契约使用。模型菜单中的聊天模型选择仍用于普通对话。

## 默认模型与开发

可为新 Codex 任务设置 Router 默认模型。设置后完全退出并重新打开 Codex：

```sh
./bin/control router-default set deepseek/deepseek-v4-flash
./bin/control router-default clear
```

增加正式支持的供应商或模型时，遵循[开发指南](DEVELOPMENT.md)，验证凭据隔离、工具调用、流式输出和上下文行为后再发布。
