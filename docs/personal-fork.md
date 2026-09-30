# 个人定制分支的维护与恢复

此 fork 用来长期保存已验证的 Codex Router 定制。当前运行代码基于上游
`v0.6.0`（`930f547d8d8861a47e18a83216e15e73a73aa97c`），定制实现提交为
`2771abe6b93e3110a2e0079db413d60451970307`。当前维护版本为
`personal/v0.6.0-r2`，在原定制上选择性移植目录刷新与 Windows 启动修复。

## 分支与远程

| 名称 | 用途 |
| --- | --- |
| `origin` | `https://github.com/TruthNian/codex-router.git`，保存个人分支和版本标签 |
| `upstream` | `https://github.com/duolahypercho/codex-router.git`，读取官方更新 |
| `main` | 上游主线的同步副本，不放个人补丁；本次创建 fork 时同步，之后按需同步 |
| `personal` | 默认分支和个人安装来源，保留定制实现、回归测试及维护记录 |
| `personal/v0.6.0-r1` | 2026-09-23 保存的原定制版本，继续保留用于恢复 |
| `personal/v0.6.0-r2` | 2026-09-30 维护版本，增加周期目录刷新和 Windows 启动修复 |

版本标签发布后不移动、不覆盖；新的修改使用新的标签，例如
`personal/v0.6.0-r3`。GitHub 页面默认展示 `personal`，避免把上游主线误当作
包含个人补丁的版本。

## 需要保留的定制

| 定制 | 主要文件与验证 |
| --- | --- |
| 每个自定义模型单独选择 Chat、Messages 或原生 Responses 协议 | `src/model-registry.mjs`、`test/custom-protocol.test.mjs` |
| 原生 Responses 的 reasoning 与普通助手正文分离 | `src/router.mjs`、`test/empty-completion-router.test.mjs` |
| GLM 重复生成、空响应、异常终止、损坏历史和重复目标续跑保护 | `src/generation-safety.mjs`、`test/generation-safety.test.mjs` |
| 兼容仅在完成事件里返回的答案或拒绝，避免误判为空响应 | `test/empty-completion-router.test.mjs` |
| 当前 CUA 工具入口和浏览器使用说明，保留上游任务等待规则 | 三个 Router/CUA 技能及 `test/skills-install.test.mjs` |

GLM 保护的范围、误报边界及跨模型故障转移限制见
[generation recovery](glm-generation-safety.md)。升级时逐项比较上游行为；只有
上游覆盖同一问题并通过对应回归，才移除重复补丁。

## 取回代码

下面只恢复源码，不安装服务，也不恢复账号或密钥：

```powershell
git clone --branch personal https://github.com/TruthNian/codex-router.git codex-router-personal
git -C codex-router-personal remote add upstream https://github.com/duolahypercho/codex-router.git
git -C codex-router-personal fetch origin tag personal/v0.6.0-r2
git -C codex-router-personal show --no-patch personal/v0.6.0-r2
```

需要恢复特定版本时，在独立 checkout 中从该标签创建恢复分支，再按仓库安装
说明部署。先保留现有安装和本机配置备份，不要在正在运行的源码目录里直接切换
到未经验证的版本。

Windows 上须先确认计划任务能读取安装目录并运行其中的 Node/Python 依赖。
打包版 Codex 中可见的 `%LOCALAPPDATA%` 路径可能与计划任务看到的目录不同；
本次已使用原 Router 安装旁的持久目录解决这一差异。不要从临时目录安装服务。

## 跟进上游

1. `git fetch upstream --tags`，选择要采用的稳定版本。
2. 从 `personal` 创建独立工作树和更新分支，在那里合并选定的上游版本。
3. 检查上述定制及接口变化，解决冲突，移除已经由上游覆盖的补丁。
4. 在隔离的 `CODEX_HOME` 和临时用户目录里运行相关测试及 `npm run check`。
   不要用全局 `MODEL_ROUTER_STATE_DIR` 覆盖测试自己设置的状态目录。
