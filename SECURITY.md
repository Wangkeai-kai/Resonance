# 安全问题报告

请勿在公开 Issue 中粘贴 API Key、授权 token、真实聊天、运行目录或完整审计日志。报告时使用脱敏的复现步骤和最小样例。

仓库所有者创建 GitHub 仓库后，应启用 Private vulnerability reporting，再通过仓库的 **Security → Report a vulnerability** 私下报告漏洞。如果该入口未启用，请先通过仓库所有者公开提供的联系方式确认私密报告渠道；本文件不虚构维护者邮箱。

当前应用处于本地预览阶段。服务仅供回环地址使用，不应直接暴露到公网；打包文件没有代码签名或自动更新机制。

凭据若意外进入 Git 历史，应先撤销并轮换，再清理历史。删除工作区文件或添加 `.gitignore` 不会撤销已泄露的凭据。更多发布检查见 [GITHUB-PUBLISH.md](GITHUB-PUBLISH.md)。
