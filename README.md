# dsh-mcp

让 Agent 通过 MCP 使用 [DSH](https://github.com/deepseek-ai/deepseek-harness)，或将 DSH 作为子代理。

创建或查找会话时，Agent 通过 `cwd` 指定项目的绝对路径，同一个 MCP 服务可以操作不同项目。会话使用内置的极简模式（`minimal`）和完全访问权限，执行 shell 命令时无需审批。新会话会自动配置，已有会话需要符合这些条件。

创建会话时复用 DSH 的工作区：目录尚未注册时自动注册，已有工作区则复用其身份和名称。会话会出现在该工作区下面，创建结果包含规范化的 `cwd` 和 `workspaceId`。

## 安装与配置

需要 **Node.js 22+**、本机已启动的 DSH，以及支持 stdio 的 MCP 客户端。DSH版本：`0.1.5-rc.1`

### Codex 插件（skill + MCP）

安装插件会同时加载 skill 和 MCP 配置：

```sh
codex plugin marketplace add qjcnmd/dsh-mcp
codex plugin add dsh-mcp@dsh-mcp
```

新建任务后使用“使用 DSH……”提出需求。插件连接本机 `http://127.0.0.1:3080/`，内置 660 秒工具超时。首次启动通过 `npx` 从 GitHub 的 `v0.2.0` 标签安装并构建 MCP，需要 Git、网络连接和 Node.js 22+。插件版本固定对应的 MCP 版本。

从手动配置迁移时，移除原有 `[mcp_servers.dsh]` 配置及单独安装的同名 skill，再加载插件，避免重复注册。DSH 的地址与认证环境变量见下文。

更新插件：

```sh
codex plugin marketplace upgrade dsh-mcp
codex plugin add dsh-mcp@dsh-mcp
```

更新后新建任务加载新版。`plugins/dsh-mcp` 是插件目录，其中 `.codex-plugin/plugin.json` 声明组件，`.mcp.json` 维护启动配置；仓库的 `.agents/plugins/marketplace.json` 提供 GitHub 安装入口。目录组织参考 [OpenAI 插件仓库](https://github.com/openai/plugins)。

### 其他 MCP 客户端

通过 npm 使用时，在客户端的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "dsh": {
      "command": "npx",
      "args": ["-y", "@qjcnb/dsh-mcp"]
    }
  }
}
```

也可以从源码安装：

```sh
git clone https://github.com/qjcnmd/dsh-mcp.git
cd dsh-mcp
npm ci
npm run build
```

在客户端的 MCP 配置中添加以下内容，将路径替换为本项目的入口文件：

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-mcp/dist/server.js"]
    }
  }
}
```

配置文件位置和外层字段以客户端要求为准。Windows 路径使用正斜杠 `/` 或转义后的反斜杠 `\\`。项目路径通过 `dsh.session.create` 和 `dsh.session.list` 的 `cwd` 参数传入，例如 `{"cwd":"C:/Users/you/project"}`。

默认连接 `http://127.0.0.1:3080/`，需要时可在客户端的服务配置中设置以下环境变量：

| 变量 | 用途 |
|---|---|
| `DSH_BASE_URL` | DSH 地址，也可填写包含 `?token=...` 的启动链接 |
| `DSH_AUTH_TOKEN` | 启动令牌；需要认证且地址中未包含令牌时填写 |

在 Windows 上，未提供令牌时，服务可从 DeepSeek Harness 启动器日志中读取与配置地址对应的令牌。

## 使用

Agent 可以创建或查找会话、发送指令并等待结果。发送后用返回的 `turnRef` 调用 `dsh.session.wait_turn`；每次最多等待十分钟，完成、失败或取消时立即返回。返回 `timed_out` 时用同一个 `turnRef` 继续等待，不重新发送任务。等待期间可以向同一会话补充指令或取消执行。MCP 重启后，只要 DSH 仍保留会话历史，也可以重新接管。

`wait_turn` 不接受自定义超时。MCP 客户端的工具超时需要大于 600 秒，建议 660 秒；否则客户端可能先中断观察。Codex 在现有服务配置中设置：

```toml
[mcp_servers.dsh]
command = "node"
args = ["/absolute/path/to/dsh-mcp/dist/server.js"]
tool_timeout_sec = 660
```

修改配置后重新连接 MCP。其他客户端在各自的工具调用设置中配置同等超时。客户端断开或等待超时不会取消 DSH，只有 `dsh.session.cancel` 请求取消执行。

这是同步 MCP 长等待：十分钟内不因普通进展返回，超过十分钟需要续等。它不提供宿主原生子代理的异步完成通知。

本地验证：`npm test` 检查回合状态、等待、取消及协议；构建后运行 `node tests/integration/workspace-smoke.mjs` 验证真实工作区关联与复用，该检查不发送模型提示。

### 配套 skill

[dsh-mcp](plugins/dsh-mcp/skills/dsh-mcp/SKILL.md) 指导代理在各类项目和任务中通过 MCP 使用 DSH，涵盖会话使用、模型确认、执行期间的操作与结果处理；接口用法以 MCP 工具说明为准。新任务使用的供应商、模型与思考程度由用户确认，skill 优先使用宿主的同步提问工具。Codex 插件已包含该 skill。单独使用时，将该目录安装或链接到客户端的技能目录，并配置 MCP 连接。

## 开发与发布

`npm ci` 安装依赖并构建；`npm test`、`npm run typecheck` 和 `npm run test:package` 验证行为、类型和安装包。Git 安装使用 `prepare` 构建入口，skill 只在 `plugins/dsh-mcp/skills/dsh-mcp` 维护一份。

发布时同步更新 `package.json`、锁文件及插件清单版本，将 `.mcp.json` 的 Git 标签指向同一版本，完成验证后推送提交和对应标签。GitHub 插件发布与 npm registry 发布分别进行。

## 工具

| 工具 | 用途 |
|---|---|
| `dsh.session.list` | 查找指定 `cwd` 中未归档的顶层会话 |
| `dsh.session.create` | 在指定 `cwd` 中新建会话 |
| `dsh.session.models` | 查询模型、思考程度及当前选择 |
| `dsh.session.select_model` | 切换模型，可同时设置思考程度 |
| `dsh.session.send_message` | 发送文字指令；空闲时开始任务，执行中补充当前任务。可在文字中引用共享文件路径 |
| `dsh.session.wait_turn` | 最多等待十分钟，返回最终回复或结束原因；支持按回合恢复观察 |
| `dsh.session.cancel` | 取消正在执行的任务 |

## 许可证

[MIT](LICENSE)。
