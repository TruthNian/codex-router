# 本地模型：Ollama 与 LM Studio

[English](../LOCAL-MODELS.md) · 简体中文 · [日本語](../ja/LOCAL-MODELS.md)

模型文件由本地运行时管理，Router 保存下载操作、选择和发布状态。控制中心 **Local LLMs** 提供目录、内存适配、下载进度、取消和移除。

## Ollama

先查看适配、再安装模型。`--yes` 同意在缺少时安装并启动 Ollama；`--force` 同意下载超出推荐适配范围的模型。

```sh
./bin/control local-models list --json
./bin/control local-models inspect gemma4:12b
./bin/control local-models install gemma4:12b --yes
./bin/control local-models cancel gemma4:12b
./bin/control local-models benchmark gemma4:12b
```

可以填写任意支持的 Ollama tag 或模型页面 URL。后台工作进程报告阶段和进度，重复操作复用已有任务。取消会停止对应操作并保留最后完成的状态。

选中模型会刷新目录和网关路由，并按需要重启 Router 服务。前台运行的开发 Router 由操作者重启。取消选择保留已下载权重；移除模型会删除运行时保存的权重。

## 运行时管理

```sh
./bin/control local-models runtime status
./bin/control local-models runtime start
./bin/control local-models runtime update --yes
```

Ollama 更新由明确的更新操作触发。目录中的内存评级包含权重和运行开销；是否适合实际任务，还取决于上下文和工具行为。

## LM Studio

启动 LM Studio 的本地服务器，默认 `http://127.0.0.1:1234/v1`。`MODEL_ROUTER_LMSTUDIO_BASE_URL` 可指定其他地址。

```sh
./bin/model-router codex providers enable lmstudio
./bin/curate-models lmstudio
./bin/control local-models lmstudio-set MODEL_ID on
```

模型使用 `lmstudio/<model-id>` 命名空间。模型加载和卸载在 LM Studio 操作，Router 的选择控制客户端菜单显示。

## Apple Silicon 的 MLX 路径

Qwen3.8 27B Uncensored MLX 的安装路径下载指定的 4-bit 权重、通过 LM Studio 载入并发布 `lmstudio/qwen38-27b-uncensored-mlx`。下载需要足够磁盘和统一内存。控制中心有带安装确认的按钮；CLI：

```sh
./bin/control local-models mlx-install --yes
./bin/control local-models mlx-status
./bin/control local-models mlx-cancel
./bin/model-router codex local-mlx install --yes
```

直接 CLI 需要 `lms` 和 `uvx`；桌面安装流程可在确认后安装所需官方运行时。受限的 Hugging Face 仓库通过对应官方 CLI 完成认证。

## 验证和图片用途

用真实 Codex 工具任务检查本地模型，评估连续调用和上下文下的行为：

```sh
node src/agent-check.mjs lmstudio/qwen38-27b-uncensored-mlx
./bin/control vision-bridge local qwen2.5vl:3b
node src/vision-benchmark.mjs qwen2.5vl:3b
```

agent-check 在临时工作区进行两次工具任务并报告结果。读图模型通过已知图像测试文字与数字准确率，随后在 [Codex 图片桥接](CODEX.md)中显式选择。
