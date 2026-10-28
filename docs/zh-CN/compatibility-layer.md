# 可选兼容层

[English](../compatibility-layer.md) · 简体中文 · [日本語](../ja/compatibility-layer.md)

LiteLLM 兼容层默认开启。仅使用原生 GPT 和 Responses 原生路由的安装可以持久停用它；模型定义、供应商选择、密钥引用和显示偏好保留。

## 配置

```sh
node src/control.mjs compatibility-layer status
node src/control.mjs compatibility-layer off
```

共享状态目录中的 `compatibility-layer.json` 保存选择。命令报告 `restartRequired: true`，由操作者在适合的时机准备依赖、重启服务并刷新各客户端目录。

新源码目录可在安装前设置：

```sh
node src/compatibility-layer-state.mjs off
```

停用后，两种源码安装器以及强制依赖修复跳过 Python 安装和探测。原生 GPT、HTTP/WebSocket Responses 路由仍使用其自身路径。环境变量按保存的停用选择执行。

## 依赖路由与恢复

需要 LiteLLM 的 Chat、Messages、Vertex、OAuth 和 Ollama 路由从有效目录中移除，请求返回 `compatibility_layer_disabled`。依赖路由的原生重定向也会报告该状态。

重新启用：

```sh
node src/control.mjs compatibility-layer on
```

随后准备依赖、重启并重新发布目录。停用设置存在时，更新或回退会先检查目标版本是否支持这项策略。

## Homebrew 与缓存

Homebrew 在打包时声明 Python 依赖；运行时仍按兼容层选择决定是否启动网关。源码安装适合希望安装阶段也省略 Python 的情况。已缓存 `.venv` 可以供以后恢复使用，其清理由操作者单独管理。
