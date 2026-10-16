# 安装 Resonance

Windows 桌面包提供两种方式：解压后双击 Resonance.exe；或者运行 install.cmd，复制到当前用户的 `%LOCALAPPDATA%\Programs\Resonance\版本号` 并创建桌面快捷方式。

脚本不下载或启动软件，不需管理员权限。它先检查版本、入口校验值、目录范围和符号链接；已有同版本目录不会覆盖。它不递归删除文件、不清理旧版本、不终止进程。失败时保留新目录便于检查。

会话和凭据仍使用 `%APPDATA%\Gongming`，保持兼容。更新前正常退出并备份完整目录，安装脚本不会修改用户数据。

项目没有应用代码签名或自动更新，脚本不是带签名的商业安装器。可以运行 `powershell -NoProfile -File .\install.ps1 -ValidateOnly` 只检查路径，不写程序目录或快捷方式。
