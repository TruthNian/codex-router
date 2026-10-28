# トラブルシューティング

[English](../TROUBLESHOOTING.md) · [简体中文](../zh-CN/TROUBLESHOOTING.md) · 日本語

インストール済みソースディレクトリで診断と状態確認から始めます。Windows は `.\model-router.ps1 codex doctor` と `.\model-router.ps1 codex status` を使います。

```sh
./bin/model-router codex doctor
./bin/model-router codex status
```

## 新しいネイティブモデルが見つからない

現在の ChatGPT アカウントで対象モデルが利用でき、Codex が更新済みでログインが有効なことを確認します。Router は実際のアカウントカタログから取得します。バックグラウンドでも差分を確認します。手動更新後は Codex を完全に終了して開き直し、新規タスクで確認します。

見つからない場合はネイティブカタログと統合カタログを比較し、診断の取得エラーや schema エラーを確認します。

```sh
./bin/refresh-catalog
```

<a id="external-models-are-missing-from-the-picker"></a>

## 外部モデルがメニューに出ない

プロバイダーが有効で、認証が ready、対象モデルが表示対象であることを確認します。ライブカタログ型は先にモデルを選択します。互換レイヤーが無効な場合、ゲートウェイ依存モデルは有効なカタログから外れます。必要に応じて互換レイヤーを再有効化し、依存関係を準備して再公開します。

DeepSeek と Groq の例です。

```sh
./bin/model-router codex providers
./bin/model-router codex providers enable deepseek
./bin/model-router codex provider-key deepseek set
./bin/curate-models groq
```

## 状態ディレクトリが別のソースに属する

インストールマニフェストは状態を所有するソースパスを記録します。表示された所有先から更新や修復を行います。独自の状態パスは `MODEL_ROUTER_STATE_DIR` / `CODEX_ROUTER_STATE_DIR` で指定します。実際のサービスが参照する構成を先に確認します。

## プロバイダー認証の失敗

Kimi OAuth は公式 CLI でログインと地域を確認し、Grok OAuth は公式 Grok CLI でログインします。Windows がプログラムを止める場合は、ファイルの出所とシステムポリシーの拒否記録を確認します。

API キーは `provider-key PROVIDER set` から再入力します。環境変数や Keychain にキーが残っている場合、Router のファイル削除後も利用可能と検出されることがあります。診断で認証元を確認します。プランの API 権限とキーの有効性をそれぞれ確認してください。

Windows のプロセス分離機能エラーは、PowerShell の `FullLanguage`、`Add-Type`、AppLocker/WDAC を確認し、組織のポリシーに沿って環境を構成します。

## モデル ID や機能の変更

プロバイダーカタログを更新し、現行 ID を選択します。ローカルオーバーレイのコンテキスト、画像、推論、プロトコルを確認します。調整済みメタデータを保持し、名称変更には明示的な移行定義を使います。モデル検証はプロバイダーの利用枠を使います。

## コンテキストと圧縮

ウィンドウを超える場合は、実際のモデル ID、コンテキスト、圧縮閾値、プロバイダー報告の入力トークンを確認します。毎ターン圧縮される場合は checkpoint の再生、設定上限、入力の重複追加を確認します。

ツール出力のエージングと原文読取は [Codex ガイド](CODEX.md)にあります。バイト削減、キャッシュ命中、実際の請求を合わせて評価します。

## サブエージェントがない・Working のまま

対象モデルに検証済み v2 機能があり、picker と subagent の両方で有効か確認します。カタログ再公開では管理対象のエージェント定義も修復します。完了した子には現在の Codex v2 の `interrupt_agent` を使います。状態表示と FINAL_ANSWER は別のイベントです。

## エージェントが早く終了する

クライアントの最後のメッセージ、ツール呼び出し、Router の対応要求を確認します。外部モデルが最終テキストだけを返すとクライアントはターンを終了します。付属 skills の注入と、実際にツールを呼び出したかを確認します。

## ネイティブ GPT の失敗・502 接続タイムアウト

ChatGPT ログイン、選択モデル、`native-redirect` とログインモードを確認します。`chatgpt.com` の接続タイムアウトが明示される場合は出力側プロキシとネットワークログを確認します。`NODE_USE_ENV_PROXY=1` と HTTP/HTTPS プロキシ変数をサービス定義に反映し、ループバックを `no_proxy` に含めます。

ターミナルだけ動作し GUI の要求が Router に届かない場合は、GUI のシステムプロキシとループバック例外を確認します。[インストール](INSTALL.md)に手順があります。

## ポート競合・サービス停止

診断で競合ポート、登録済みサービス、実プロセスを確認します。所有者を確認してから自分が管理する設定を調整するか、識別した旧サービスを停止します。その後 Router を開始します。

```sh
./bin/model-router codex start
./bin/model-router codex status
```

## 更新の失敗

更新ログにはインストールと復旧の両方の結果を表示します。手動復旧にはキャッシュされた旧ソースを使います。旧版インストールの移行を戻す場合は別の `migrate rollback` を使います。

```sh
./bin/model-router codex rollback
./bin/migrate rollback
```

## Responses WebSocket・音声接続

`401` は古い呼び出し URL を使っている場合があるため、管理設定を修復してクライアントを再起動します。対応プロトコルのヒント付き `426` は、クライアントが HTTP に戻るための応答です。WebSocket edge は同じ認証済み HTTP ルートを使い、プロバイダーエラーは Responses イベントで確認します。

音声の `/v1/live` はネイティブの realtime 端点を使います。更新後に接続を再有効化して Codex を再起動し、管理対象の realtime 設定を読み込みます。

```sh
./bin/model-router codex enable
```

## アーカイブのディスク使用量

診断に原文の件数、容量、最古の項目、TTL を表示します。既定保存期間は七日です。期限切れの証拠は読取対象から外し、書込時または手動の期限切れ処理でファイルを除去します。まずプレビューできます。

```sh
./bin/control tool-result-aging purge
./bin/control tool-result-aging purge --expired
./bin/control tool-result-aging purge --expired --yes
```

削除済み原文は旧ハンドルから取得できなくなります。既存の対話ではその履歴を証拠不足として扱う必要があります。[読取証明](tool-result-readback-proof.md)を参照してください。

## サポート用資料・削除後の保持データ

サポート用ファイルは次で生成します。

```sh
./bin/support-bundle
```

バージョン、診断、サービス状態、設定の所有情報、ファイルメタデータをローカルにまとめます。内容を確認してから必要に応じて共有します。接続削除後も認証、ログ、カタログキャッシュ、復旧データを保持します。消去する場合は対象の状態ディレクトリと必要なデータを確認します。
