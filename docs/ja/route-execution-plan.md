# 選択済みルートの実行計画

[English](../route-execution-plan.md) · [简体中文](../zh-CN/route-execution-plan.md) · 日本語

`createExecutionPlan` は読み込み済みレジストリと明示的な選択から、不変のサービス集合、ゲートウェイ要否、ルート指紋を作ります。モデル端点と検証済み上書きの優先順位は `providerForModel` で解決します。

| ルート | 下流サービス |
| --- | --- |
| 外部ルートに登録されていないネイティブ GPT | 外部下流なし |
| HTTP / WebSocket Responses | API 転送器 |
| Chat / Messages / Vertex | API 転送器とゲートウェイ |
| 対応する OAuth | 専用 OAuth listener とゲートウェイ |
| ネイティブ Ollama アダプター | Ollama listener とゲートウェイ |

呼び出せる非表示モデルと有効な generic 記述子も対象にします。表示設定や一時的な認証不足は、ルートのエラー報告に必要なサービスを変更しません。

読み取り専用の確認は次のとおりです。

```sh
node src/runtime-dependency-requirements.mjs
node src/runtime-dependency-requirements.mjs --gateway-required
```

一つ目は JSON のサービス計画、二つ目は `required` または `unused` を返します。指紋はルートと機能メタデータを対象とし、認証値、URL のパスワード、query、fragment を除外します。

起動、分配、ヘルス確認が計画を使います。インストール時の Python 準備は[互換レイヤー方針](compatibility-layer.md)に従います。確認コマンドはサービスや選択を変更しません。
