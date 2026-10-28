# 文書と UI のローカライズ

[English](../LOCALIZATION.md) · [简体中文](../zh-CN/LOCALIZATION.md) · 日本語

## 文書

ホームページは `README.md`、`README.zh-CN.md`、`README.ja.md` を使います。付属の操作ガイドは `docs/`、`docs/zh-CN/`、`docs/ja/`、セキュリティ文書はルートの各言語ファイルに配置します。

各ページ上部に言語切り替えを設けます。変更時は同じ話題の操作手順と機能範囲を同期し、中国語と日本語のガイドは利用手順に沿って構成します。コマンド、モデル ID、環境変数、設定キー、引数値は保持します。ページ内 anchor と同じ言語へのリンクも確認します。

コード、レジストリ、過去の調査、変更履歴、ライセンスは各ソースファイルをリンクから参照します。

## Control Center の UI

英語がメッセージキーの元言語で、簡体字/繁体字中国語は個別の意味ベースの辞書を使います。日本語などは既存 overlay を使い、未翻訳のメッセージは UI のフォールバック規則に従います。

新しい完全なメッセージは `apps/control-center/src/locales/en.ts` に追加し、中国語の同じキーを更新します。日本語 overlay は `locales/overlays.ts`、言語一覧は `i18n.ts` にあります。

`t("section.intent", values)` で文全体を翻訳し、日付と数値は選択 locale で整形します。技術 ID、パス、コマンド、認証情報、未知の診断はそのまま扱い、挿入値はテキストとして処理します。

React context は `i18n-react.ts` に分離し、翻訳と整形は renderer から独立してテストできます。memo が生成する文面には言語変更の依存関係を含めます。

## ネイティブメニューとウィジェット

renderer は検証済み言語 ID を既存の信頼済み IPC で渡します。Swift は既存キーとリソース表を使い、`zh-Hans` と `zh-Hant` を個別に維持します。保存済みの設定値と旧 widget snapshot の意味を保ちます。

## 確認

```sh
npm run check
node --test test/chinese-i18n-contract.test.mjs
npm --prefix apps/control-center run check
npm --prefix apps/control-center run build
npm --prefix apps/control-center test
```

UI テストには対応するブラウザー依存関係を使い、macOS メニューと widget は実プラットフォームで検証します。文書だけの変更はリンク、anchor、文字コード、コマンドの一致、表示構造を確認します。
