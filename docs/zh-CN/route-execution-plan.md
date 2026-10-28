# 所选路由的执行计划

[English](../route-execution-plan.md) · 简体中文 · [日本語](../ja/route-execution-plan.md)

`createExecutionPlan` 将已加载注册表与明确的供应商选择编译为不可变服务集合、网关需求和路由指纹。注册表的 `providerForModel` 负责单模型端点及已验证覆层的优先级。

| 路由 | 下游服务 |
| --- | --- |
| 未注册为外部路由的原生 GPT | 无外部下游 |
| HTTP / WebSocket Responses | API 转发器 |
| Chat / Messages / Vertex | API 转发器与网关 |
| 支持的 OAuth | 对应 OAuth listener 与网关 |
| 原生 Ollama 适配器 | Ollama listener 与网关 |

选择包含可调用的隐藏模型和启用的 generic 描述符。菜单可见性或暂缺凭据不改变路由错误报告所需的服务。

只读查询：

```sh
node src/runtime-dependency-requirements.mjs
node src/runtime-dependency-requirements.mjs --gateway-required
```

前者输出 JSON 服务计划，后者输出 `required` 或 `unused`。指纹覆盖路由和能力元数据，排除凭据值、URL 密码、查询与片段。

启动、分发和健康检查消费该计划。安装阶段的 Python 准备仍由[兼容层策略](compatibility-layer.md)决定；查询本身保留服务和选择状态。
