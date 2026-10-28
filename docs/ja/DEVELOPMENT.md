# 開発ガイド

[English](../DEVELOPMENT.md) · [简体中文](../zh-CN/DEVELOPMENT.md) · 日本語

## コード構成

- `config/`：プロバイダーとモデルのレジストリ。
- `src/model-registry.mjs`：検証、索引、ローカルオーバーレイ。
- `src/catalog.mjs`：ネイティブ/外部カタログの統合。
- `src/router.mjs`：認証とモデルの経路選択。
- `src/route-execution-plan.mjs`：サービス依存とトランスポート。
- `src/api-forwarder.mjs`：API 認証とプロトコル準備。
- `src/litellm-config.mjs`：変換が必要なルート設定。
- `src/service-*.mjs`：各プラットフォームのユーザーサービス。

## プロバイダーやモデルの追加

1. `config/<vendor>/` に一意の小文字 ID、プロトコル、端点、認証元を登録します。
2. 公開モデルは `provider/model` slug と実際の上流 ID、コンテキスト、圧縮閾値、画像/推論機能を記述します。
3. 固有パラメーターは範囲を絞った request profile で処理します。
4. 経路、引数、認証の分離、キャンセル、ストリーミング、エラー状態をテストします。
5. 公式カタログからモデルを取得し、明示的に許可された分離環境でライブ互換性を確認します。
6. 検証後に `listed` を設定し、[プロバイダーガイド](PROVIDERS.md)と対応する言語文書を更新します。

## カタログ探索

`src/untrusted-model-discovery.mjs` が DNS、同一 origin のリダイレクト、サイズ、schema、認証スコープを確認します。発見結果は候補情報として扱い、アカウント/端点指紋付きで保存します。

PR では fixture を使います。許可された定期/手動監査は設定済みのプロバイダー secrets を使い、`provider-model-audit.json` を出力します。新候補は正式な機能検証を経て登録します。

## レジストリ規則

重複 ID、slug、gateway ID、認証不足、表示メタデータ不足を検証します。`listed: false` は呼び出せる非表示互換項目です。匿名の外部経路は許可済み公式端点と無料モデル規則、ローカル keyless はループバック条件に従います。

`serviceTiers` は上流で検証済みの値を登録します。手動追加の `--models` はほかの項目を保持して追加し、`--remove` で削除します。対話式選択ではコンテキスト、画像、推論設定を保存し、公開されたウィンドウを既定値の参考にします。

## テスト

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
```

UI 変更では Control Center の型確認、build、対応テストも実行します。macOS ネイティブ変更は実プラットフォームの Swift/widget テストで確認します。合成認証と厳格な mock 端点で上流モデル、引数、ヘッダーを検証します。

`bin/test-model PROVIDER/MODEL --live --yes` は実際の利用枠を使うため、タスクの明示的な許可に従って実行します。ソースと文書の変更はそれぞれの影響に合う確認を行います。

## 文書翻訳

ホームページと[ローカライズガイド](LOCALIZATION.md)の付属文書を三言語で用意します。自然言語を翻訳し、コマンド、環境変数、モデル ID、JSON/TOML キー、API 名を保持します。ページ追加時は言語ナビゲーションとリンク先も揃えます。
