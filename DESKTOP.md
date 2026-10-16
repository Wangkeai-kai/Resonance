# Resonance Windows 桌面版 v1.1.1

解压软件 ZIP 后，双击 Resonance.exe。必须保留同目录的资源和 DLL 文件。也可以运行 install.cmd，安装到当前用户目录并创建桌面快捷方式，见 docs/INSTALL.md。

模型和协作配置在「设置」集中管理。选择「对话」讨论需求，选择「交给总控」或「工作流」实际制作文件。错误卡显示中断原因和“继续未完成步骤”，确认后才继续，已完成步骤保留。

数据目录继续使用 `%APPDATA%\Gongming\workspace`，名称调整不会迁移或清除它。图片目录也属于备份的一部分。系统加密凭据同机通常可继续使用，跨电脑可能需要重填。关闭窗口会通知本应用的后台保存退出；不确定执行结果不会自动重放。

## 从源码构建

需要 Windows、Node.js 22+；真实项目协作需要 Git。Docker 只用于代码任务的受限容器测试。

```sh
npm install
npm run check
npm test
npm run desktop:package
```

默认输出到源码父目录的 Resonance-Desktop，入口 Resonance.exe。也可指定已有 Electron 44.7.0 运行时：

```sh
node scripts/package-desktop.mjs --runtime "你的 Electron dist 目录" --out "源码父目录下的新输出目录"
```

脚本仅复制公开应用文件，排除用户运行数据和依赖。保留 en-US / zh-CN / zh-TW locale 与 Electron 许可证文件。它不删除已有输出；使用新的输出目录避免旧文件残留。

Windows 沙盒需要公开程序目录具备 ALL APPLICATION PACKAGES 读取 / 执行权限；打包检查路径后通过 icacls 配置，仅应用于独立程序包，不处理用户数据或父目录，不关闭沙盒。

## 验证与诊断

GONGMING_DESKTOP_USER_DATA 可指定独立绝对数据目录，GONGMING_DESKTOP_SMOKE=1 可隐藏验证启动并自动退出；结果写入该目录的 desktop-smoke.json。请勿把测试数据目录设为日常目录。

诊断日志位于用户数据的 logs 目录，按固定事件字段记录并轮转，不直接保存 stderr、密钥、请求正文或路径。启动等待最长 90 秒。本机服务只绑定回环地址，端口占用时自动选择新端口。

本发行版未做代码签名，不含自动更新；安装脚本不等同于带签名安装器。macOS / Linux 发行包尚未完成验证。GitHub Actions 的手动构建工作流只产出附件供下载，不自动发布。
