# 安装、迁移与更新

[English](../INSTALL.md) · 简体中文 · [日本語](../ja/INSTALL.md)

本指南以 Codex 接入为例。其他客户端共用 Router 服务和供应商凭据；接入方式见[客户端指南](COMPATIBLE-APPS.md)。

## 环境要求

macOS、Windows 支持 Codex App 和 CLI；Linux 支持 CLI。需要 Node.js 22.19+、Git，以及所选供应商的账户权限。建议使用受维护的 Node.js 24 LTS。

默认开启兼容层的源码安装需要 `uv` 或带 `venv` 的 Python 3.10+。[停用兼容层](compatibility-layer.md)后，安装和强制依赖修复均跳过 Python。运行时按路由决定是否启动网关。Homebrew 的 Python 依赖由包管理器负责。

Windows 需要 PowerShell `FullLanguage` 模式及允许 `Add-Type` 的系统策略。macOS 桌面配套应用需要完整 Xcode；安装器读取 `DEVELOPER_DIR`，也会查找 `/Applications/Xcode.app` 或 `Xcode-beta.app`。

## 引导式安装

macOS/Linux 在终端执行：

```sh
curl -fsSL https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.sh \
  | sh -s -- --target codex --guided --with-tray
```

Windows 在 PowerShell 执行：

```powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/duolahypercho/codex-router/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target codex -Guided -WithTray
```

如需先阅读脚本，克隆仓库后运行 `./install.sh --target codex --guided --with-tray`；Windows 使用 `./install.ps1 -Target codex -Guided -WithTray`。只安装 Router 时，用 `--no-tray` 或 `-NoTray` 替换托盘参数。

引导流程依次选择供应商、识别已有认证、输入缺少的凭据、展示变更摘要，然后安装服务。macOS 缺少完整 Xcode 时，会跳过桌面应用并显示说明。

<a id="homebrew-router-and-cli-only"></a>

## Homebrew

Homebrew 安装 Router 与 CLI。需要桌面配套应用时使用上面的源码安装方式。

```sh
brew tap duolahypercho/codex-router https://github.com/duolahypercho/codex-router
brew install codex-router
codex-router setup --guided
```

源码文档中的 `./bin/model-router codex COMMAND` 或 `./bin/COMMAND`，在 Homebrew 下使用 `codex-router COMMAND`。添加模型使用 `codex-router curate-models PROVIDER`。更新与删除：

```sh
brew upgrade codex-router
codex-router uninstall
brew uninstall codex-router
```

## 供应商认证

在本机隐藏输入提示中保存 API 密钥；再次执行 `set` 可替换，`remove` 可移除 Router 保存的密钥。后台服务通过受保护的凭据文件读取密钥。供应商、地区和订阅的关系见[供应商指南](PROVIDERS.md)。

```sh
./bin/model-router codex provider-key deepseek set
./bin/model-router codex provider-key deepseek remove
```

Windows 将 `./bin/model-router codex` 替换为 `.\model-router.ps1 codex`。Kimi/Grok OAuth 通过相应官方 CLI 登录；Antigravity 需要自己的 OAuth 客户端、已获准访问私有 API 的项目和显式实时探测。

`--smoke-test` 会向所选供应商发送实际请求并使用额度。请按需显式启用。

## 出站代理

运行安装前设置 `NODE_USE_ENV_PROXY=1` 和 `http_proxy` / `https_proxy` / `no_proxy`，大写形式也可。`no_proxy` 包含 `localhost,127.0.0.1,::1`，让内部通信走回环。支持的 Node 版本也可用 `--use-env-proxy`。

安装器把这些设置保留到后台服务。修改后重新运行安装器以刷新服务定义。`ALL_PROXY` 可传给支持它的子进程；Router 的 Undici 出站代理使用 HTTP/HTTPS 代理变量。

GUI 应用需要从启动环境或系统代理绕过列表获得回环例外。若 GUI 失败但终端正常、Router 没收到请求，检查这项配置。macOS 可为当前登录会话设置：

```sh
launchctl setenv NO_PROXY "localhost,127.0.0.1,::1"
```

随后完全退出并重新打开客户端。此设置持续到退出登录；需要持久化时可通过自己的登录代理设置。

## 安装事务与迁移

安装器验证选择与已有状态、准备依赖、生成独立的本地调用密钥与内部密钥、发布模型和客户端配置、安装用户级服务并检查健康状态。Codex 配置使用 Router 标记块，保留原有模型、配置档和登录。未配置代理并发限制时会写入受管理的默认值。

安装失败时按事务状态恢复；已注册但仍在启动或冷却中的服务会保留，并报告临时失败。更新恢复若也失败，会同时报告原始错误与恢复错误。

旧版迁移先识别已知安装，再保存对应配置与服务信息。查看及回退旧版迁移：

```sh
./bin/migrate detect
./bin/migrate rollback
```

如需保留自己维护的原生模型目录，可显式使用 `--adopt-native-catalog` / `-AdoptNativeCatalog`；需要绝对路径、有效原生模型以及可识别的配置归属。

<a id="credential-free-idle-install"></a>

## 无凭据空闲安装

验证安装生命周期时可以选择空闲模式：

```sh
./install.sh --target codex --no-provider --no-discovery --no-tray
```

```powershell
./install.ps1 -Target codex -NoProvider -NoDiscovery -NoTray
```

`--no-provider` 保存空供应商选择；加上 `--no-discovery` 后，认证发现被停用，菜单为空，模型请求返回本地 `503 router_idle_no_provider`。按普通方式重新运行设置可恢复发现。

## 重启与诊断

Codex 在启动时载入模型目录。完全退出并重新打开，创建新任务，再运行诊断：

```sh
./bin/model-router codex doctor
./bin/model-router codex status
```

macOS/Linux CLI 可显式安装 `./bin/model-router codex shim install`，在启动 Codex 前等待 Router；`shim status` 检查是否生效，`shim uninstall` 移除。

<a id="update-and-rollback"></a>

## 更新与回退

先选择没有活跃对话的时段。以下命令在已安装源码目录执行：

```sh
./bin/model-router codex update check
./bin/model-router codex update
./bin/model-router codex rollback
```

`update check` 获取远端 Git 元数据并比较版本。更新要求可识别的受管理仓库；替换源码前检查已跟踪文件修改，显式 `--force` 会丢弃这些修改。未跟踪文件保留。

管理更新命令保存前一源码版本并重新安装。安装失败时会尝试重新安装旧版本，错误中会给出恢复结果。回退后可能处于 detached HEAD，下一次更新回到 `main`。手动 `git pull` 后也应运行更新命令，让服务与源码一致。

源码 bootstrap 安装器在拉取源码后运行引导设置。设置退出码为 2 时（例如尚未提供凭据或取消提示），保留已更新的源码，随后重新运行设置以完成配置。其他设置失败在存在旧版本时恢复旧源码，并留下 detached HEAD；下次运行 bootstrap 安装器会在获取更新前切回 `main`。需要主动回到旧版本时使用回退命令。

`doctor --fix` 修复源码安装的依赖和配置；Homebrew 的损坏包文件通过 `brew reinstall codex-router` 修复。源码压缩包安装通过新的版本归档更新。

## 停用与卸载

`disable` 移除选定客户端接入，`enable` 重新启用，`uninstall` 移除接入和不再被使用的共享服务。认证信息、日志、回退和迁移数据保留在状态目录。

```sh
./bin/model-router codex disable
./bin/model-router codex enable
./bin/model-router codex uninstall
```
