# 测量工具结果归档

[English](../tool-result-aging-benchmark.md) · 简体中文 · [日本語](../ja/tool-result-aging-benchmark.md)

离线测量不会调用提供商：

```sh
node scripts/measure-tool-result-aging.mjs /path/to/rollout.jsonl
```

报告比较归档前后的序列化历史字节数。token 数是估算，并假定归档回读路径可用；它不证明任务正确性、实际账单或提示缓存复用。

发生归档时，`usage-events.jsonl` 会记录 `toolResultsAged` 和 `toolResultBytesSaved`。实际消耗应以提供商返回的输入、输出、缓存输入 token 为依据。结果数量或字节数相同不能证明提示内容完全相同或缓存前缀稳定；回读和后续模型调用也会抵消字节减少。

原 live A/B 脚本及固定单价节省报告已移除：它们没有隔离宿主状态，也未证明反事实费用。本指南不再提供 live 提供商基准。
