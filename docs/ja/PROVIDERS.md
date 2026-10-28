# プロバイダー、認証、モデル選択

[English](../PROVIDERS.md) · [简体中文](../zh-CN/PROVIDERS.md) · 日本語

プロバイダーと内蔵モデルは[レジストリ](../../config/)で定義されます。ローカル追加モデルは保護された `user-models.json` に保存します。各ルートはそれぞれの認証、請求、コンテキスト、機能設定を使います。

以下はインストール済みソースディレクトリのコマンドです。Windows では `./bin/model-router codex` を `.\model-router.ps1 codex`、`./bin/curate-models` を `.\codex-router.ps1 curate-models`、`./bin/control` を `node src/control.mjs` に置き換えます。

## 接続する

ローカルの非表示プロンプトでキーを入力し、プロバイダーを有効化して状態を確認します。

```sh
./bin/model-router codex provider-key deepseek set
./bin/model-router codex providers enable deepseek
./bin/model-router codex providers
```

## プラットフォームと認証

| プロバイダー | 選択と認証 |
| --- | --- |
| Kimi | `kimi-oauth` は Kimi Code CLI セッションを使用。`kimi-api` と `kimi-api-cn` は国際/中国プラットフォームの各キーを使用 |
| StepFun | `stepfun-api` は `api.stepfun.ai`、`stepfun-api-cn` は `api.stepfun.com`。それぞれキーを設定 |
| Qwen | `qwen-plan` は Model Studio のプランキーを使用。`QWEN_PLAN_BASE_URL` で契約に対応する端点を選択 |
| Z.ai | `zai-coding` は Coding Plan、`zai-api` はプラットフォーム API。後者の環境変数は `ZAI_PLATFORM_API_KEY` |
| ClinePass | `clinepass` は Cline API キーを使用。契約モデルには対応する ClinePass 権限が必要 |
| GitHub Copilot | `github-copilot` は **Copilot Requests** 権限付き fine-grained PAT を使い、アカウントカタログから選択 |
| Meta | `meta` は Meta Model API キーと Responses エンドポイントを使用 |
| Command Code | `commandcode` と Messages 変種はキーを共有。API 権限は契約プランで決定 |
| opencode Go / Zen | 同じキーで Go 契約と従量課金 Zen に接続。プロトコルは対応する変種で処理 |

Kimi の各プラットフォームはアカウント、請求、キーを別々に管理します。Kimi Code CLI の国際アカウントは `kimi login --region global`、中国アカウントは `kimi login` を使います。Router は CLI が保存した地域を読み込みます。

Grok OAuth は公式 CLI セッションを利用します。`grok-api` は別の xAI API キーを使います。

```sh
npm install -g @xai-official/grok
grok login --oauth
./bin/model-router codex providers enable grok-oauth
```

## カタログとローカル追加

Groq、Together、Fireworks、Cerebras、Mistral、NVIDIA NIM、SiliconFlow、Hugging Face、Gemini API、Copilot、Chutes、OrcaRouter などはカタログから選択できます。接続後に実行します。

```sh
./bin/curate-models groq
./bin/curate-models groq --models MODEL_ID --efforts low,high
./bin/curate-models groq --remove MODEL_ID
```

対話式選択ではコンテキスト、画像入力、推論段階、リクエスト設定を保存します。公開されたウィンドウ値を出発点に、実際のルートで検証します。`--models` は既存メタデータを保持して追加し、`--remove` で明示的に削除します。

自動ツール選択だけを受け付けるモデルには `--request-profile auto-tool-choice` を使えます。既存モデルはローカルオーバーレイ内の対応フィールドを変更し、ほかの調整値を保ちます。

OrcaRouter の無料デプロイにもアカウントキーが必要です。`./bin/curate-models orca --free-only --apply` で選択できます。OpenRouter、NanoGPT、Venice、Nous Research も各アカウントの API 権限でローカル選択できます。

モデル検証は実際のリクエストと利用枠を使います。

```sh
./bin/test-model 'groq/MODEL_ID' --live --yes
```

## opencode Go と Zen

`opencode-go` のキーを一度設定してファミリーを有効化します。Chat、Messages、Responses の変種が各プロトコルを処理し、Zen は `./bin/curate-models opencode-zen` でモデルを選びます。Go と Zen の利用枠と請求は各サービスに従います。

任意の API キープールは許可された環境変数を参照します。新しい環境ソースを追加した後は同じターミナルからインストーラーを再実行し、サービス定義を更新します。プールは一時停止、再開、ローテーションに対応します。状態の確認は次のとおりです。

```sh
./bin/model-router codex provider-key opencode-go set
./bin/model-router codex providers enable opencode-go
./bin/model-router codex key-pool opencode-go status
```

