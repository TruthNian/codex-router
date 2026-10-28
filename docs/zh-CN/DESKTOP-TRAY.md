# 桌面托盘与控制中心

[English](../DESKTOP-TRAY.md) · 简体中文 · [日本語](../ja/DESKTOP-TRAY.md)

桌面应用复用同一 Router 控制平面，连接、模型显示、用量与 CLI 保持一致。

## 各平台行为

| 平台 | 托盘与窗口 |
| --- | --- |
| macOS 13+ | Swift 原生菜单栏宿主，内嵌 Electron 控制中心 |
| Windows 10/11 | Electron 托盘和窗口 |
| Linux | Electron 窗口；存在 StatusNotifier host 时支持可恢复的托盘模式 |

有可用托盘时，关闭窗口会保留托盘；从托盘重新打开。Linux 缺少已确认的托盘宿主时会保留可见窗口，关闭该窗口会退出。

## 页面

- **Dashboard / Status**：健康状态、当前模型、活动请求、耗时和速率。
- **Usage**：7/30/90 日 token 趋势、模型和供应商统计、账户公开的配额及重置时间。
- **Connections**：账户、API 密钥、登录模式、更新和修复。
- **Models**：按模型家族选择具体路由、显示与已验证的子代理能力。
- **Local LLMs**：目录、内存适配、下载、取消、移除和基准测试。
- **Vision bridge**：图片读取引擎、推理档位与本机模型选择。

供应商没有公开余额或 token 明细时，页面显示 Router 观测流量。

## 打开浏览器面板

面板地址包含本机调用凭据，分享前遮蔽完整路径。浏览器面板用于只读查看；凭据编辑通过桌面或本地 CLI 完成。

```sh
./bin/panel
```

```powershell
.\codex-router.ps1 panel
```

## 构建与登录启动

macOS/Linux 从稳定源码目录运行：

```sh
./bin/model-router-tray
```

Windows 构建并注册登录任务：

```powershell
.\install.ps1 -CheckoutInstall -WithTray
.\codex-router.ps1 tray status
.\codex-router.ps1 tray start
.\codex-router.ps1 tray stop
.\codex-router.ps1 tray restart
```

Windows 的应用托盘任务和 Router 服务任务分别管理。主动 Quit 会退出应用，下一次登录再启动。Linux 可从 `model-router-tray` 启动，并遵循桌面环境的托盘支持。macOS 由 launchd 管理，详见[macOS 指南](MACOS-TRAY.md)。

## 发布包

[版本页面](https://github.com/duolahypercho/codex-router/releases)提供源码、校验和及可用的桌面包。Windows/Linux 桌面包使用匹配的 Router 版本；Linux 先解开归档，再运行其中保留执行权限的 AppImage。

macOS 的预构建包按固定 Developer ID、校验和、Gatekeeper 及源码指纹检查。签名包不可用或源码不匹配时，支持的路径会转向本地 Xcode 构建。CI 产物对应其构建提交，用于验证该版本。

## 凭据与设置

API 密钥在本地安全输入框输入并通过标准输入传给控制进程。模型和供应商选择共用状态；需要客户端重新加载目录的更改完成后，完全退出并重新打开客户端。
