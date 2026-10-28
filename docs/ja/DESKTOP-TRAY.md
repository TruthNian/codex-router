# デスクトップトレイと Control Center

[English](../DESKTOP-TRAY.md) · [简体中文](../zh-CN/DESKTOP-TRAY.md) · 日本語

デスクトップアプリは同じ Router 制御プレーンを使い、接続、モデル表示、使用量を CLI と共有します。

## プラットフォーム別の動作

| プラットフォーム | トレイとウィンドウ |
| --- | --- |
| macOS 13+ | Swift ネイティブのメニューバーホストと埋め込み Electron ウィンドウ |
| Windows 10/11 | Electron トレイとウィンドウ |
| Linux | Electron ウィンドウ。StatusNotifier host がある場合は復帰可能なトレイ動作 |

トレイが利用できる場合、ウィンドウを閉じてもトレイが残り、そこから開き直せます。Linux でトレイホストを確認できない場合は可視ウィンドウを維持し、それを閉じると終了します。

## ページ

- **Dashboard / Status**：ヘルス、現在のモデル、処理中の要求、時間、速度。
- **Usage**：7/30/90 日の token 推移、モデル/プロバイダー別統計、公開された利用枠とリセット時刻。
- **Connections**：アカウント、API キー、ログインモード、更新、修復。
- **Models**：モデル群ごとのルート、表示、検証済みサブエージェント機能。
- **Local LLMs**：カタログ、メモリ適合、ダウンロード、キャンセル、削除、ベンチマーク。
- **Vision bridge**：画像エンジン、推論段階、ローカルモデル。

プロバイダーが残高や token 詳細を提供しない場合は Router が観測したトラフィックを表示します。

## ブラウザーパネル

パネル URL にはローカル呼び出しキーが含まれるため、共有前に秘密パスを伏せます。ブラウザーパネルは読取用で、認証編集はデスクトップまたはローカル CLI で行います。

```sh
./bin/panel
```

```powershell
.\codex-router.ps1 panel
```

## ビルドとログイン時起動

macOS/Linux は固定したソースディレクトリで実行します。

```sh
./bin/model-router-tray
```

Windows はビルドしてログインタスクを登録します。

```powershell
.\install.ps1 -CheckoutInstall -WithTray
.\codex-router.ps1 tray status
.\codex-router.ps1 tray start
.\codex-router.ps1 tray stop
.\codex-router.ps1 tray restart
```

Windows のトレイタスクと Router サービスタスクは別々に管理します。明示的な Quit でアプリを終了し、次のログインで再び起動します。Linux は `model-router-tray` から起動し、デスクトップのトレイ対応に従います。macOS は launchd が管理します。[macOS ガイド](MACOS-TRAY.md)を参照してください。

## リリースパッケージ

[リリースページ](https://github.com/duolahypercho/codex-router/releases)でソース、チェックサム、利用可能なデスクトップパッケージを配布します。Windows/Linux のデスクトップパッケージには対応する Router バージョンを使います。Linux はアーカイブを展開し、実行権限を保った AppImage を起動します。

macOS のビルド済みパッケージは固定 Developer ID、チェックサム、Gatekeeper、ソース指紋を確認します。署名済みパッケージが使えない場合やソースが異なる場合は、対応する経路でローカル Xcode ビルドに進みます。CI 成果物はそのビルドコミットの確認用です。

## 認証と設定

API キーはローカルの安全な入力欄で入力し、標準入力から制御プロセスに渡します。モデルとプロバイダー選択は共有状態を使います。カタログの再読込が必要な変更後は、クライアントを完全に終了して開き直します。
