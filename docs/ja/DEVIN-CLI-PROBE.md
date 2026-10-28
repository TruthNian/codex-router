# Devin CLI 接続の検証

[English](../DEVIN-CLI-PROBE.md) · [简体中文](../zh-CN/DEVIN-CLI-PROBE.md) · 日本語

インストール済み公式 Devin CLI のセッションを使い、Cascade の要求エンコード、アカウントカタログ、ストリーム分割、ツール結果を確認します。公式 CLI を導入して `devin auth login` を実行し、Router のソースディレクトリから操作します。

## 検査コマンド

既定ではセッションとアカウントカタログを読み込みます。`--live` は短い推論を送り ACU を消費します。既定の出力上限は 64 token、期限は 90 秒です。`--tools` は小さなツールを強制検証し、`--model UID` はカタログ内のモデルを選択、`--json` は構造化報告を返します。

```sh
./bin/devin-probe
./bin/devin-probe --live --tools
./bin/devin-probe --model UID --json
```

## 結果の読み方

`PASS` は検証成立、`FAIL` は失敗、`SKIP` は未実行、`PARTIAL` は実行分が成功して未確認項目が残る状態、`INCONCLUSIVE` は情報不足です。

エンコードやカタログの失敗では CLI バージョン、認証、アカウント権限を確認します。フレーム、ストリームの完全性、終端、出力、ツール ID の失敗では該当報告を使って実際のプロトコル差を調べます。`transport replay` は取得済みデータを実トランスポートで再生した結果を検証します。

小さなツール検査の結果はその要求に対応します。完全な Codex 要求のツール記述、MCP 内容、コンテキスト、プロバイダーの内容規則は対象ワークロードで検証します。
