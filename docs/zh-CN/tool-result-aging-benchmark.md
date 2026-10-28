# 工具结果老化的效果评估

[English](../tool-result-aging-benchmark.md) · 简体中文 · [日本語](../ja/tool-result-aging-benchmark.md)

同时查看供应商报告的 token、任务完成质量、缓存命中和额外回读调用。

## 历史 A/B 结果

2026-08-12 的历史实验基于提交 `60100aa835fe3a0d6856b0b414223c84db672efa`，模型为 `grok-oauth/grok-4.6`。合成请求为 69,701 字节，包含一项 66,621 字节的已消费旧工具结果和四项受保护的新结果。

两轮实验的输入计数均为：关闭时 22,071 token，开启时 2,991 token，减少 19,080（86.45%），回复为 `OK`。该请求刻意包含大量旧输出；一般任务的效果取决于历史结构、tokenizer、模型、缓存和现行回读条件。

原始历史结果见[JSON 数据](../tool-result-aging-benchmark-results.json)。

## 实际请求测试

下面的脚本发送两次实际模型请求并使用额度：

```sh
node scripts/live-test-tool-result-aging.mjs --yes --model grok-oauth/grok-4.6
```

## 离线回放

历史私有工作负载在 95 个压缩点附近采样 96 份历史，64 份含可老化结果，共节省 5,735,259 个序列化字节。换算的 1,737,926 输入 token 属于估计。

本机回放估计与已记录用量分别使用：

```sh
node scripts/measure-tool-result-aging.mjs /path/to/rollout.jsonl
node scripts/aging-benchmark.mjs
```

现行访问证明、过期和范围要求见[回读凭证](tool-result-readback-proof.md)及[按模型策略](tool-result-model-policy.md)。
