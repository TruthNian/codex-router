# ChatGPT 原生账户切换

[English](../CHATGPT-ACCOUNT-MODES.md) · 简体中文 · [日本語](../ja/CHATGPT-ACCOUNT-MODES.md)

在控制中心选择保存的 ChatGPT 账户，关闭并重新启动 Codex 后应用。各账户的登录保存在隔离 profile 中。

## 模型目录与默认模型

每个账户保留自己的原生模型目录和 Router 覆层。新选择会在 Codex 启动后使用；任务的外部模型选择仍按供应商路由处理。

## 用量

Router 最多读取八个已保存且可用账户的隔离 `CODEX_HOME` 用量，优先当前账户，采用可用的周窗口或月窗口。账户切换由用户明确选择。

## 令牌刷新与删除

Codex 的官方认证流程负责令牌刷新。需要重新登录时按照官方 `codex login` 流程操作。账户操作保留其他账户的会话；清理某个 profile 时确认目标账户及需要保留的数据。
