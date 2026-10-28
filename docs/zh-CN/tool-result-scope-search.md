# 在同一范围内搜索原文

[English](../tool-result-scope-search.md) · 简体中文 · [日本語](../ja/tool-result-scope-search.md)

原文读命令接受合法的参考句柄与 `--scope-search --find 'literal identifier'`，仅搜索相同签名对话/权限范围内的归档，返回精确片段。

读操作验证完整性、签名、有效期、常规文件及目录归属。输出受片段长度、匹配归档数和扫描预算限制；当前上限为 32 个匹配归档、16 MiB 扫描及文件间检查的一秒预算。

`complete: false` 表示结果不完整。有 `nextCursor` 时使用 `--cursor N --index HASH` 继续；索引变化则从头重新搜索。分页时保留前面已找到的结果和不可用条目报告。

每个归档返回首次出现的位置，更多上下文或后续出现用单档 `--offset` 读取。片段长度按 UTF-16 计，保留代理对时可能多一个代码单元。
