# macOS メニューバー、Control Center、ウィジェット

[English](../MACOS-TRAY.md) · [简体中文](../zh-CN/MACOS-TRAY.md) · 日本語

メニューバーホストはネイティブ Swift UI、Control Center は埋め込み Electron を使います。`~/Applications/Codex Router.app` または Spotlight から開き、閉じた後はメニューバーから再表示できます。

## インストールと再ビルド

継続して使うソースディレクトリで実行します。

```sh
./bin/model-router-tray
```

最初に staging アプリをビルドして検証し、ユーザー Applications に配置して launchd に登録します。ローカルビルドはソースパスを記録するため、移動後は再ビルドします。フル版 Xcode が必要で、`DEVELOPER_DIR` から場所を指定できます。

## ウィジェットと Island

メニューバーの **Settings → Dynamic Island** で画面上部のアクティビティ表示を有効化できます。**Desktop** は移動可能なデスクトップパネルです。このパネルは Router アプリから提供します。全プロバイダーの確認や設定にはメニューバーを使います。

## ログインと Codex に合わせた表示

launchd はログイン時にホストを起動し、異常終了を扱います。**Always** は継続表示、**With Codex** は Codex/ChatGPT に連動し、両方の終了後に待機と処理中要求の完了を経て関連サービスを停止します。CLI や Harness の継続利用は実際の presence モードに反映され、状態画面で有効なモードを確認できます。

## メニューバー表示

Settings の **Menu bar** から標準文字/アイコン、モデル名表示、Router/プロバイダー/状態点/SF Symbols/独自アイコンを選択できます。一部の設定は defaults でも変更できます。

```sh
defaults write io.github.codex-router.tray ModelRouterTray.menuBarDisplayMode iconOnly
```

## プロバイダーと保守

Providers で API キーの追加、置換、削除を行い、OAuth プロバイダーは公式 CLI の導入とログインを案内します。選択変更の適用状況を表示し、失敗時はエラーとトランザクションに応じた復旧を報告します。

**Update & Verify** はインストール所有先のソースから適用して診断します。完了後に Codex を再起動し、新モデルとエージェントを読み込みます。ログイン不要モードは接続済みかつ有効な外部プロバイダーを最低一つ使い、画面の手順で Codex の再起動を要求します。

使用量カードはプロバイダーの公開利用枠と Router の観測値を使い、請求は対応するプロバイダーのコンソールで確認します。

## 署名済みリリース

`model-router-<version>-macos-universal.zip` の取得はソースで固定した署名チームとリポジトリの信頼設定に従います。チェックサム、パッケージ配置、Developer ID、Gatekeeper を確認してからソースのメタデータを比較します。

リリース不足、ネットワーク失敗、ソース不一致の場合は対応するフォールバック経路でローカルビルドできます。フル版 Xcode の選択は[インストールガイド](INSTALL.md)を参照してください。