5. 验证后合入 `personal`，推送分支并创建新版本标签；部署前保留旧安装和本机
   状态备份，部署后检查服务健康、模型目录和托管技能。
6. `main` 可以单独同步官方主线；这个操作不会自动更新 `personal`。

上游普通更新器要求当前分支是 `main`。个人安装保持在 `personal`，使用上述
审核、测试、部署流程；不要为了通过更新器检查而把安装目录切回官方 `main`。
需要运行 checkout 安装器时使用 `-CheckoutInstall`，并遵循仓库的安装说明。

## 已有验证记录

2026-09-23 对实现提交 `2771abe6` 完成了以下本地验证：

- 核心协议、GLM、推理和 DeepSeek 路由组：99 通过、1 跳过。
- 路由、故障转移、命名空间、技能安装、目录刷新组：343 通过、4 跳过。
- 安装脚本、依赖计划、DeepSeek Flash 配置组：45 通过、8 跳过。
- 用实际 LiteLLM 1.96.0 补测离线推理回传：4 通过，包含核心组原先跳过的项；
  该组与核心组存在重叠，不能简单相加。
- 语法检查、安装后的 `doctor`、服务健康及新模型目录检查通过。

完整仓库测试未全部通过：Windows 账户切换故障恢复测试超时，符号链接测试
遇到 `EPERM`，后续停止了全套运行。上述记录不代表全仓测试通过，也不代表
已进行真实付费模型生成或真实浏览器端到端操作。

2026-09-23 创建 fork 时仅增加 README、忽略规则和本维护说明，没有改变上述运行代码。

## 2026-09-30 维护版本

`r2` 继续基于 v0.6.0，没有合并整个上游主线，也没有改变 Node/Python 依赖锁。
以下上游提交通过带来源记录的 cherry-pick 移植：

| 上游提交 | 行为 |
| --- | --- |
| `9b3441997374d1cdd67dd85063465834658185cb` | 服务运行时每五分钟刷新原生账户模型目录，有差异才重新发布；已打开的 Codex 仍需重启才能读取新列表 |
| `c089d403bae613694e02fdc93d72a51a31c773fd` | Windows 启动记录的进程探测允许每次 45 秒、超时后重试一次；停止和归属校验仍使用原来的短预算 |
| `6d45084564ae09473a8bf540ff9457fed198e526` | 补齐冷启动预算说明和变更记录 |
| `259a04c715c75ce753c45c56012a618c0aa7091c` | 计划任务显式传入 `//E:VBScript`，避免脚本文件关联影响启动 |

仅不含凭据的 `service-process.json` 在额外 ACL 加固失败时允许告警并继续，
仍继承状态目录权限；凭据写入继续在加固失败时终止。进程停止前仍验证 PID 的
启动身份、命令行、源码目录及状态目录。

原有每模型协议、Responses 推理分离、GLM 生成保护和当前 CUA 技能全部保留。
上游 `b6bb8cf761297314684e42c951627906d8633dfa` 已实现等效的推理分离，
但它未包含在本次选择性移植中；未来整合主线时再移除重复实现。

移植时补齐目录观察器的生命周期：关闭服务时清理定时器，后台定时器不阻止
进程退出，启动时的首次刷新与周期刷新共用互斥状态，停止后不执行排队的回调。

本次隔离验证：核心协议和 GLM 回归 100 通过；启动、进程身份、文件权限和安装
相关测试 90 通过、28 个按平台跳过；目录发布和技能测试 149 通过、4 跳过；
最后的观察器与启动清理测试 5 通过。各组存在重复，不能直接相加。
Node 语法检查通过。未运行全仓测试，也未额外发起真实付费模型生成。

## 源码与本机状态分别保存

此仓库公开，只保存源码、测试和文档。认证文件、API 密钥、模型端点配置、运行
日志、使用记录和配置备份继续留在本机或私密备份中。`.gitignore` 防止常见状态
文件被误加入，但不能移除已经进入 Git 历史的内容；推送前仍须检查提交范围。

fork 能恢复代码，不能代替本机配置和凭据的私密备份。无需把运行目录整体上传。
