# インストール、移行、更新

[English](../INSTALL.md) · [简体中文](../zh-CN/INSTALL.md) · 日本語

Codex 接続を例に説明します。ほかのクライアントも Router サービスとプロバイダー認証を共有します。[クライアントガイド](COMPATIBLE-APPS.md)に接続手順があります。

## 必要な環境

macOS と Windows は Codex App / CLI、Linux は CLI に対応します。Node.js 22.19+、Git、利用するプロバイダーの権限が必要です。保守中の Node.js 24 LTS を推奨します。

互換レイヤーが有効なソースインストールには `uv` または `venv` 付き Python 3.10+ を使います。[互換レイヤーを無効化](compatibility-layer.md)すると、インストールと依存関係の強制修復で Python を省略します。実行時のゲートウェイ起動は選択済みルートで決まります。Homebrew の Python 依存関係はパッケージ管理に従います。

Windows は PowerShell の `FullLanguage` と `Add-Type` を許可するポリシーが必要です。macOS のデスクトップアプリにはフル版 Xcode を使います。`DEVELOPER_DIR`、`/Applications/Xcode.app`、`Xcode-beta.app` が参照されます。

## 対話式インストール

macOS/Linux のターミナルで実行します。

```sh
curl -fsSL https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.sh \
  | sh -s -- --target codex --guided --with-tray
```

Windows は PowerShell で実行します。

```powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target codex -Guided -WithTray
```

スクリプトを確認してから実行する場合は、クローン後に `./install.sh --target codex --guided --with-tray`、Windows では `./install.ps1 -Target codex -Guided -WithTray` を使います。Router だけを使う場合はトレイ引数を `--no-tray` または `-NoTray` に置き換えます。

プロバイダー選択、既存認証の確認、必要な認証情報の入力、変更内容の確認を経てサービスをインストールします。macOS でフル版 Xcode がない場合はデスクトップアプリを省略し、案内を表示します。

<a id="homebrew-router-and-cli-only"></a>

## Homebrew

Router と CLI をインストールします。デスクトップアプリを使う場合は上記のソースインストーラーを選びます。

```sh
brew tap duolahypercho/codex-router https://github.com/duolahypercho/codex-router
brew install codex-router
codex-router setup --guided
```

ソース構成の `./bin/model-router codex COMMAND` または `./bin/COMMAND` は、Homebrew では `codex-router COMMAND` に対応します。モデル追加は `codex-router curate-models PROVIDER` を使います。更新と削除は次のとおりです。

```sh
brew upgrade codex-router
codex-router uninstall
brew uninstall codex-router
```

## プロバイダー認証

API キーはローカルの非表示プロンプトで保存します。`set` を再実行すると置き換え、`remove` で Router が保存したキーを削除できます。バックグラウンドサービスは保護された認証ファイルを使います。地域や契約の違いは[プロバイダーガイド](PROVIDERS.md)を参照してください。

```sh
./bin/model-router codex provider-key deepseek set
./bin/model-router codex provider-key deepseek remove
```

Windows は `./bin/model-router codex` を `.\model-router.ps1 codex` に置き換えます。Kimi/Grok OAuth は対応する公式 CLI でログインします。Antigravity は所有する OAuth クライアント、プライベート API への許可を得たプロジェクト、明示的なライブ検証を使います。

`--smoke-test` は選択済みプロバイダーに実際のリクエストを送り、利用枠を消費します。必要なときに指定してください。

## 出力側プロキシ

インストール前に `NODE_USE_ENV_PROXY=1` と `http_proxy` / `https_proxy` / `no_proxy` を設定します。大文字の変数も使えます。`no_proxy` に `localhost,127.0.0.1,::1` を含め、内部通信をループバックに保ちます。対応する Node では `--use-env-proxy` も使えます。

インストーラーは設定をサービス定義に保持します。変更後はインストーラーを再実行して反映します。`ALL_PROXY` は対応する子プロセスに渡され、Router の Undici は HTTP/HTTPS プロキシ変数を使います。

GUI アプリは起動環境またはシステムのプロキシ除外設定からループバック例外を取得します。GUI だけ失敗し、Router にリクエストが届かない場合はこの設定を確認します。macOS の現在のログインセッションでは次を使えます。

