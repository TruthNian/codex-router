# macOS 菜单栏、控制中心与小组件

[English](../MACOS-TRAY.md) · 简体中文 · [日本語](../ja/MACOS-TRAY.md)

菜单栏宿主使用原生 Swift UI，控制中心内嵌 Electron。打开 `~/Applications/Codex Router.app` 或从 Spotlight 搜索即可显示控制中心；关闭窗口后从菜单栏再次打开。

## 安装与重新构建

从长期保留的源码目录执行：

```sh
./bin/model-router-tray
```

命令先构建并验证暂存应用，再安装到用户 Applications，注册 launchd。源码路径随本地构建记录，移动目录后重新构建。构建需要完整 Xcode；可用 `DEVELOPER_DIR` 指定位置。

## 小组件与 Island

菜单栏 **Settings → Dynamic Island** 可启用顶部活动浮层，选择 **Desktop** 可使用可移动桌面面板。这里的桌面面板由 Router 应用提供。菜单栏仍用于完整供应商视图和设置。

## 随登录和 Codex 显示

launchd 在登录时启动原生宿主，并处理异常退出。**Always** 持续显示；**With Codex** 随 Codex/ChatGPT 显示，两个应用关闭并经过等待、活动请求结束后停止相关服务。CLI 或 Harness 等持续使用者会影响实际采用的 presence 模式，状态页面显示有效模式。

## 菜单栏外观

Settings 的 **Menu bar** 可选择标准文字或图标模式、是否显示模型名称、Router/供应商/指示点/SF Symbols/自定义图标。部分偏好可通过 macOS defaults 设置：

```sh
defaults write io.github.codex-router.tray ModelRouterTray.menuBarDisplayMode iconOnly
```

## 供应商与维护

Providers 页可添加 API 密钥、替换或移除密钥，OAuth 供应商可安装官方 CLI 和登录。修改选择时显示应用进度，失败时报告错误并按事务恢复。

**Update & Verify** 在安装归属目录应用版本并运行诊断；完成后重启 Codex 加载新模型和代理。免登录模式需要至少一个已连接且启用的外部供应商，切换会按界面流程请求重启 Codex。

使用量卡片以供应商公开的额度和 Router 观测量为来源，实际账户账单通过对应供应商控制台确认。

## 签名发布包

预构建 `model-router-<version>-macos-universal.zip` 的下载使用源码固定的签名团队和仓库信任设置。安装前验证校验和、包布局、Developer ID 与 Gatekeeper，再比对源码元数据。

发布包缺失、网络失败或源码不匹配时，可按支持的回退路径进行本地构建。完整 Xcode 的选择方法见[安装指南](INSTALL.md)。
