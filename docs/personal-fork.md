# 个人 fork 的维护与恢复

本次维护版本为 `personal/v0.6.0-r4`，采用上游提交
`00eed6eb9f894a734eb51bb2e2b058575c6dca7a` 的全部运行时代码、测试、技能和依赖。
版本号仍为上游的 `0.6.0`；个人标签标识经过审核的具体提交，不表示官方新发布。

## 分支与历史

| 名称 | 用途 |
| --- | --- |
| `origin` | `https://github.com/TruthNian/codex-router.git` |
| `upstream` | `https://github.com/duolahypercho/codex-router.git` |
| `main` | 官方主线的同步副本 |
| `personal` | 安装来源；运行时代码与采用的官方提交一致，只增加维护文档和本机状态排除规则 |
| `personal/v0.6.0-r1` 至 `r3` | 旧定制实现的不可变恢复标签 |
| `personal/v0.6.0-r4` | 上游整合版本；旧个人提交作为合并祖先保留 |

合并记录有上游和旧个人分支两个父提交。此次保留上游的运行时树，不叠加旧补丁。
已发布标签不移动，不覆盖；后续更新建立新标签。

## 已由上游承担的行为

| 原定制 | 采用的上游实现 |
| --- | --- |
| 每个自定义模型选择端点协议 | #984，保留各模型的 `endpoint.protocol` 配置 |
| 当前 CUA 工具入口与技能 | #987，采用上游技能包 |
| 目录 watcher 生命周期 | #985，启动检查与关闭清理 |
| 目录检查频率 | #996，使用服务环境变量配置 |
| 自动目标继续无进展保护 | #998，按模型显式开启 |
| GLM-5.3 重复输出保护 | #999，经 #1000 纳入上游，按模型显式开启 |
| Windows 冷启动进程身份、ACL、VBScript 引擎 | 上游已有对应修复与回归测试 |
| 原生 Responses 推理分离、仅完成事件返回正文或拒绝 | 采用上游路由和空响应处理 |

两个保护默认关闭。本机 curated GLM-5.3 模型使用：

```json
{
  "goalContinuationGuard": true,
  "repetitionGuard": true
}
```

将字段放在对应 `user-models.json` 模型条目上，不改变其端点、密钥、预算或推理设置。
checked-in 模型需要使用 `MODEL_ROUTER_REGISTRY` override，重复的用户条目不能覆盖它。
更保守的上游保护排除结构化输出、代码、工具与推理；它不复刻旧保护的全部启发式。
空响应和缺失 terminal 使用上游原有处理，不额外恢复旧强制拒绝逻辑。

旧 `generation-safety.mjs` 及其历史清理功能已移除。旧逻辑发现一条损坏正文后
可能丢弃其他健康助手上下文，不能直接重新移植。旧代码仍保存在 r1–r3 标签中。

## 本机偏好与部署

每天检查目录的设置是 `CODEX_ROUTER_NATIVE_CATALOG_POLL_INTERVAL_MS=86400000`。
启动检查与手动刷新仍然保留。该值应同时存在于 Windows 用户环境和服务启动脚本中；
重新安装或 repair 时确认安装进程取得此变量，不能只依赖旧代码中硬编码的频率。
上游未设置此变量时默认五分钟。

保持原稳定安装路径、共享状态目录和同名计划任务。账号、密钥、模型选择及
其他 Codex 设置属于本机状态，不提交到 Git。升级前为状态、技能、任务、依赖
与旧提交建立私有恢复快照；Git 切回旧提交本身不能回退 Python/Node 依赖。

后续更新先在独立工作树中采用指定上游提交，审核差异并运行隔离测试。
验证后快进 `personal`、创建新标签，再部署。本机偏好继续使用官方配置入口；
仅在上游没有覆盖实际问题时才新增代码补丁。

取回源码：

```powershell
git clone --branch personal https://github.com/TruthNian/codex-router.git codex-router-personal
git -C codex-router-personal remote add upstream https://github.com/duolahypercho/codex-router.git
git -C codex-router-personal fetch origin tag personal/v0.6.0-r4
```

这不会恢复本机账号、密钥或服务。部署与回退都应先备份后来新增的配置。
