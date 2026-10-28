# 验证 Devin CLI 接入

[English](../DEVIN-CLI-PROBE.md) · 简体中文 · [日本語](../ja/DEVIN-CLI-PROBE.md)

探测使用已安装官方 Devin CLI 的账户会话，检查 Cascade 请求编码、账户目录、流分帧和工具结果。先安装官方 CLI 并运行 `devin auth login`，再从 Router 源码目录执行。

## 探测命令

默认命令读取会话与账户模型目录。`--live` 发送一个短推理请求并使用 ACU 额度，默认输出上限 64 token、截止 90 秒。`--tools` 强制测试一个小工具；`--model UID` 选择目录中的具体模型，`--json` 输出结构化报告。

```sh
./bin/devin-probe
./bin/devin-probe --live --tools
./bin/devin-probe --model UID --json
```

## 结果

`PASS` 表示该检查成立，`FAIL` 表示失败，`SKIP` 表示未执行，`PARTIAL` 表示已执行项通过但仍有未测项，`INCONCLUSIVE` 表示信息不足。

编码或模型列表失败时检查 CLI 版本、认证与账户权限。分帧、流完整性、终止符、输出或工具 ID 失败时，保留对应检查报告定位真实协议差异。`transport replay` 检查已捕获数据经过实际传输解析器时是否一致。

小工具探测的结论只覆盖该请求。完整 Codex 请求的工具描述、MCP 内容、上下文和供应商内容策略，应在目标工作负载中继续验证。
