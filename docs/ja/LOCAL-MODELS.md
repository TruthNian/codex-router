# ローカルモデル：Ollama と LM Studio

[English](../LOCAL-MODELS.md) · [简体中文](../zh-CN/LOCAL-MODELS.md) · 日本語

モデルファイルはローカルランタイムが管理し、Router はダウンロード操作、選択、公開状態を保存します。Control Center の **Local LLMs** からカタログ、メモリ適合、進行状況、キャンセル、削除を操作できます。

## Ollama

適合を確認してからインストールします。`--yes` は不足する Ollama のインストールと起動、`--force` は推奨範囲を超えるモデルのダウンロードに同意します。

```sh
./bin/control local-models list --json
./bin/control local-models inspect gemma4:12b
./bin/control local-models install gemma4:12b --yes
./bin/control local-models cancel gemma4:12b
./bin/control local-models benchmark gemma4:12b
```

対応する Ollama tag またはモデルページ URL を入力できます。バックグラウンドワーカーが段階と進捗を報告し、重複操作は既存タスクを再利用します。キャンセルは対象操作を停止し、最後に完了した状態を保持します。

モデルを選択するとカタログとゲートウェイルートを更新し、必要に応じて Router サービスを再起動します。前景の開発 Router は利用者が再起動します。選択解除ではダウンロード済み重みを保ち、モデル削除ではランタイムの重みを削除します。

## ランタイム管理

```sh
./bin/control local-models runtime status
./bin/control local-models runtime start
./bin/control local-models runtime update --yes
```

Ollama の更新は明示的な更新操作で行います。カタログのメモリ評価は重みと実行コストを含み、実タスクへの適合はコンテキストとツール動作にも依存します。

## LM Studio

LM Studio のローカルサーバーを起動します。既定は `http://127.0.0.1:1234/v1` で、`MODEL_ROUTER_LMSTUDIO_BASE_URL` から変更できます。

```sh
./bin/model-router codex providers enable lmstudio
./bin/curate-models lmstudio
./bin/control local-models lmstudio-set MODEL_ID on
```

モデルは `lmstudio/<model-id>` 名前空間を使います。重みの読み込みと解除は LM Studio、クライアントへの表示は Router の選択で管理します。

## Apple Silicon の MLX 経路

Qwen3.8 27B Uncensored MLX のインストールは指定の 4-bit 重みを取得し、LM Studio で読み込み、`lmstudio/qwen38-27b-uncensored-mlx` を公開します。十分なディスクと統合メモリが必要です。Control Center の確認付きボタン、または CLI を使います。

```sh
./bin/control local-models mlx-install --yes
./bin/control local-models mlx-status
./bin/control local-models mlx-cancel
./bin/model-router codex local-mlx install --yes
```

直接 CLI には `lms` と `uvx` が必要です。デスクトップの確認付き処理では必要な公式ランタイムを導入できます。制限された Hugging Face リポジトリは対応する公式 CLI で認証します。

## 検証と画像用途

実際の Codex ツールタスクで、連続呼び出しやコンテキストを含む動作を確認します。

```sh
node src/agent-check.mjs lmstudio/qwen38-27b-uncensored-mlx
./bin/control vision-bridge local qwen2.5vl:3b
node src/vision-benchmark.mjs qwen2.5vl:3b
```

agent-check は一時作業ディレクトリでツールタスクを二回実行して結果を報告します。画像モデルは既知の画像で文字や数字の精度を確認し、[Codex の画像ブリッジ](CODEX.md)で明示的に選択します。
