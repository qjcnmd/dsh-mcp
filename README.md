# dsh-mcp

让 Agent 通过 MCP 使用 [DSH](https://github.com/deepseek-ai/deepseek-harness)，或将 DSH 作为子代理。

创建或查找会话时，Agent 通过 `cwd` 指定项目的绝对路径，同一个 MCP 服务可以操作不同项目。会话使用内置的极简模式（`minimal`）和完全访问权限，执行 shell 命令时无需审批。新会话会自动配置，已有会话需要符合这些条件。

## 安装与配置

需要 **Node.js 22+**、本机已启动的 DSH，以及支持 stdio 的 MCP 客户端。DSH版本：`0.1.5-rc.1`

从源码安装：

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

Agent 可以创建或查找会话、发送指令并等待结果。等待超时不会停止 DSH，Agent 可以继续等待；MCP 重启后，只要 DSH 仍保留会话历史，也可以重新接管。

## 工具

| 工具 | 用途 |
|---|---|
| `dsh.session.list` | 查找指定 `cwd` 中未归档的顶层会话 |
| `dsh.session.create` | 在指定 `cwd` 中新建会话 |
| `dsh.session.models` | 查询模型、思考程度及当前选择 |
| `dsh.session.select_model` | 切换模型，可同时设置思考程度 |
| `dsh.session.send_message` | 发送文字指令；空闲时开始任务，执行中补充当前任务。可在文字中引用共享文件路径 |
| `dsh.session.wait_turn` | 等待结果或查看已有任务的进展 |
| `dsh.session.cancel` | 取消正在执行的任务 |

## 许可证

[MIT](LICENSE)。
