# Resonance 工作流导入与分享

工作流把常用需求、输入表单和已有执行模板保存下来。选择工作流、填写需求，再确认模型与预算即可开始。导入本身不调用模型，也不执行命令。

## 使用方式

1. 打开侧边栏「工作流」，选择内置工作流，或导入本地 `.gmflow.json` / JSON 文件。
2. 查看说明与输入项。首次使用导入内容时，尤其要检查提示词是否符合自己的意图。
3. 填写需求并点击运行。在确认页检查当前模型、技能、预算和任务类型。
4. 进入已有协作流程，查看结果、执行审批和产物。

工作流可以钉住、排序、导出；导入和自建工作流还可以编辑、删除。内置工作流可以导出后另存，不能直接覆盖或删除。删除工作流不会删除已创建的任务或产物。

## 文件格式

示例见 [website.gmflow.json](examples/website.gmflow.json)。保留 `gongming-workflow@1` 是为了让不同版本之间继续兼容。

| 字段 | 用途 |
| --- | --- |
| `format` | 必须是 `gongming-workflow@1` |
| `name`、`icon`、`description` | 名称、图标和简介 |
| `version`、`author` | 分享者填写的版本和作者；不代表受信任签名 |
| `trigger.kind` | `website`、`ppt`、`document`、`project` 或 `code` |
| `trigger.starterPrompt` | 需求模板；只支持 `{{输入键}}` 文本替换 |
| `trigger.templateValues` | 可选，已有执行模板的固定参数 |
| `inputs` | 输入表单：`key`、`label`、`required`、`multiline`，可选 `default`、`placeholder`、`target` |
| `pipeline` | 可省略；填写时仅支持完整标准流程，不能跳过审批 |

输入项必须用在 `starterPrompt` 中，或通过 `target` 映射到所选执行模板的参数。映射不会执行表达式或 JavaScript。替换仅进行一轮，输入值中的 `{{文字}}` 不会继续求值。

模板参数可通过 `GET /api/workflows` 查看。例如网站支持 `audience`、`sections`、`style`、`materials`；PPT 支持 `audience`、`slideCount`、`style`、`materials`。PPT 页数遵循当前的 4–20 页限制。

## 当前执行边界

- 自建工作流复用现有执行流程。不能导入任意阶段、shell 命令、外部工具权限或关闭审批的配置。
- `skills` 非空数组、`model` 非空对象、`constraints` 非空对象，以及未知字段，会明确报错。请在工作台配置相关能力，运行前确认；不会悄悄忽略这些配置。
- 模型使用当前角色分配；技能使用当前启用的参考技能。工作流文件不包含 API Key、订阅凭据或 MCP 令牌。
- URL 导入尚未启用。请先下载 JSON 文件，检查内容后从本地导入。文件中的链接是文本，不会因导入而被自动抓取。
- 文件不超过 128 KB，提示词不超过 20,000 字符，输入项不超过 32 个。这些是输入校验边界，不是付费计划。
- 模板提示词仍属于用户提供的内容。只有应用现有执行与审批机制能实际执行操作，提示词不能授予额外权限。

## 保存位置与迁移

工作流记录保存在当前工作区的 `workflow-library.json`，变更时原子替换并保留 `workflow-library.previous.json`。损坏或主记录缺失但存在备份时，程序保留文件并报错，不会自动创建空库覆盖历史。

跨电脑分享时优先导出单个工作流文件。导出包含模板和表单，不包含对话、任务、模型密钥或执行历史；运行记录仍保留在原工作区的任务记录中。

## 本地 API

- `GET /api/workflow-library`：内置、导入、自建工作流与实际能力边界。
- `POST /api/workflow-library`：`{action:"create"|"import",definition:{...}}`。
- `POST /api/workflow-library/:id`：`update`、`pin` 或 `order`；排序使用 `beforeId`，`null` 表示放末尾。
- `DELETE /api/workflow-library/:id`：删除导入或自建记录。
- `GET /api/workflow-library/:id/export`：导出兼容 JSON。
- `POST /api/workflow-library/:id/prepare`：`{inputs:{...}}`，返回需求和模板参数，尚不执行任务。

准备接口始终返回 `requiresConfirmation:true`。确认后沿用 `POST /api/jobs` 创建任务，并携带 `libraryWorkflowId`，供运行记录关联。
