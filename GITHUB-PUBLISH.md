# 上传 Resonance 到 GitHub

这里只提供本地准备和操作步骤；软件不会替你发布仓库。

## 哪些文件上传

- 把 `Resonance-v1.1.1-GitHub-source.zip` 解压，里面的 README.md、package.json、dist、lib 等直接作为仓库根目录。
- `Resonance-v1.1.1-Windows-x64.zip` 放 GitHub Releases 附件，不要把 Electron 的 exe / dll 提交到代码仓库。
- SHA256SUMS.txt 可放同一个 Release，方便下载者校验。
- 不上传工作目录、备份、聊天导出、API Key、订阅令牌或用户的项目代码。自动白名单与密钥模式扫描不能代替最后一次人工检查。

## 最直观的方法

1. 在 GitHub 新建仓库，例如 `resonance`。先不要勾选初始化 README，避免与本地文件冲突。
2. 小源码包可在网页点 Add file → Upload files，上传解压目录内的文件。隐藏文件 `.gitignore` 和 `.github` 不要漏掉；也可用 GitHub Desktop 发布本地仓库。
3. About 简介使用：**A local multi-model AI workspace for collaborative tasks, workflows, and artifact review.**
4. 阅读 LICENSE 提示，选择你接受的许可证再添加。公开仓库本身不等于已经授予开源使用许可。
5. 创建 Release `v1.1.1`，上传 Windows ZIP 与校验文件，并写清 Windows 预览版、未签名和已知限制。

## 使用 Git 命令

在解压出的源码根目录打开终端：

```sh
git init
git add .
git diff --cached --stat
git commit -m "Release Resonance v1.1.1"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/resonance.git
git push -u origin main
```

替换 YOUR-NAME；提交前确认暂存文件只有源码、测试、文档与脱敏示例。登录由 GitHub 或系统凭据管理器处理，不要把访问令牌写进 remote URL、源码或截图。

## 验证与构建

仓库检查工作流执行语法和测试。本版本也提供手动 Windows 构建工作流；在 Actions 中触发后下载产物，不会自动创建 Release。

本地复核：

```sh
npm run check
npm test
npm run source:package
```

使用系统加密的本地凭据不会随源码分发。程序升级保留数据，但跨电脑使用通常需要重新填写密钥。
