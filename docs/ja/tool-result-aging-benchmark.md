# ツール結果エージングの評価

[English](../tool-result-aging-benchmark.md) · [简体中文](../zh-CN/tool-result-aging-benchmark.md) · 日本語

プロバイダー報告の token、タスクの正確さ、キャッシュ命中、追加の読取要求を合わせて確認します。

## 過去の A/B 結果

2026-08-12 の実験はコミット `60100aa835fe3a0d6856b0b414223c84db672efa`、モデル `grok-oauth/grok-4.6` で行われました。合成要求は 69,701 バイトで、使用済みの古いツール出力 66,621 バイトと、保護される新しい結果四件を含みます。

二回の実験はいずれも、無効時 22,071 token、有効時 2,991 token で、19,080（86.45%）減り、応答は `OK` でした。古い出力を多く含めた要求の結果です。通常タスクへの効果は履歴構造、tokenizer、モデル、キャッシュ、現在の読取条件によって変わります。

元の履歴結果は [JSON データ](../tool-result-aging-benchmark-results.json)にあります。

## 実リクエストでのテスト

次のスクリプトは二回の実要求を送り、利用枠を消費します。

```sh
node scripts/live-test-tool-result-aging.mjs --yes --model grok-oauth/grok-4.6
```

## オフライン再生

過去の非公開ワークロードでは圧縮 95 箇所付近の履歴 96 件を調べ、64 件が対象結果を含み、5,735,259 シリアライズ済みバイトを削減しました。換算した入力 1,737,926 token は推定値です。

ローカル再生による推定と保存済み使用量には次を使います。

```sh
node scripts/measure-tool-result-aging.mjs /path/to/rollout.jsonl
node scripts/aging-benchmark.mjs
```

現在のアクセス証明、期限、スコープ条件は[読取証明](tool-result-readback-proof.md)と[モデル別方針](tool-result-model-policy.md)を参照してください。
