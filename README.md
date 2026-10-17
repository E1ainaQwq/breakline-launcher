# Breakline Launcher · 断界启动器

Electron + React + TypeScript 的断界游戏启动器源码，包括账号界面、游戏启动、整合包校验与增量下载、资源清单签名验证、自身更新、反作弊状态面板，以及 Windows 内存辅助程序和 Linux 命令行预览版。

## 源码版本

从当前工作目录整理的源码快照，`package.json` 版本为 **0.3.54**。工作目录可能包含尚未发布的改动；公开源码不等于重新发布正式客户端，也不保证字节级重现已分发的 0.3.54 程序。此次仅上传源码，不改线上启动器更新源。

## 开发与构建

需要 Node.js 22+、npm；Windows 打包使用 electron-builder。Forge 加载画面组件还需要 Java 17 JDK 和已有 Minecraft/Forge 运行库。

```sh
npm ci
npm run typecheck
npm run build
npm run dev
```

`npm run build` 生成 Electron 的主进程、preload 与 renderer；不需要生产密钥。运行游戏还需要合法的游戏账号、完整运行库、整合包以及对应服务端接口。

Windows portable 打包前准备：

1. 核对 `config/launch.json` 的实例、更新源、游戏目录等设置。示例账号字段已替换，不含登录会话；OAuth Client ID 与签名验证公钥是公开客户端配置，不是私钥。
2. 按原作者许可证自行准备 authlib-injector 1.2.8 到 `config/authlib-injector-1.2.8.jar`。项目地址：[authlib-injector](https://github.com/yushijinhun/authlib-injector)。游戏/Forge/第三方运行库 JAR 不放在本仓库。
3. 使用已有 Minecraft `libraries` 目录构建自定义 Forge 加载画面：

```powershell
$env:JAVA_HOME='C:\Program Files\Java\jdk-17'
powershell -NoProfile -File bootstrap/build.ps1 -Libraries 'D:\Minecraft\libraries'
npm run dist:portable
```

`bootstrap/assets/delta-loading.png` 为启动器加载画面；可以传 `-Artwork` 使用自有图片。可选启动视频自行放入 `resources/media/ac-startup.mp4`。Windows 内存辅助程序的 C# 源码与 manifest 位于 `build/memory-cleanup/`；仓库包含当前 4 KiB 辅助程序，以匹配主进程固定的 SHA-256。重新编译后须同步核对主进程与测试中的允许哈希，再进行发布验收。

## 测试

```sh
npm run test:security
npm run test:device
npm run test:monitor
npm run test:memory-cleanup
npm run test:cosmetics
npm run test:resources
node tools/low-memory-mode-test.cjs
```

资源下载测试使用临时目录、本机 HTTP 服务和临时签名密钥；部分资源 ZIP 测试依赖 Windows PowerShell。构建和自动测试不能替代真实打包、启动游戏与线上更新验收。

## Linux 预览版

```sh
node linux/build.cjs
node linux/dist/runtime.test.cjs
node linux/dist/auth-timeout.test.cjs
sh linux/start.sh
```

Linux 目录是独立命令行预览入口，依赖已有客户端与运行库；不代表 Windows 图形版的完整功能已在 Linux 验证。

## 目录

- `src/main`：账号、游戏进程、目录解析、下载、签名验证、更新与监控。
- `src/preload`：受限 IPC 桥。
- `src/renderer`：React 界面与品牌素材。
- `bootstrap/src`：Forge 加载画面 Java 服务提供者。
- `build/memory-cleanup`：固定功能的 Windows C# 辅助程序。
- `tools`：隔离测试与本地辅助程序构建脚本。
- `config`：已去除个人账号字段的出厂模板、运行库锁定和公开整合包清单。

## 公开范围与版权

不包含签名私钥、服务令牌、玩家数据、登录缓存、运维部署脚本、旧备份、游戏整包、服务器或反作弊模组源码。清单中的 SHA-256 与验证公钥保留，它们用于验证公开资源。第三方依赖遵循各自许可证；游戏及第三方资源不因本仓库公开而获得额外授权。未另行授予本项目原创代码与品牌素材的许可证。
