# モデル別の履歴方針

[English](../tool-result-model-policy.md) · [简体中文](../zh-CN/tool-result-model-policy.md) · 日本語

既定のテキスト閾値は 32 KiB、ネイティブ GPT のエージングは無効です。モデルごとに調整する場合は保護された `tool-result-aging.json` に設定します。

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

閾値は 8192–32768 バイトの整数で、無効な項目は既定値を使います。通常のスイッチや TTL 更新はモデル設定を保持します。公開 setter は `setToolResultAgingMinBytes` と `setToolResultReadbackHint` です。

小さい閾値と読取ヒントは想定テキスト削減が 128 KiB 以上の場合に適用し、それ未満は既存の 32 KiB 方針を使います。ヒントは既定で無効です。原文を保存したが有効な同一スコープ証明がない場合に、一回の読み取り専用 `--limit 1` 確認を要求に追加できます。

失敗または無効な読取後はヒントの自動再試行を抑制し、全文と復旧手順を保持します。最新四件、未使用の結果、画像混在、ローカルツール不足、書込失敗などの保護も適用します。

請求トークン、読取呼び出し、キャッシュ変更、タスクの正確さを合わせて評価します。検索は[スコープ検索](tool-result-scope-search.md)を参照してください。
