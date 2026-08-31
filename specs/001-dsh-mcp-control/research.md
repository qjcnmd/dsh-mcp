# MCP 现状研究：DSH 本地适配层

**核对日期**：2026-08-31  
**研究范围**：MCP 官方规范与官方 SDK/仓库、OpenAI 官方产品与 SDK 文档、WebMCP 官方社区组草案。本文只确定协议与宿主边界，不验证 DSH 内部接口，也不决定实现语言。

## 1. 规范基线与版本策略

### Decision

首版 DSH 适配层以 **MCP 2026-07-28** 为当前稳定互操作基线；同时要求所选官方 SDK 在实现层保留对 2025-11-25 及更早初始化时代的兼容能力。协议代际和扩展能力使用规范定义的协商/探测机制，不根据宿主名称猜测能力，也不把旧代兼容逻辑散落到 DSH 业务处理器中。

### Rationale

- MCP 官方发布页在本轮只读核对时把 `2026-07-28` 标为 Latest、把 `2026-07-28 RC` 标为 Pre-release；规范页标题也显示 `Version 2026-07-28 (latest)`：[官方发布页](https://github.com/modelcontextprotocol/modelcontextprotocol/releases)、[2026-07-28 Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)。因此不能继续把 2025-11-25 当作当前最新基线。
- 2026-07-28 将现代连接定义为每个请求在 `_meta` 携带协议版本、客户端身份和能力，并要求服务端实现 `server/discover`；2025-11-25 及更早版本属于初始化握手的 legacy era，规范提供向后兼容矩阵：[2026-07-28 Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)。
- 官方 TypeScript/Python SDK 的迁移与运行资料显示实现者应让 SDK 处理现代/legacy transport 和生命周期差异，而不是在 DSH action handler 中写第二套协议：[TypeScript SDK 2026 support](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)、[Python SDK run guide](https://github.com/modelcontextprotocol/python-sdk/blob/main/docs/run/index.md)。

### Alternatives considered

- **只实现 2025-11-25**：可覆盖旧宿主，但会错过当前规范的 per-request metadata、`server/discover`、`subscriptions/listen` 和现代输入结果。
- **在 DSH 业务层同时维护两套协议**：会复制错误、取消和结果映射；应把代际处理收敛在官方 SDK/transport 边界。
- **根据调用方名称切换协议**：不可靠；同一宿主版本、配置和 SDK 可能支持不同能力，规范已提供版本与 capability 协商。

## 2. 传输选择

### Decision

标准本地分发优先提供 **stdio**；若现实宿主需要 URL 型 MCP，再由同一工具层提供绑定回环地址的 **Streamable HTTP**。不为新接入实现旧 HTTP+SSE 传输；也不依赖 2025-11-25 的独立 GET/SSE 推送作为 DSH 事件等待的唯一语义基础。

### Rationale

- 2026-07-28 的标准传输是 stdio 与 Streamable HTTP：stdio 是客户端启动子进程上的换行分隔 JSON-RPC；Streamable HTTP 对单一 MCP endpoint 使用 POST，响应可为 JSON 或 request-scoped SSE：[2026-07-28 Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)。
- 2026-07-28 的 Streamable HTTP 用请求响应流承载取消，客户端关闭该流即表示取消；`subscriptions/listen` 取代旧的独立 GET 推送和旧资源订阅方式：[2026-07-28 Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)、[2026-07-28 Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)。
- 官方 SDK 运行指南仍将 stdio 定位为本地子进程默认传输、Streamable HTTP 定位为 URL 服务，并将旧 SSE 视为历史路径：[官方 Python SDK 运行指南](https://github.com/modelcontextprotocol/python-sdk/blob/main/docs/run/index.md)。
- 对 DSH 而言，MCP 传输只承载 Agent 与适配层的 JSON-RPC。适配层内部等待 DSH turn 应继续消费 DSH 自身的事件接口；MCP 工具调用可以保持挂起并最终返回，不能把“DSH 不轮询”误写成“必须使用 MCP GET 推送”。

### Alternatives considered

- **只提供本地 HTTP 服务**：可被 URL 型宿主使用，但增加端口生命周期、Origin/鉴权与多实例定位问题，不是最小的本地全局注册形态。
- **为每个宿主实现不同传输或工具集**：违背标准 MCP 的目标，也会制造平行协议。
- **继续实现 HTTP+SSE**：官方已明确将其作为旧客户端兼容路径，不适合作为新实现基线。

## 3. 工具调用、结果、错误与通知

### Decision

每个 DSH 可见操作暴露为稳定、动作级工具；输入使用明确目标 ID 和 JSON Schema，读取结果优先提供 `structuredContent`，并保留简洁的人类可读 `content`。业务失败返回 `CallToolResult.isError: true`，只有协议/路由/参数层失败才使用 JSON-RPC error。动态能力变化可发 `notifications/tools/list_changed`，但任何关键状态与完成判断都不能依赖宿主一定接收通知。

### Rationale

- MCP 将 tools 定义为模型控制的可执行 primitive；当前 2026-07-28 工具定义继续要求明确 JSON Schema，并支持分页/缓存元数据、`outputSchema`、结构化结果和 `isError`：[2026-07-28 Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)、[2026-07-28 Schema Reference](https://modelcontextprotocol.io/specification/2026-07-28/schema)。
- 2026-07-28 的 `tools/call` 可以返回 `resultType: complete` 或 `resultType: input_required`；后者携带 `inputRequests` 与可用于重试的 `requestState`，因此 DSH 问题/审批应能映射到标准多轮结果，同时保留独立 action-level 响应工具供跨宿主和直接 DSH 控制使用：[2026-07-28 Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)。
- `notifications/tools/list_changed` 只会发给显式打开 `subscriptions/listen` 且订阅了 `toolsListChanged` 的客户端；它不是可靠队列。下一次 `tools/list` 和每次 `tools/call` 仍须以当前 DSH 能力为准：[2026-07-28 Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)、[2026-07-28 Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)。
- Progress 仍要求请求方在 `_meta` 提供唯一 `progressToken`，服务端可以不发送 progress；因此进度只能改善体验，不能作为 `wait_turn` 的完成证据：[2026-07-28 Progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)。
- OpenAI Agents SDK 对本地 MCP 提供工具过滤和逐工具 approval policy，并提醒 MCP server 与其凭据必须可信、敏感操作应审批：[OpenAI Agents SDK MCP](https://openai.github.io/openai-agents-python/mcp/)。DSH 适配层仍需保留 DSH 原生审批与确认，不能把宿主提示当成 DSH 接受操作的证据。

### Alternatives considered

- **只返回自然语言文本**：跨宿主展示简单，但会迫使 Agent 解析状态，削弱 turn reference、终态与错误的可验证性。
- **所有失败都抛 JSON-RPC error**：会混淆协议失败和 DSH 已正常拒绝/执行失败。
- **依赖进度或工具列表通知维持状态**：规范明确这些能力是可选或非可靠的，无法支撑完成性。

## 4. 长任务、等待、取消与人工输入

### Decision

首版以普通、可挂起的 `wait_turn(turnRef)` 工具作为跨宿主基线：它在适配层内部订阅 DSH 事件，直到指定 turn 出现终态、待人工输入、调用取消或无法证明结果。`send_message` 立即返回稳定 turn reference。MCP Tasks 仅作为协商成功后的可选增强，不作为首版唯一接口或正确性依赖。

### Rationale

- 2026-07-28 Tasks 是可选扩展：客户端在每个请求的 capability metadata 中声明支持，服务端通过 `server/discover` 宣告扩展；服务端可返回 `resultType: task`，任务状态包括 `working`、`input_required`、`completed`、`failed`、`cancelled`，客户端通常用 `tasks/get` 获取状态：[2026-07-28 Tasks](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/tasks)。这意味着“MCP-compatible”仍不等于“支持 Tasks”。
- Tasks 的耐久句柄和输入中断适合分钟级外部作业，但它的标准客户端流程仍以 `tasks/get` 查询为中心；不能把 Tasks 的查询流程误写成 DSH 内部必须轮询。DSH `wait_turn` 继续在适配层内部订阅 DSH 事件，MCP Tasks 只在协商并实测支持后作为宿主体验增强。
- 普通 MCP cancellation 与 DSH turn cancellation 是两件事：取消一个 `wait_turn` 请求应停止等待并释放订阅；只有显式调用 DSH 的 cancel/stop 动作工具才应改变 DSH turn。2026-07-28 对 Streamable HTTP 以关闭响应流表达请求取消，stdio 发送 `notifications/cancelled`；官方 SDK 应封装这些 transport 差异：[2026-07-28 Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/cancellation)、[TypeScript SDK 2026 support](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)。
- DSH question/approval 优先映射为 2026 工具的 `input_required` 多轮结果；同时保留独立 action-level 响应工具，作为宿主未实现多轮输入或需要直接 DSH 控制时的共同集路径。不能假设所有宿主支持 Tasks 或 elicitation。

### Alternatives considered

- **把每次 DSH turn 强制建成 MCP Task**：会排除未实现实验能力的宿主，并把 DSH 状态机错误等同于 MCP Task 状态机。
- **让 `wait_turn` 周期性调用 DSH status**：不符合当前规格要求的 DSH 事件承载正常等待，也更难证明中间丢失事件后的终态。
- **收到 MCP request cancellation 就取消 DSH turn**：取消观察与取消业务执行的授权和副作用不同，不能合并。
- **用 elicitation 完成所有审批/问题**：宿主覆盖不一致，且新代协议的反向请求模型已经变化。

## 5. 宿主兼容性与 OpenAI 边界

### Decision

把兼容性定义为一组经过测试的能力组合，而不是“所有 MCP 宿主行为一致”。最小共同集为：协议协商、`tools/list`、`tools/call`、stdio 或 Streamable HTTP 之一、普通请求取消和结构化结果。Tasks、progress、list-changed、elicitation、sampling、resources、prompts 与 UI 扩展均为独立可选项。验收时至少用两个独立宿主测试共同集，并单列每个宿主的传输与扩展能力。

### Rationale

- 2026-07-28 把版本、身份、客户端能力放入每个请求的 `_meta`，并用 `server/discover` 探测服务端支持；legacy 2025-11-25 宿主仍使用初始化握手。因此规范本身就没有承诺所有宿主具备相同表面，兼容矩阵必须按能力实测记录。
- OpenAI Agents Python SDK 支持 stdio、旧 SSE、Streamable HTTP 和由 Responses API 代管的 hosted MCP；hosted 模式要求 OpenAI 基础设施能够到达远程服务器，而本地连接由调用方进程管理：[OpenAI Agents SDK MCP](https://openai.github.io/openai-agents-python/mcp/)。
- ChatGPT Developer Mode 官方说明 ChatGPT 连接 remote MCP server，本机或私网服务不能直接连接，需使用 Secure MCP Tunnel；功能与权限仍处于 beta，agent mode 不使用 custom apps，deep research 对 custom apps 只读：[OpenAI Help：Developer mode and MCP apps](https://help.openai.com/en/articles/12584461)。因此，一个“本地 stdio 全局注册”不能自动覆盖 ChatGPT 云宿主；这属于宿主网络与产品能力边界，不应通过改变 DSH 工具协议来伪装兼容。
- OpenAI Agents SDK 还支持对敏感 MCP 工具逐次审批；这可作为额外宿主防线，但不取代 DSH 自身授权：[OpenAI Agents SDK Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)。
- Claude Code 官方文档同时提供本地 stdio、远程 HTTP/SSE/WebSocket 的接入方式，并明确区分 local、project、user 等安装 scope；文档还单列 v2 runtime 的动态工具更新、notification streams 和长工具自动后台化。因此，user scope 可以作为 Claude Code 的全局注册位置，但仍需把 transport 与扩展能力逐项写入宿主矩阵：[Claude Code MCP](https://code.claude.com/docs/en/mcp)。

### Alternatives considered

- **声称注册一次即可被任何 MCP 产品自动发现**：MCP 标准化协议，不标准化所有产品的全局配置、进程启动、网络可达性或管理员策略。
- **为了 ChatGPT 云访问而默认公开本地 HTTP**：会扩大网络和授权边界；若未来明确需要，应作为单独部署/隧道决策。
- **为某一宿主复制一套工具命名与结果形状**：会制造宿主专用协议，削弱共同集验证。

## 6. WebMCP 边界

### Decision

WebMCP 不进入首版 DSH 本地 MCP 适配层的协议或运行时依赖。若未来 DSH 页面原生发布 WebMCP tools，可把它作为浏览器内的另一种前端暴露面进行独立评估；本地适配层仍以标准 MCP server 和 DSH 的结构化/事件接口为边界，不通过向页面注入 WebMCP 来补齐能力。

### Rationale

- 截至核对日，WebMCP 是 Web Machine Learning Community Group 于 2026-08-26 发布的 **Draft Community Group Report**，明确不是 W3C Standard，也不在 W3C Standards Track：[WebMCP 草案](https://webmachinelearning.github.io/webmcp/)。
- WebMCP 的对象是页面通过 JavaScript 在 `Document` 的事件循环中注册工具，供浏览器 agent/辅助技术调用；工具依赖活动 browsing context，执行回调是 Promise，并通过 `AbortSignal` 取消：[WebMCP 草案](https://webmachinelearning.github.io/webmcp/)。
- WebMCP 规范明确说，尽管名称如此，它不规定浏览器以 MCP、专有 function calling 或其他格式把工具暴露给 browser agent：[WebMCP 草案，Interaction with agents](https://webmachinelearning.github.io/webmcp/#interaction-with-agents)。其社区组 charter 也说明 WebMCP 对底层协议保持中立，不寻求匹配 MCP 的完整能力：[Web Machine Learning Community Group Charter](https://webmachinelearning.github.io/charter/)。
- WebMCP 的优势是复用页面逻辑与当前登录/UI 上下文，但它要求浏览上下文并受 origin、permissions policy、页面生命周期和浏览器实现约束；它不提供一个可由任意桌面/CLI MCP host 通过 stdio 启动的本地 server。

### Alternatives considered

- **把 WebMCP 当成标准 MCP 的浏览器传输**：官方草案明确不规定与 browser agent 之间的线协议。
- **以 WebMCP 替代 DSH 结构化适配层**：会把完整性和可靠性绑定到活动页面、浏览器支持及页面生命周期，并不能满足通用本地 MCP host。
- **同时实现两套首版接口**：当前没有已验证消费者，会扩大范围并产生平行能力库存。

## 7. 对 DSH 适配层的汇总结论

### Decision

适配层采用三层边界：

1. **宿主协议层**：标准 MCP 2026-07-28 共同集，保留由官方 SDK 处理的 2025-11-25 legacy 兼容；优先 stdio，按实际需要增加回环 Streamable HTTP；协议版本、取消、`server/discover` 和可选能力交给官方 SDK。
2. **动作与投影层**：动作级 tools、明确 DSH target、稳定 turn reference、结构化结果、简洁文本投影；所有操作以 DSH 接受/拒绝和可观察状态为事实源。
3. **DSH 事件适配层**：`send_message` 立即返回；`wait_turn` 消费 DSH 事件并在断线后用历史/事件位置恢复；MCP progress/Tasks/notification 只增强宿主体验，不承担 DSH 完成性证明。

### Rationale

这三层把两类不稳定因素隔离开：外侧是 MCP 宿主、传输和协议代际差异，内侧是 DSH 当前版本的可见动作与事件语义。这样可以复用同一套 DSH 工具，不需要按宿主复制协议，也不会把 WebMCP、Tasks 或通知的可选能力误当成核心正确性条件。

### Alternatives considered

- **直接把 DSH 事件逐条映射为 MCP notification**：通知覆盖与可靠性不足，并会泄漏默认不需要的完整运行轨迹。
- **让工具层自行维护 DSH 的影子状态机**：会与 DSH 真相源分叉；适配层只投影被观察到的 DSH 状态。
- **将协议兼容逻辑散落在各 DSH action handler**：会把协议代际变化污染业务语义；由官方 SDK 和统一边界处理更可验证。

## 8. 仍需在后续阶段验证的事项

以下不是本次研究已经确认的事实：

- 当前安装的 DSH 版本、完整主工作面能力库存、结构化操作入口、事件字段、turn 稳定标识与恢复游标；必须通过只读源码/运行时取证另行确认。
- 目标宿主清单及其当前配置是否支持 stdio、Streamable HTTP、结构化结果、请求取消、Tasks 或 UI 扩展；必须逐宿主做实际互操作测试。
- 选用哪一个官方 MCP SDK及其固定版本；应在实施前核对当时的稳定发行版、许可证、Windows stdio 行为和两代协议支持。
- 实施启动日仍应重新检查官方 releases、规范页和 SDK 支持矩阵；规范与 SDK 可能继续演进，即使本次核对已看到 2026-07-28 标为 latest。

**若多查一步，最可能推翻的结论**：实现启动时的官方 SDK 可能尚未完整支持 2026-07-28 的某个现代扩展，从而改变“哪些扩展进入首版”的选择；这不会改变以最新稳定规范为目标、由 SDK 隔离 legacy 兼容、以及 WebMCP 不等同于 MCP transport 这三个设计边界。

## 9. 本轮直接只读复核记录

- https://github.com/modelcontextprotocol/modelcontextprotocol/releases 返回的发布列表把 2026-07-28 标为 Latest，把 2026-07-28 RC 标为 Pre-release。
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports、.../basic/versioning、.../basic/patterns/subscriptions、.../basic/patterns/progress、.../basic/utilities/tasks、.../server/tools 均返回 HTTP 200，并显示 Version 2026-07-28 (latest)。
- 官方 Python SDK 运行文档与 TypeScript SDK 2026 支持文档均返回 HTTP 200；具体 API 版本、Windows 行为和目标宿主兼容性仍留到实施启动时验证。
- DSH 首页的浏览器能力检查发现页面虽然声明了 WebMCP 能力入口，但当前文档返回 “No WebMCP tools are available in this document.”；因此当前 DSH 页面没有可直接复用的页面 WebMCP 工具集。
