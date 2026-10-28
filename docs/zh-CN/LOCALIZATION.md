# 文档与界面本地化

[English](../LOCALIZATION.md) · 简体中文 · [日本語](../ja/LOCALIZATION.md)

## 文档

首页使用 `README.md`、`README.zh-CN.md`、`README.ja.md`。配套操作指南分别位于 `docs/`、`docs/zh-CN/`、`docs/ja/`，安全说明使用根目录的对应语言文件。

每个页面顶部提供语言切换。更新内容时同步对应主题的操作步骤和功能边界；中文和日文指南按使用流程组织。命令、模型 ID、环境变量、配置键及参数值保持原样。页内锚点和同语言页面链接一并检查。

代码、注册表、历史研究、版本日志和许可证保留各自的源文件，通过链接查阅。

## 控制中心界面

英文是消息键的源语言，简体与繁体中文使用独立语义消息目录。日文等语言使用现有 overlay，缺少的消息按界面回退规则显示。

新增完整消息放入 `apps/control-center/src/locales/en.ts`，简繁中文同步对应键；日文 overlay 位于 `locales/overlays.ts`。语言列表在 `i18n.ts` 中维护。

使用 `t("section.intent", values)` 翻译完整句子，日期和数字按选择的 locale 格式化。技术 ID、路径、命令、凭据及未知诊断保持原样；插入参数作为文本处理。

React 上下文位于 `i18n-react.ts`；纯翻译与格式化逻辑可独立于 renderer 测试。语言变更涉及 memo 的文本时，更新其依赖。

## 原生菜单与小组件

renderer 通过现有受信任 IPC 传递校验过的语言标识。原生 Swift 文案使用现有消息键和资源表，`zh-Hans` 与 `zh-Hant` 分别维护。保留原有偏好值和旧 widget 快照的含义。

## 验证

```sh
npm run check
node --test test/chinese-i18n-contract.test.mjs
npm --prefix apps/control-center run check
npm --prefix apps/control-center run build
npm --prefix apps/control-center test
```

界面测试需要对应的浏览器依赖；macOS 原生菜单与 widget 在真实平台验证。纯文档更改检查链接、锚点、编码、命令一致性及版面。
