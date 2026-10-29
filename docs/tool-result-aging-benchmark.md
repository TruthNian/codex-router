# Measuring tool-result aging

English · [简体中文](zh-CN/tool-result-aging-benchmark.md) · [日本語](ja/tool-result-aging-benchmark.md)

Run the offline rollout measurement without provider calls:

```sh
node scripts/measure-tool-result-aging.mjs /path/to/rollout.jsonl
```

This compares serialized history bytes before and after aging. Its token counts
are estimates, and its archive readback path is assumed available. It does not
measure task correctness, actual provider billing, or prompt-cache reuse.

Recorded `usage-events.jsonl` rows include `toolResultsAged` and
`toolResultBytesSaved` when aging occurs. Use provider-reported input, output,
and cached-input usage to assess actual consumption. Equal result counts or
byte lengths do not prove byte-identical prompts or a stable cache prefix.
Readback requests and later model calls can offset context-byte reductions.

The former live A/B script and fixed-price savings report have been retired:
they did not isolate host state or establish the reported counterfactual costs.
No live provider benchmark is provided by this guide.
