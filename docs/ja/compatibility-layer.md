# 任意の互換レイヤー

[English](../compatibility-layer.md) · [简体中文](../zh-CN/compatibility-layer.md) · 日本語

LiteLLM 互換レイヤーは既定で有効です。ネイティブ GPT と Responses ネイティブルートだけを使う構成では永続的に無効化できます。モデル定義、プロバイダー選択、認証参照、表示設定は保持します。

## 設定

```sh
node src/control.mjs compatibility-layer status
node src/control.mjs compatibility-layer off
```

共有状態ディレクトリの `compatibility-layer.json` に選択を保存します。コマンドは `restartRequired: true` を返すため、適切な時間に依存関係を準備し、サービスを再起動して各カタログを更新します。

新しいソース構成ではインストール前に設定できます。

```sh
node src/compatibility-layer-state.mjs off
```

無効化後は両ソースインストーラーと依存関係の強制修復で Python のインストールと検査を省略します。ネイティブ GPT、HTTP/WebSocket Responses は独自の経路を使います。保存された無効化の選択を環境設定より優先します。

## 依存ルートと再有効化

LiteLLM を使う Chat、Messages、Vertex、OAuth、Ollama のルートは有効カタログから外れ、要求に `compatibility_layer_disabled` を返します。該当ルートへのネイティブリダイレクトも同じ状態を報告します。

再有効化するには次を使います。

```sh
node src/control.mjs compatibility-layer on
```

その後、依存関係を準備して再起動し、カタログを再公開します。無効化設定がある場合は更新/ロールバック先の対応を先に確認します。

## Homebrew とキャッシュ

Homebrew はパッケージとして Python 依存関係を宣言し、実行時のゲートウェイは互換レイヤー設定に従います。インストール時から Python を省略したい場合はソース構成を使います。キャッシュ済み `.venv` は再有効化時に使え、削除は別の管理操作です。
