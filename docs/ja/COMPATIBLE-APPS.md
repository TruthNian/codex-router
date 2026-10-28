# 対応クライアント

[English](../COMPATIBLE-APPS.md) · [简体中文](../zh-CN/COMPATIBLE-APPS.md) · 日本語

各接続は一つの Router サービス、プロバイダー選択、認証情報を共有します。`TARGET` は書き込むクライアント設定を指定します。以下は macOS/Linux の例です。Windows は `.\model-router.ps1 TARGET COMMAND`、制御コマンドは `node src/control.mjs` を使います。

## DeepSeek Harness

`dsh` は `$DSH_HOME/settings.yaml` の `llm-pi-ai.providers.codex-router` にルートを登録し、認証参照を `.credentials.yaml` に保存します。Harness が設定変更を監視して読み込みます。既存 Router では次を実行します。

```sh
./bin/model-router dsh enable
./bin/model-router dsh doctor
./bin/model-router dsh subagent-preset
./bin/model-router dsh disable
```

子エージェントは既定のモデルを継承します。別モデルを使う場合は `subagent-preset` の出力を自分の preset に追加します。ネイティブ GPT を共有するには Codex にログインし、共有プレーンへのアクセスを明示的に許可します。

```sh
codex login
./bin/model-router codex chatgpt-session enable
./bin/model-router codex chatgpt-session disable
```

同じ OS ユーザーの Harness、Gemini、OpenClaw などがこの許可を共有し、有効な Codex セッションでアクセスします。許可を解除しても Codex のログインは保持します。

## Gemini CLI

`gemini` は `~/.gemini/.env` に管理対象の端点、呼び出しキー、既定モデルを保存します。次回起動時に読み込み、認証方式は **Use Gemini API key** を選びます。

```sh
./bin/model-router gemini enable
./bin/model-router gemini doctor
gemini --model deepseek/deepseek-v4-flash
./bin/model-router gemini disable
```

`--model` で今回のモデルを指定できます。`settings.json` と環境ファイルのほかの設定は保持します。Gemini の `:countTokens` はバイト数から推定し、`:embedContent` は未実装を示すエラーを返します。OpenAI embeddings は[プロバイダーガイド](PROVIDERS.md)を参照してください。

## Cursor Agent と Cursor App

Cursor Agent はローカルの `cursor-router-agent` を使います。Cursor App BYOK は Cursor 側バックエンドから送信され、専用の `127.0.0.1:4214` 入口と固定公開 HTTPS トンネルを使います。

Control Center の **Harness → Connect Cursor** は固定コネクターの導入、Cloudflare 認証、ドメイン選択、専用ホスト名の作成、Cursor 終了の待機、モデル公開、再起動を案内します。既存のホスト名は CLI でも設定できます。

```sh
./bin/model-router cursor enable --hostname cursor-router.example.com
./bin/model-router cursor doctor
cursor-router-agent --list-models
cursor-router-agent --model 'PASTE_ID_FROM_THE_LIST' --print "Reply with OK"
./bin/model-router cursor disable
```

推論段階の接尾辞を含む ID 全体を一覧からコピーします。Cursor App 設定の変更前に完全に終了します。Cursor 自身のモデルを使うときは BYOK の base URL override を元に戻します。Agent のローカル読取、編集、端末実行は Cursor の権限に従います。MCP 対応は現在のコネクター実装で確認します。

## Claude Code

`claude` は `claude-router` ランチャーを作成し、そのプロセスをローカル Messages アダプターに接続します。通常の `claude` 設定は保持します。

```sh
./bin/model-router claude enable
claude-router
./bin/model-router claude doctor
./bin/model-router claude disable
```

起動後に `/model` から `codex_router/anthropic/<provider>/<model>` を選びます。ルートは選択したプロバイダーの認証を使います。Claude.ai ログインを利用する場合は、後述のサブスクリプションエージェントブリッジを使います。

## OpenClaw

Control Center の Set up は不足する公式 CLI を導入し、`models.providers.codex-router` にモデルを公開します。既存の agent、チャネル、プラグイン、ほかのプロバイダー設定は保持します。

```sh
./bin/model-router openclaw enable
./bin/model-router openclaw doctor
./bin/model-router openclaw status
./bin/model-router openclaw disable
```

モデル参照は `codex-router/<router-slug>`、API は `openai-responses` です。初回に既定モデルがなければ Router の優先ルートを選び、以後は利用者の選択を保ちます。

## 既存設定に公開するクライアント

| クライアント | 管理対象ファイル | プロトコル |
| --- | --- | --- |
| opencode | `~/.config/opencode/opencode.json` | Responses |
| pi | `~/.pi/agent/models.json` | Responses |
| omp | `~/.omp/agent/models.yml` | Responses |
| Command Code | `~/.commandcode/providers.json` | Messages |
| Hermes Agent | `~/.hermes/config.yaml` | Messages |

Control Center の Harness ページの Set up は以下のコマンドに対応します。omp と Hermes は公式 CLI を先にインストールします。

```sh
./bin/control client-setup opencode
./bin/control client-setup pi
./bin/control client-setup omp
./bin/control client-setup commandcode
./bin/control client-setup hermes
./bin/control client-update opencode
./bin/control client-update --all
./bin/control client-disconnect opencode
```

更新は各クライアントの updater で行います。Router は自分のプロバイダーブロックを管理し、ほかの設定や YAML コメントを保持します。`OPENCODE_CONFIG`、`PI_CODING_AGENT_DIR` などの上書き値から実際のファイルを特定します。

## サブスクリプションエージェントブリッジ（実験的）

Harness ページから Claude Code、Cursor Agent、Gemini CLI の公式エージェントプロセスと既存セッションに接続できます。Claude は公式プロセス、Cursor は `agent acp`、Gemini は `gemini --acp` を使います。利用枠と権限は各クライアントに従い、ブリッジの権限要求は現在の前景 UI の対応範囲に従います。

状態と推論を行わない検査は次のとおりです。

```sh
./bin/model-router codex agents status
./bin/model-router codex agents probe anthropic
./bin/model-router codex agents probe cursor
./bin/model-router codex agents probe gemini
```

`agents prompt` は接続先クライアントの実際の利用枠を使い、プロンプトを stdin から受け取ります。ブリッジの索引には有界のセッション ID、作業ディレクトリ、時刻を保存し、プロンプトと transcript は各クライアントに残します。

## T3 Code

[T3 Code](https://t3.codes/) は対応する公式 CLI を実行します。利用する CLI に Router を設定してから T3 Code を完全に終了して開き直し、追加したモデルを選びます。
