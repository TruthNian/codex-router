# 开发指南

[English](../DEVELOPMENT.md) · 简体中文 · [日本語](../ja/DEVELOPMENT.md)

## 代码结构

- `config/`：供应商与模型注册表。
- `src/model-registry.mjs`：验证、索引与本机覆层。
- `src/catalog.mjs`：合并原生和外部目录。
- `src/router.mjs`：认证和模型路由。
- `src/route-execution-plan.mjs`：服务依赖与传输路径。
- `src/api-forwarder.mjs`：API 凭据与协议准备。
- `src/litellm-config.mjs`：需要转换的路由配置。
- `src/service-*.mjs`：各平台用户级服务。

## 增加供应商或模型

1. 在 `config/<vendor>/` 注册唯一小写 ID、协议、端点和凭据来源。
2. 公共模型使用 `provider/model` slug，填写真实上游 ID、上下文、压缩阈值、图片和推理能力。
3. 供应商特有参数使用窄范围 request profile。
4. 覆盖路由、参数、凭据隔离、取消、流式输出及错误状态测试。
5. 从官方目录发现模型；在明确授权的隔离环境进行实际兼容性测试。
6. 验证后设置 `listed`，更新[供应商指南](PROVIDERS.md)及对应语言文档。

## 目录发现

`src/untrusted-model-discovery.mjs` 管理 DNS、同源重定向、大小、schema 和凭据范围校验。发现结果用作候选信息，保存时带账户与端点指纹。

CI 的 fixture 路径用于 PR。授权的周期/手动审计使用仓库配置的供应商 secrets，输出 `provider-model-audit.json`；新增候选按正式能力验证流程进入注册表。

## 注册表规则

验证器检查重复 ID、slug、gateway ID、缺少认证和不完整的显示元数据。`listed: false` 用于可调用但隐藏的兼容条目。匿名远端使用已允许的官方端点和免费型号策略；本地 keyless 端点遵循回环约束。

`serviceTiers` 只登记上游已验证支持的值。手动模型的 `--models` 以追加方式保留其他条目；`--remove` 明确移除。交互式选择保存上下文、图片与推理配置，供应商公开的窗口作为默认参考。

## 测试

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
```

变更涉及界面时，同时运行控制中心的 type check、build 和对应测试；macOS 原生变更在真实平台执行 Swift 与 widget 测试。使用合成凭据和严格 mock 端点检查实际上游模型、参数及头部。

`bin/test-model PROVIDER/MODEL --live --yes` 会使用真实额度，按任务明确授权执行。源码修改与文档修改采用对应风险的验证。

## 文档翻译

首页及[本地化指南](LOCALIZATION.md)中的配套文档提供三种语言。翻译自然语言，保留命令、环境变量、模型 ID、JSON/TOML 键和 API 名；新增页面时补齐语言导航及目标链接。