```sh
launchctl setenv NO_PROXY "localhost,127.0.0.1,::1"
```

設定後にクライアントを完全に終了して開き直します。ログアウトまで有効です。永続化にはログインエージェントを使います。

## インストール処理と移行

選択と既存状態の検証、依存関係の準備、呼び出し用と内部用の別キー生成、モデルとクライアント設定の公開、ユーザーサービスの登録、ヘルス確認を行います。Codex 設定は管理マーカー内に書き、既存モデル、プロファイル、ログインを保持します。エージェント数の設定がない場合は管理対象の既定値を追加します。

失敗時はトランザクションの状態に従って復旧します。登録済みで起動中またはクールダウン中のサービスは保持し、一時的失敗を報告します。更新後の復旧にも失敗した場合は、両方のエラーを報告します。

旧版は既知のインストールを識別し、対応する設定とサービス情報を保存してから移行します。確認と移行のロールバックは次のとおりです。

```sh
./bin/migrate detect
./bin/migrate rollback
```

自分で管理するネイティブカタログを使う場合は `--adopt-native-catalog` / `-AdoptNativeCatalog` を明示します。絶対パス、有効なネイティブモデル、確認可能な設定の所有情報が必要です。

<a id="credential-free-idle-install"></a>

## 認証情報を使わない待機構成

インストールのライフサイクルを確認する場合に使えます。

```sh
./install.sh --target codex --no-provider --no-discovery --no-tray
```

```powershell
./install.ps1 -Target codex -NoProvider -NoDiscovery -NoTray
```

`--no-provider` は空のプロバイダー選択を保存します。`--no-discovery` を併用すると認証探索を停止し、モデルメニューは空になり、推論要求にローカルの `503 router_idle_no_provider` を返します。通常のセットアップを再実行すると探索を再開します。

## 再起動と診断

Codex は起動時にモデルカタログを読み込みます。完全に終了して開き直し、新規タスクを作成して診断します。

```sh
./bin/model-router codex doctor
./bin/model-router codex status
```

macOS/Linux CLI は `./bin/model-router codex shim install` で、Codex 起動前に Router を待つ shim を明示的に導入できます。`shim status` で有効性を確認し、`shim uninstall` で削除します。

<a id="update-and-rollback"></a>

## 更新とロールバック

実行中の対話がない時間を選び、インストール済みソースディレクトリで実行します。

```sh
./bin/model-router codex update check
./bin/model-router codex update
./bin/model-router codex rollback
```

`update check` はリモート Git メタデータを取得して比較します。更新は認識済みの管理チェックアウトで動作します。ソース置換前に追跡済みファイルの変更を確認し、明示的な `--force` でその変更を破棄します。未追跡ファイルは保持します。

管理用の更新コマンドは更新前のソースを保存して再インストールします。失敗時は旧バージョンの再インストールを試み、結果をエラーに含めます。ロールバック後に detached HEAD になる場合は、次回更新で `main` に戻ります。手動で `git pull` した場合も更新コマンドを実行し、サービスとソースを揃えます。

ソースの bootstrap インストーラーは取得後に対話式セットアップを実行します。認証情報が未入力、またはプロンプトを取り消した場合など、セットアップが終了コード 2 を返すと更新済みソースを保持します。再度セットアップして構成を完了します。ほかのセットアップ失敗では、旧バージョンがあればソースを戻し、detached HEAD にします。次回の bootstrap 実行は取得前に `main` に戻ります。明示的に旧版へ戻す場合はロールバックコマンドを使います。

`doctor --fix` はソース構成の依存関係と設定を修復します。Homebrew のパッケージ破損には `brew reinstall codex-router` を使います。ソースアーカイブ構成は新しいリリースアーカイブで更新します。

## 無効化と削除

`disable` は選択したクライアント接続を解除し、`enable` は再公開します。`uninstall` は接続と、ほかの接続から使われなくなった共有サービスを削除します。認証情報、ログ、ロールバック、移行データは状態ディレクトリに保持します。

```sh
./bin/model-router codex disable
./bin/model-router codex enable
./bin/model-router codex uninstall
```
