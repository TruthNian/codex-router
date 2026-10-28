# 按模型配置历史处理

[English](../tool-result-model-policy.md) · 简体中文 · [日本語](../ja/tool-result-model-policy.md)

默认文本阈值为 32 KiB，原生 GPT 老化关闭。需要为某个模型调整时，在受保护的 `tool-result-aging.json` 保存模型级选择：

```json
{
  "version": 1,
  "enabled": true,
  "nativeEnabled": false,
  "retentionTtlDays": 7,
  "modelMinBytes": {"custom/z-ai/glm-5.3": 16384},
  "readbackHintModels": ["custom/z-ai/glm-5.3"]
}
```

阈值允许 8192–32768 字节的整数，非法条目使用默认值。普通开关和 TTL 更新保留模型选择。导出的设置函数为 `setToolResultAgingMinBytes` 和 `setToolResultReadbackHint`。

较小阈值与回读提示只在预计文本节省达到 128 KiB 时启用，否则使用既有 32 KiB 策略。提示默认关闭：原文已保存但尚无有效同范围凭证时，可在请求中加入一次只读访问提示，使用 `--limit 1` 检查读权限。

失败或无效读回后抑制自动提示重试；完整文本和恢复说明保留。最近四项、未消费结果、图片混合结果、缺少本地工具、写入失败等保护继续适用。

用账单 token、回读调用、缓存变化和任务正确性评估效果。检索见[范围搜索](tool-result-scope-search.md)。
