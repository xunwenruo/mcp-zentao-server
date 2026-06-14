# 禅道 MCP Server

在 Kiro / Cursor / Claude Desktop 等支持 MCP 的 IDE 中直接查询和管理禅道 Bug、任务、项目、迭代，无需切换浏览器。

## 功能

### Bug 管理

| 工具             | 说明                                          |
| ---------------- | --------------------------------------------- |
| `get_my_bugs`    | 获取指派给我的 Bug 列表（支持分页、状态筛选） |
| `get_bug_detail` | 获取指定 Bug 的详细信息                       |
| `resolve_bug`    | 解决 Bug（支持多种解决方案）                  |
| `close_bug`      | 关闭已解决的 Bug                              |
| `activate_bug`   | 重新激活已关闭/已解决的 Bug                   |

### 任务管理

| 工具              | 说明                                             |
| ----------------- | ------------------------------------------------ |
| `get_my_tasks`    | 获取指派给我的任务列表（分页、状态筛选）         |
| `get_task_detail` | 获取任务详情                                     |
| `create_task`     | 在指定迭代下创建任务（支持 `parent` 创建子任务） |
| `update_task`     | 修改任务（标题/状态/指派/工时等）                |
| `finish_task`     | 完成任务                                         |

### 项目与迭代

| 工具                   | 说明                           |
| ---------------------- | ------------------------------ |
| `get_projects`         | 获取项目列表（分页、状态筛选） |
| `get_project_detail`   | 获取项目详情                   |
| `get_executions`       | 获取迭代列表（可按项目过滤）   |
| `get_execution_detail` | 获取迭代详情                   |

## 快速开始

### 1. 复制文件

将 `mcp-zentao-server/` 整个文件夹复制到你的项目根目录（或任意位置）。

### 2. 安装依赖

```bash
cd mcp-zentao-server
npm install
```

### 3. 配置 MCP

根据你使用的 IDE，编辑对应的 MCP 配置文件：

- **Kiro**: `.kiro/settings/mcp.json`（项目级）或 `~/.kiro/settings/mcp.json`（全局）
- **Cursor**: `.cursor/mcp.json`
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）

填入以下内容（**替换为你自己的账号密码**）：

```json
{
  "mcpServers": {
    "zentao": {
      "command": "node",
      "args": ["/你的绝对路径/mcp-zentao-server/index.js"],
      "env": {
        "ZENTAO_URL": "http://your-zentao-host:8081",
        "ZENTAO_ACCOUNT": "你的禅道账号",
        "ZENTAO_PASSWORD": "你的禅道密码"
      }
    }
  }
}
```

> ⚠️ `args` 中的路径必须是**绝对路径**，不支持相对路径。

### 4. 重启 IDE / 重连 MCP

配置完成后重启 IDE 或在 MCP 面板中重连服务即可。

## 使用示例

在 AI 对话中直接用自然语言：

- "看看我有哪些 Bug"
- "查看 Bug #123 的详情"
- "把 Bug #456 标记为已修复"
- "我现在有哪些任务"
- "在迭代 12 下创建一个任务，标题是 xxx，指派给 zhangsan"
- "把任务 #888 标记完成，消耗 4 小时"
- "列出所有进行中的项目"
- "查看项目 5 下的迭代"

## 环境要求

- Node.js >= 18（需要原生 fetch 支持）
- 禅道开源版 18.x（使用 REST API v1）
- 网络可访问禅道服务器（`your-zentao-host:8081`）

## 禅道 API 说明

基于禅道开源版 18.5 的 REST API v1：

### Bug

| 接口                            | 方法 | 说明     |
| ------------------------------- | ---- | -------- |
| `/api.php/v1/tokens`            | POST | 登录认证 |
| `/my-work-bug.json`             | GET  | 我的 Bug |
| `/bug-view-{id}.json`           | GET  | Bug 详情 |
| `/api.php/v1/bugs/:id`          | PUT  | 解决 Bug |
| `/api.php/v1/bugs/:id/close`    | POST | 关闭 Bug |
| `/api.php/v1/bugs/:id/activate` | POST | 激活 Bug |

### 任务 / 项目 / 迭代

| 接口                                  | 方法 | 说明       |
| ------------------------------------- | ---- | ---------- |
| `/my-work-task.json`                  | GET  | 我的任务   |
| `/api.php/v1/tasks/:id`               | GET  | 任务详情   |
| `/api.php/v1/tasks/:id`               | PUT  | 修改任务   |
| `/api.php/v1/tasks/:id/finish`        | POST | 完成任务   |
| `/api.php/v1/executions/:id/tasks`    | POST | 创建任务   |
| `/api.php/v1/projects`                | GET  | 项目列表   |
| `/api.php/v1/projects/:id`            | GET  | 项目详情   |
| `/api.php/v1/projects/:id/executions` | GET  | 项目下迭代 |
| `/api.php/v1/executions`              | GET  | 迭代列表   |
| `/api.php/v1/executions/:id`          | GET  | 迭代详情   |

## 常见问题

**Q: 提示"登录失败"**
A: 检查 `ZENTAO_ACCOUNT` 和 `ZENTAO_PASSWORD` 是否正确，确认账号可以正常登录禅道网页版。

**Q: 提示"请求失败 (401)"**
A: Token 过期，服务会自动重试。如果持续失败，重启 MCP 服务。

**Q: 连接不上禅道服务器**
A: 确认你在公司内网或 VPN 环境下，能 ping 通禅道服务器地址。
