# 桌面归档回读凭证

[English](../tool-result-readback-proof.md) · 简体中文 · [日本語](../ja/tool-result-readback-proof.md)

本地原文读命令返回带签名的回读凭证。Router 用它确认模型所在执行环境能够访问同一对话/权限范围的原文，验证后才允许省略历史输出。

桌面工具可能把 JSON 包装在其他结果结构中。解析限定为八层、完整 JSON 字符串最多 64 KiB、数组前 64 项，以及已知的 `text`、`output`、`content`、`value` 等字段。

验证涵盖签名、有效期与范围。缺失、伪造、过期、跨范围或不可访问时保留完整输出。读命令读取保存的文本，历史命令的重新执行会产生新的状态观察。

操作与清理见 [Codex 指南](CODEX.md)，跨原文查找见[范围搜索](tool-result-scope-search.md)。