## 匿名サービスとカスタム端点

`opencode-free` と `kilo-free` は明示的に有効化し、現在のカタログから無料モデルを選択します。匿名サービスの制限は出口 IP を共有する利用者にも関係し、無料ルールはプロバイダーが変更できます。

```sh
./bin/model-router codex providers enable opencode-free
./bin/curate-models opencode-free
./bin/model-router codex providers enable kilo-free
./bin/curate-models kilo-free
```

Control Center の **Models → Custom → Add endpoint** で名前、プロトコル、URL、キーを保存し、その端点のモデルを読み込みます。**By name** はカタログにないプライベート/プレビュー ID の登録に使います。各端点から編集、追加、削除できます。

CLI の例です。

```sh
./bin/model-router codex providers generic add my-endpoint \
  --name "My Endpoint" --base-url https://api.example.com/v1 --adapter openai-chat
./bin/model-router codex providers generic credential my-endpoint set
./bin/curate-models my-endpoint
./bin/model-router codex providers generic add-model my-endpoint private-preview-1
```

認証情報は非表示プロンプトで保存します。端点登録では URL とカタログへのアクセスを検証し、推論、画像、ツールの動作は実際のテストで確認します。送信内容はその端点の運営者が処理します。

## 検索

Grok OAuth はプロバイダー側の検索を使います。検証済みルートは `searchTool` で Codex standalone 検索を宣言します。ほかのルートは Perplexity Search サイドカーを明示的に関連付けられます。専用キーと信頼済みの公開 HTTPS 端点が必要です。

サイドカーの設定例です。

```sh
./bin/model-router codex providers generic add perplexity-search \
  --name "Perplexity Search" --base-url https://api.perplexity.ai --adapter openai-chat
./bin/model-router codex providers generic credential perplexity-search set
./bin/model-router codex search-sidecar set PROVIDER/MODEL perplexity-search
./bin/model-router codex search-sidecar status PROVIDER/MODEL
```

サイドカーは Perplexity `/search` の対応するクエリ部分を使い、モデルの関連付けと認証スコープごとにキャッシュを分離します。変更後は Codex を再起動し、カタログの機能を読み込みます。

## Antigravity OAuth

自分が所有する Google OAuth **Desktop app** クライアントと、`cloudcode-pa.googleapis.com` へのアクセスを許可されたプロジェクトを使います。対応する client ID と secret はコマンドが開くローカル画面で入力します。ログイン、明示的検証、有効化の順です。

```sh
./bin/model-router codex providers login antigravity-oauth
./bin/model-router codex providers probe antigravity-oauth --live --yes
./bin/model-router codex providers enable antigravity-oauth
```

検証は実際の利用枠を使います。成功すると有効化待ちの世代を記録し、インストール済みサービスの再起動とヘルス確認後に有効になります。`SERVICE_DISABLED` はプロジェクトのプライベート API 権限が未承認であることを示します。プロジェクト作成には追加の `--provision-project` 選択が必要です。

## Vertex、Devin、モデル別名

Vertex は `gcloud auth application-default login` の ADC を使い、`./bin/control vertex set PROJECT_ID LOCATION` と `./bin/curate-models vertex` を実行します。`--static --models MODEL_ID` は審査済みリストから選択します。実際のプロジェクト権限とモデルアクセスも必要です。

Devin CLI は `devin auth login` 後にそのアカウントの設定を読み込みます。利用できる機能は互換性の結果で確認します。過去の Ox Alpha 名や移行別名は保存済み選択の互換性に使います。現行 ID とプロトコルはレジストリ、カタログ、テスト結果で確認してください。

検証手順は [Devin CLI 検査](DEVIN-CLI-PROBE.md)にあります。

## Embeddings と Decisions

`/v1/embeddings` は `supportedEndpoints` を明示したモデルで提供します。専用 embedding モデルは `listed: false` にします。OpenRouter Decisions は非表示ルート `openrouter-decisions/jev-latest` と `/v1/decisions` を使い、明示的に構成した構造化ツールクライアントに提供します。

それぞれの API 契約に従って利用します。モデルメニューのチャットモデル選択は通常の対話に使います。

## 既定モデルと開発

新しい Codex タスクの Router 既定モデルを設定できます。設定後は Codex を完全に終了して開き直します。

```sh
./bin/control router-default set deepseek/deepseek-v4-flash
./bin/control router-default clear
```

正式対応するプロバイダーやモデルの追加は[開発ガイド](DEVELOPMENT.md)に従い、認証の分離、ツール呼び出し、ストリーミング、コンテキストを検証して公開します。
