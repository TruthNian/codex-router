# ツール結果の保存効果を測定する

[English](../tool-result-aging-benchmark.md) · [简体中文](../zh-CN/tool-result-aging-benchmark.md) · 日本語

プロバイダーを呼ばず、ロールアウトをオフラインで測定します。

```sh
node scripts/measure-tool-result-aging.mjs /path/to/rollout.jsonl
```

保存前後の履歴のシリアライズ済みバイト数を比較します。token 数は推定で、保存内容の読取パスが利用可能と仮定します。タスクの正しさ、実際の請求、プロンプトキャッシュの再利用は測定しません。

保存時の `usage-events.jsonl` には `toolResultsAged` と `toolResultBytesSaved` が記録されます。実際の消費はプロバイダーが返した入力、出力、キャッシュ入力 token で評価してください。件数やバイト数が等しくても、内容の完全一致やキャッシュ接頭辞の安定性は証明できません。読取要求や後続のモデル呼出しで節約が相殺される場合もあります。

従来の live A/B スクリプトと固定単価による節約報告は、ホスト状態の隔離と反実仮想コストの根拠がないため廃止しました。このガイドは live プロバイダーベンチマークを提供しません。
