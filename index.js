import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 从脚本同目录的 .env 读取配置，把 ZENTAO_PASSWORD 等敏感值移出 mcp.json 明文。
// 仅填充「尚未在环境中设置」的变量：因此 mcp.json / 真实环境变量优先，.env 兜底。
(function loadDotenv() {
  try {
    const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined || process.env[key] === "") process.env[key] = val;
    }
  } catch {
    // 无 .env 时跳过（改由 mcp.json / 真实环境变量提供）
  }
})();

// ============ 禅道 API 客户端 ============

const ZENTAO_URL = process.env.ZENTAO_URL || "http://your-zentao-host:8081";
const ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || "";
const ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || "";

let cachedToken = null;

async function getToken(forceRefresh = false) {
  if (cachedToken && !forceRefresh) return cachedToken;

  const resp = await fetch(`${ZENTAO_URL}/api.php/v1/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: ZENTAO_ACCOUNT, password: ZENTAO_PASSWORD }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`登录失败 (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  cachedToken = data.token;
  return cachedToken;
}

// 禅道 web 端点（*.json 页面，如 my-work-bug.json / bug-view-x.json）请求封装。
// 这些端点在 Token 过期时不会返回 401，而是返回 200 且 data 为
// { locate: ".../user-login...json" } 登录跳转，导致调用方静默拿到空数据。
// 这里检测到登录跳转后强制刷新 Token 并重试一次，避免长驻进程缓存的过期 Token
// 让 get_my_bugs / get_my_tasks 等静默返回空列表。
async function zentaoWebFetch(pathWithQuery) {
  const fetchOnce = async (token) => {
    const resp = await fetch(`${ZENTAO_URL}${pathWithQuery}`, {
      headers: { "Content-Type": "application/json", Token: token },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`请求失败 (${resp.status}): ${text}`);
    }
    const responseData = await resp.json();
    let data = responseData.data;
    if (typeof data === "string") data = JSON.parse(data);
    return data;
  };

  let data = await fetchOnce(await getToken());
  if (data && typeof data.locate === "string" && data.locate.includes("user-login")) {
    data = await fetchOnce(await getToken(true));
  }
  return data;
}

async function zentaoFetch(path, method = "GET", body = null) {
  const token = await getToken();
  const url = `${ZENTAO_URL}/api.php/v1${path}`;

  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      Token: token,
    },
  };

  if (body && method !== "GET") {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);

  if (resp.status === 401) {
    // token 过期，重新获取
    cachedToken = null;
    const newToken = await getToken();
    options.headers.Token = newToken;
    const retryResp = await fetch(url, options);
    if (!retryResp.ok) {
      const text = await retryResp.text();
      throw new Error(`请求失败 (${retryResp.status}): ${text}`);
    }
    return retryResp.json();
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`请求失败 (${resp.status}): ${text}`);
  }

  return resp.json();
}

// 规范化 desc 输入：
// - 去掉外层 <![CDATA[...]]> 包裹（含被实体转义后的形式）
// - 解码常见 HTML 实体（支持多重转义）
// - 若仍含 HTML 标签，转为简易纯文本 / Markdown
//   （禅道接口会把 < > & 当成普通文本存储，传 HTML 反而会被转义后显示）
function normalizeDesc(input) {
  if (input == null) return input;
  if (typeof input !== "string") return input;
  let s = input;

  s = s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, "$1");
  s = s.replace(/^\s*&lt;!\[CDATA\[([\s\S]*?)\]\]&gt;\s*$/i, "$1");

  const entities = {
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&amp;": "&",
  };
  let prev;
  do {
    prev = s;
    s = s.replace(/&(?:lt|gt|quot|#39|apos|nbsp|amp);/g, (m) => entities[m] || m);
  } while (s !== prev);

  if (!/<\/?[a-zA-Z][^>]*>/.test(s)) return s.trim();

  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/\s*p\s*>/gi, "\n\n");
  s = s.replace(/<\s*p[^>]*>/gi, "");
  s = s.replace(/<\s*h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ");
  s = s.replace(/<\/\s*h[1-6]\s*>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "- ");
  s = s.replace(/<\/\s*li\s*>/gi, "\n");
  s = s.replace(/<\/?\s*(ul|ol)[^>]*>/gi, "\n");
  s = s.replace(/<\s*(strong|b)[^>]*>/gi, "**");
  s = s.replace(/<\/\s*(strong|b)\s*>/gi, "**");
  s = s.replace(/<\s*(em|i)[^>]*>/gi, "*");
  s = s.replace(/<\/\s*(em|i)\s*>/gi, "*");
  s = s.replace(/<\s*code[^>]*>/gi, "`");
  s = s.replace(/<\/\s*code\s*>/gi, "`");
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ============ MCP Server ============

const server = new McpServer({
  name: "zentao",
  version: "1.0.0",
});

// 工具1: 获取我的 Bug 列表
server.tool(
  "get_my_bugs",
  "获取指派给我的 Bug 列表",
  {
    page: z.number().optional().describe("页码，默认 1"),
    limit: z.number().optional().describe("每页数量，默认 20"),
    status: z.enum(["all", "active", "resolved", "closed"]).optional().describe("Bug 状态筛选，默认 all"),
  },
  async ({ page = 1, limit = 20, status = "all" }) => {
    try {
      // 禅道 18.5 开源版使用 pathinfo 格式: /my-work-bug.json
      const bugData = await zentaoWebFetch(`/my-work-bug.json?page=${page}&limit=${limit}`);

      const bugs = bugData.bugs || [];
      let bugList = Array.isArray(bugs) ? bugs : [];

      // 按状态筛选
      if (status !== "all") {
        bugList = bugList.filter((bug) => bug.status === status);
      }

      let result = `## 我的 Bug 列表 (共 ${bugList.length} 条)\n\n`;

      if (bugList.length === 0) {
        result += "暂无 Bug";
      } else {
        result += "| ID | 标题 | 严重程度 | 状态 | 优先级 |\n";
        result += "|---|---|---|---|---|\n";
        for (const bug of bugList) {
          result += `| ${bug.id} | ${bug.title} | ${bug.severity} | ${bug.status} | ${bug.pri || "-"} |\n`;
        }
      }

      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `获取 Bug 列表失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具2: 获取 Bug 详情
server.tool(
  "get_bug_detail",
  "获取指定 Bug 的详细信息",
  {
    bugId: z.number().describe("Bug ID"),
  },
  async ({ bugId }) => {
    try {
      // 先尝试 REST API，失败则用 pathinfo 格式
      let bug;
      try {
        bug = await zentaoFetch(`/bugs/${bugId}`);
      } catch (_) {
        const data = await zentaoWebFetch(`/bug-view-${bugId}.json`);
        bug = data.bug || data;
      }

      let result = `## Bug #${bug.id}: ${bug.title}\n\n`;
      result += `- **状态**: ${bug.status}\n`;
      result += `- **严重程度**: ${bug.severity}\n`;
      result += `- **优先级**: ${bug.pri}\n`;
      result += `- **指派给**: ${bug.assignedTo}\n`;
      result += `- **创建者**: ${bug.openedBy}\n`;
      result += `- **创建时间**: ${bug.openedDate}\n`;
      result += `- **所属产品**: ${bug.product} (ID: ${bug.product})\n`;
      result += `- **所属模块**: ${bug.module || "无"}\n`;
      result += `- **解决方案**: ${bug.resolution || "未解决"}\n`;
      result += `- **影响版本**: ${bug.openedBuild || "-"}\n`;
      result += `- **解决版本**: ${bug.resolvedBuild || "-"}\n`;
      result += `\n### 重现步骤\n\n${bug.steps || "无"}\n`;

      if (bug.resolvedBy) {
        result += `\n### 解决信息\n`;
        result += `- **解决者**: ${bug.resolvedBy}\n`;
        result += `- **解决时间**: ${bug.resolvedDate}\n`;
      }

      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `获取 Bug 详情失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具3: 解决 Bug
//
// ✅ 已修复（2026-06，在 bug 3329 上实测）：改用动作子端点
//    POST /api.php/v1/bugs/{id}/resolve，不再走全量编辑 PUT /bugs/{id}。
//
// 历史缺陷（PUT 路径）：steps 字段每次调用都被 HTML entity 再编码一次，
//   多次 resolve 会让 steps 累积成不可读字面字符（<p> → &lt;p&gt; → …）。
//   根因：PUT /bugs/{id} → bug.php::put() 用 batchSetPost('...,steps,...', $oldBug)
//   把 oldBug 的 raw HTML steps 强塞进 $_POST，form::data 在 REST 上下文不识别
//   richtext，对 steps 一律 htmlspecialchars 且不反向 decode。
//
// 现行方案：动作端点 POST /bugs/{id}/resolve 走专用 resolve 流程，
//   只更新 resolution/resolvedBuild/resolvedDate/assignedTo + 写 comment，
//   不重提 steps，因此无编码污染。已验证：连续 3 次 resolve 同一个含
//   富文本 + 图片的 bug，steps 长度与内容始终不变（171 字符 raw HTML）。
//   该端点同样支持 comment / assignedTo（assignedTo 实测生效）。
server.tool(
  "resolve_bug",
  "解决指定的 Bug（将状态改为已解决）",
  {
    bugId: z.number().describe("Bug ID"),
    resolution: z
      .enum(["fixed", "bydesign", "duplicate", "external", "willnotfix", "notrepro", "tostory", "postponed"])
      .describe("解决方案: fixed=已修复, bydesign=设计如此, duplicate=重复, external=外部原因, willnotfix=不予解决, notrepro=无法重现, tostory=转为需求, postponed=延期处理"),
    resolvedBuild: z.string().optional().describe("解决版本，默认 trunk"),
    comment: z.string().optional().describe("备注说明"),
    duplicateBug: z.number().optional().describe("重复 Bug ID（resolution 为 duplicate 时需要）"),
    assignedTo: z.string().optional().describe("解决后指派给谁（通常指派给测试人员验证）"),
  },
  async ({ bugId, resolution, resolvedBuild = "trunk", comment = "", duplicateBug, assignedTo }) => {
    try {
      // 如果没有指定 assignedTo，自动获取 bug 创建者并指派给他
      let finalAssignedTo = assignedTo;
      if (!finalAssignedTo) {
        try {
          const data = await zentaoWebFetch(`/bug-view-${bugId}.json`);
          const bug = data.bug || data;
          finalAssignedTo = bug.openedBy?.account || bug.openedBy || "";
        } catch (_) {
          // 获取失败不影响解决操作
        }
      }

      const body = {
        resolution,
        resolvedBuild,
        comment,
      };
      if (resolution === "duplicate" && duplicateBug) {
        body.duplicateBug = duplicateBug;
      }
      if (finalAssignedTo) {
        body.assignedTo = finalAssignedTo;
      }

      // 用动作端点 POST /bugs/{id}/resolve（而非全量编辑 PUT /bugs/{id}），
      // 后者会重提 steps 导致每次 HTML entity 二次编码。动作端点不碰 steps。
      // 已在 bug 3329 上实测：连续多次 resolve，steps 始终是干净 raw HTML。
      await zentaoFetch(`/bugs/${bugId}/resolve`, "POST", body);

      const resolutionLabels = {
        fixed: "已修复",
        bydesign: "设计如此",
        duplicate: "重复",
        external: "外部原因",
        willnotfix: "不予解决",
        notrepro: "无法重现",
        tostory: "转为需求",
        postponed: "延期处理",
      };

      return {
        content: [
          {
            type: "text",
            text: `✅ Bug #${bugId} 已标记为「${resolutionLabels[resolution]}」${finalAssignedTo ? `，已指派给 ${finalAssignedTo}` : ""}${comment ? `，备注: ${comment}` : ""}`,
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `解决 Bug 失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具4: 关闭 Bug
server.tool(
  "close_bug",
  "关闭已解决的 Bug",
  {
    bugId: z.number().describe("Bug ID"),
    comment: z.string().optional().describe("关闭备注"),
  },
  async ({ bugId, comment = "" }) => {
    try {
      await zentaoFetch(`/bugs/${bugId}/close`, "POST", { comment });
      return {
        content: [{ type: "text", text: `✅ Bug #${bugId} 已关闭${comment ? `，备注: ${comment}` : ""}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `关闭 Bug 失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具5: 激活 Bug（重新打开）
server.tool(
  "activate_bug",
  "重新激活已关闭或已解决的 Bug",
  {
    bugId: z.number().describe("Bug ID"),
    comment: z.string().optional().describe("激活原因说明"),
    assignedTo: z.string().optional().describe("重新指派给谁"),
  },
  async ({ bugId, comment = "", assignedTo }) => {
    try {
      const body = { comment };
      if (assignedTo) body.assignedTo = assignedTo;

      await zentaoFetch(`/bugs/${bugId}/activate`, "POST", body);
      return {
        content: [{ type: "text", text: `✅ Bug #${bugId} 已重新激活${assignedTo ? `，指派给 ${assignedTo}` : ""}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `激活 Bug 失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具: 创建 Bug（测试人员提 Bug 用）
server.tool(
  "create_bug",
  "在指定产品下创建 Bug",
  {
    productId: z.number().describe("所属产品 ID"),
    title: z.string().describe("Bug 标题"),
    steps: z.string().optional().describe("重现步骤"),
    severity: z.number().optional().describe("严重程度 1-4，默认 3"),
    pri: z.number().optional().describe("优先级 1-4，默认 3"),
    type: z
      .enum(["codeerror", "config", "install", "security", "performance", "standard", "automation", "designdefect", "others"])
      .optional()
      .describe("Bug 类型，默认 codeerror"),
    openedBuild: z.string().optional().describe("影响版本，默认 trunk"),
    assignedTo: z.string().optional().describe("指派给（用户账号）"),
    module: z.number().optional().describe("所属模块 ID"),
    execution: z.number().optional().describe("所属执行（迭代）ID"),
    story: z.number().optional().describe("关联需求 ID"),
  },
  async ({ productId, title, steps, severity = 3, pri = 3, type = "codeerror", openedBuild = "trunk", assignedTo, module, execution, story }) => {
    try {
      const body = { title, severity, pri, type, openedBuild };
      if (steps) body.steps = normalizeDesc(steps);
      if (assignedTo) body.assignedTo = assignedTo;
      if (module !== undefined) body.module = module;
      if (execution !== undefined) body.execution = execution;
      if (story !== undefined) body.story = story;

      const created = await zentaoFetch(`/products/${productId}/bugs`, "POST", body);
      const id = created.id || created.bug?.id || "-";
      return {
        content: [{ type: "text", text: `✅ Bug 已创建: #${id} ${title}（产品 ${productId}）${assignedTo ? `，指派给 ${assignedTo}` : ""}` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `创建 Bug 失败: ${err.message}` }], isError: true };
    }
  },
);

// ============ 需求（研发需求/Story）相关工具 ============

const STORY_STATUS_LABELS = {
  draft: "草稿",
  active: "激活",
  changed: "已变更",
  reviewing: "评审中",
  closed: "已关闭",
};

// 工具: 获取研发需求（Story）详情
server.tool("get_story_detail", "获取指定研发需求（Story）的详细信息", { storyId: z.number().describe("需求（Story）ID") }, async ({ storyId }) => {
  try {
    let story;
    try {
      story = await zentaoFetch(`/stories/${storyId}`);
    } catch (_) {
      const data = await zentaoWebFetch(`/story-view-${storyId}.json`);
      story = data.story || data;
    }

    const fmtUser = (u) => (typeof u === "object" ? u?.realname || u?.account : u);

    let result = `## 需求 #${story.id}: ${story.title}\n\n`;
    result += `- **状态**: ${STORY_STATUS_LABELS[story.status] || story.status || "-"}\n`;
    result += `- **阶段**: ${story.stage || "-"}\n`;
    result += `- **优先级**: ${story.pri || "-"}\n`;
    result += `- **指派给**: ${fmtUser(story.assignedTo) || "-"}\n`;
    result += `- **创建者**: ${fmtUser(story.openedBy) || "-"}\n`;
    result += `- **创建时间**: ${story.openedDate || "-"}\n`;
    result += `- **所属产品**: ${story.product || "-"}\n`;
    result += `- **所属模块**: ${story.module || "-"}\n`;
    result += `- **所属计划**: ${story.plan || "-"}\n`;
    if (story.spec) result += `\n### 需求描述\n\n${normalizeDesc(story.spec)}\n`;
    if (story.verify) result += `\n### 验收标准\n\n${normalizeDesc(story.verify)}\n`;
    if (Array.isArray(story.tasks) && story.tasks.length) {
      result += `\n### 关联任务 (${story.tasks.length})\n\n`;
      result += "| ID | 任务 | 类型 | 状态 | 指派给 |\n|---|---|---|---|---|\n";
      for (const t of story.tasks) {
        const a = typeof t.assignedTo === "object" ? t.assignedTo?.realname || t.assignedTo?.account : t.assignedTo;
        result += `| ${t.id} | ${t.name} | ${t.type || "-"} | ${TASK_STATUS_LABELS[t.status] || t.status || "-"} | ${a || "-"} |\n`;
      }
    }
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return { content: [{ type: "text", text: `获取需求详情失败: ${err.message}` }], isError: true };
  }
});

// 工具: 获取产品下的研发需求（Story）列表
server.tool(
  "get_stories",
  "获取指定产品下的研发需求（Story）列表",
  {
    productId: z.number().describe("产品 ID"),
    status: z.enum(["all", "draft", "active", "changed", "reviewing", "closed"]).optional().describe("状态筛选，默认 all"),
    page: z.number().optional().describe("页码，默认 1"),
    limit: z.number().optional().describe("每页数量，默认 30"),
  },
  async ({ productId, status = "all", page = 1, limit = 30 }) => {
    try {
      const data = await zentaoFetch(`/products/${productId}/stories?page=${page}&limit=${limit}`);
      let list = data.stories || [];
      if (status !== "all") list = list.filter((s) => s.status === status);

      let result = `## 产品 ${productId} 需求列表 (共 ${list.length} 条)\n\n`;
      if (list.length === 0) {
        result += "暂无需求";
      } else {
        result += "| ID | 标题 | 状态 | 阶段 | 优先级 | 指派给 |\n|---|---|---|---|---|---|\n";
        for (const s of list) {
          const a = typeof s.assignedTo === "object" ? s.assignedTo?.realname || s.assignedTo?.account : s.assignedTo;
          result += `| ${s.id} | ${s.title} | ${STORY_STATUS_LABELS[s.status] || s.status || "-"} | ${s.stage || "-"} | ${s.pri || "-"} | ${a || "-"} |\n`;
        }
      }
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `获取需求列表失败: ${err.message}` }], isError: true };
    }
  },
);

// ============ 任务相关工具 ============

const TASK_STATUS_LABELS = {
  wait: "未开始",
  doing: "进行中",
  done: "已完成",
  pause: "已暂停",
  cancel: "已取消",
  closed: "已关闭",
};

// 工具6: 获取我的任务列表
server.tool(
  "get_my_tasks",
  "获取指派给我的任务列表",
  {
    page: z.number().optional().describe("页码，默认 1"),
    limit: z.number().optional().describe("每页数量，默认 20"),
    status: z.enum(["all", "wait", "doing", "done", "pause", "cancel", "closed"]).optional().describe("任务状态筛选，默认 all"),
  },
  async ({ page = 1, limit = 20, status = "all" }) => {
    try {
      const taskData = await zentaoWebFetch(`/my-work-task.json?page=${page}&limit=${limit}`);
      const tasks = taskData.tasks || [];
      let taskList = Array.isArray(tasks) ? tasks : [];

      if (status !== "all") {
        taskList = taskList.filter((t) => t.status === status);
      }

      let result = `## 我的任务列表 (共 ${taskList.length} 条)\n\n`;
      if (taskList.length === 0) {
        result += "暂无任务";
      } else {
        result += "| ID | 标题 | 状态 | 优先级 | 类型 | 所属执行 |\n";
        result += "|---|---|---|---|---|---|\n";
        for (const t of taskList) {
          result += `| ${t.id} | ${t.name} | ${TASK_STATUS_LABELS[t.status] || t.status} | ${t.pri || "-"} | ${t.type || "-"} | ${t.execution || "-"} |\n`;
        }
      }
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `获取任务列表失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具7: 获取任务详情
server.tool("get_task_detail", "获取指定任务的详细信息", { taskId: z.number().describe("任务 ID") }, async ({ taskId }) => {
  try {
    let task;
    try {
      task = await zentaoFetch(`/tasks/${taskId}`);
    } catch (_) {
      const data = await zentaoWebFetch(`/task-view-${taskId}.json`);
      task = data.task || data;
    }

    const assignedTo = typeof task.assignedTo === "object" ? task.assignedTo?.realname || task.assignedTo?.account : task.assignedTo;
    const openedBy = typeof task.openedBy === "object" ? task.openedBy?.realname || task.openedBy?.account : task.openedBy;

    let result = `## 任务 #${task.id}: ${task.name}\n\n`;
    result += `- **状态**: ${TASK_STATUS_LABELS[task.status] || task.status}\n`;
    result += `- **类型**: ${task.type || "-"}\n`;
    result += `- **优先级**: ${task.pri || "-"}\n`;
    result += `- **指派给**: ${assignedTo || "-"}\n`;
    result += `- **创建者**: ${openedBy || "-"}\n`;
    result += `- **创建时间**: ${task.openedDate || "-"}\n`;
    result += `- **预计工时**: ${task.estimate ?? "-"}\n`;
    result += `- **已消耗**: ${task.consumed ?? "-"}\n`;
    result += `- **剩余工时**: ${task.left ?? "-"}\n`;
    result += `- **截止日期**: ${task.deadline || "-"}\n`;
    result += `- **所属项目**: ${task.project || "-"}\n`;
    result += `- **所属执行**: ${task.execution || "-"}\n`;
    result += `- **关联需求**: ${task.story || "-"}\n`;
    if (task.desc) result += `\n### 描述\n\n${task.desc}\n`;
    if (task.finishedBy) {
      result += `\n### 完成信息\n`;
      result += `- **完成者**: ${task.finishedBy}\n`;
      result += `- **完成时间**: ${task.finishedDate}\n`;
    }
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return { content: [{ type: "text", text: `获取任务详情失败: ${err.message}` }], isError: true };
  }
});

// 工具8: 创建任务
server.tool(
  "create_task",
  "在指定执行（迭代）下创建任务",
  {
    executionId: z.number().describe("所属执行（迭代）ID"),
    name: z.string().describe("任务名称"),
    type: z.enum(["design", "devel", "test", "study", "discuss", "ui", "affair", "misc"]).optional().describe("任务类型，默认 devel"),
    assignedTo: z.string().optional().describe("指派给（用户账号）"),
    pri: z.number().optional().describe("优先级 1-4，默认 3"),
    estimate: z.number().optional().describe("预计工时（小时）"),
    desc: z.string().optional().describe("任务描述"),
    story: z.number().optional().describe("关联需求 ID"),
    deadline: z.string().optional().describe("截止日期 YYYY-MM-DD"),
    estStarted: z.string().optional().describe("预计开始日期 YYYY-MM-DD，未传时默认今天"),
    parent: z.number().optional().describe("父任务 ID，传入即创建为该任务的子任务"),
  },
  async ({ executionId, name, type = "devel", assignedTo, pri = 3, estimate, desc, story, deadline, estStarted, parent }) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const body = {
        name,
        type,
        pri,
        estStarted: estStarted || today,
      };
      if (assignedTo) body.assignedTo = assignedTo;
      if (estimate !== undefined) body.estimate = estimate;
      if (desc) body.desc = normalizeDesc(desc);
      if (story) body.story = story;
      if (deadline) body.deadline = deadline;
      if (parent !== undefined) body.parent = parent;

      const created = await zentaoFetch(`/executions/${executionId}/tasks`, "POST", body);
      const id = created.id || created.task?.id || "-";

      // 禅道 REST API 在 POST 创建时会忽略 parent 字段，需要 PUT 一次绑定
      if (parent !== undefined && id !== "-" && created.parent !== parent) {
        try {
          await zentaoFetch(`/tasks/${id}`, "PUT", { parent });
        } catch (e) {
          return {
            content: [{ type: "text", text: `⚠️ 任务 #${id} 已创建，但绑定父任务 #${parent} 失败: ${e.message}` }],
          };
        }
      }

      return {
        content: [{ type: "text", text: `✅ 任务已创建: #${id} ${name}（执行 ${executionId}${parent !== undefined ? `，父任务 #${parent}` : ""}）` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `创建任务失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具9: 修改任务
server.tool(
  "update_task",
  "修改任务（标题、状态、指派、工时等）",
  {
    taskId: z.number().describe("任务 ID"),
    name: z.string().optional().describe("任务名称"),
    status: z.enum(["wait", "doing", "done", "pause", "cancel", "closed"]).optional().describe("任务状态"),
    assignedTo: z.string().optional().describe("指派给（用户账号）"),
    pri: z.number().optional().describe("优先级 1-4"),
    estimate: z.number().optional().describe("预计工时（小时）"),
    consumed: z.number().optional().describe("已消耗工时"),
    left: z.number().optional().describe("剩余工时"),
    desc: z.string().optional().describe("任务描述"),
    deadline: z.string().optional().describe("截止日期 YYYY-MM-DD"),
    story: z.number().optional().describe("关联需求 ID"),
  },
  async ({ taskId, ...rest }) => {
    try {
      const body = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) body[k] = v;
      }
      if (Object.keys(body).length === 0) {
        return { content: [{ type: "text", text: "未提供任何要修改的字段" }], isError: true };
      }
      await zentaoFetch(`/tasks/${taskId}`, "PUT", body);
      const fields = Object.keys(body).join(", ");
      return { content: [{ type: "text", text: `✅ 任务 #${taskId} 已更新（字段: ${fields}）` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `修改任务失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具10: 完成任务
//
// 禅道 18.5 REST 行为：
// - `wait` 状态的任务调 `/finish` 会报「实际完成不能为空」并不修改状态
// - `wait` 状态调 `/start` 时若同时传 `consumed` + `left=0`，禅道会一步把任务直接置为 `done`
//   且自动写入 `finishedBy` / `finishedDate`，比先 start 再 finish 更稳
// - 已经是 `doing` 的任务再调 `/start` 会报错，需要走 `/finish`
// 因此这里按当前 status 选择不同路径，并把 API 错误真实抛回，不再静默成 ✅
server.tool(
  "finish_task",
  "完成任务（将状态置为 done）",
  {
    taskId: z.number().describe("任务 ID"),
    consumed: z.number().optional().describe("总消耗工时（小时），默认 0.5"),
    currentConsumed: z.number().optional().describe("本次新增消耗工时（小时）"),
    comment: z.string().optional().describe("备注说明"),
  },
  async ({ taskId, consumed, currentConsumed, comment = "" }) => {
    try {
      const detail = await zentaoFetch(`/tasks/${taskId}`);
      const currentStatus = detail?.status;
      const totalConsumed = consumed ?? Math.max(Number(detail?.consumed) || 0, 0.5);

      if (currentStatus === "done" || currentStatus === "closed") {
        return { content: [{ type: "text", text: `任务 #${taskId} 已是 ${currentStatus}，无需重复完成` }] };
      }

      if (currentStatus === "wait") {
        // wait → 直接通过 /start + left=0 一步置 done
        const startBody = { consumed: totalConsumed, left: 0, comment };
        if (currentConsumed !== undefined) startBody.currentConsumed = currentConsumed;
        await zentaoFetch(`/tasks/${taskId}/start`, "POST", startBody);
      } else {
        // doing / pause 等 → 走 /finish，需要 realFinish
        const today = new Date();
        const realFinish = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} ${String(today.getHours()).padStart(2, "0")}:${String(today.getMinutes()).padStart(2, "0")}:${String(today.getSeconds()).padStart(2, "0")}`;
        const finishBody = { consumed: totalConsumed, realFinish, comment };
        if (currentConsumed !== undefined) finishBody.currentConsumed = currentConsumed;
        await zentaoFetch(`/tasks/${taskId}/finish`, "POST", finishBody);
      }

      return { content: [{ type: "text", text: `✅ 任务 #${taskId} 已完成${comment ? `，备注: ${comment}` : ""}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `完成任务失败: ${err.message}` }], isError: true };
    }
  },
);

// ============ 项目相关工具 ============

const PROJECT_STATUS_LABELS = {
  wait: "未开始",
  doing: "进行中",
  suspended: "已挂起",
  closed: "已关闭",
  delay: "已延期",
};

// 工具11: 获取项目列表
server.tool(
  "get_projects",
  "获取项目列表",
  {
    page: z.number().optional().describe("页码，默认 1"),
    limit: z.number().optional().describe("每页数量，默认 20"),
    status: z.enum(["all", "wait", "doing", "suspended", "closed"]).optional().describe("项目状态筛选，默认 all"),
  },
  async ({ page = 1, limit = 20, status = "all" }) => {
    try {
      const query = `?page=${page}&limit=${limit}${status !== "all" ? `&status=${status}` : ""}`;
      const data = await zentaoFetch(`/projects${query}`);
      const projects = data.projects || [];
      let result = `## 项目列表 (共 ${data.total ?? projects.length} 条，当前页 ${projects.length} 条)\n\n`;
      if (projects.length === 0) {
        result += "暂无项目";
      } else {
        result += "| ID | 名称 | 状态 | 开始时间 | 结束时间 | 负责人 |\n";
        result += "|---|---|---|---|---|---|\n";
        for (const p of projects) {
          const pm = typeof p.PM === "object" ? p.PM?.realname || p.PM?.account : p.PM;
          result += `| ${p.id} | ${p.name} | ${PROJECT_STATUS_LABELS[p.status] || p.status} | ${p.begin || "-"} | ${p.end || "-"} | ${pm || "-"} |\n`;
        }
      }
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `获取项目列表失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具12: 获取项目详情
server.tool("get_project_detail", "获取指定项目的详细信息", { projectId: z.number().describe("项目 ID") }, async ({ projectId }) => {
  try {
    const project = await zentaoFetch(`/projects/${projectId}`);
    const pm = typeof project.PM === "object" ? project.PM?.realname || project.PM?.account : project.PM;

    let result = `## 项目 #${project.id}: ${project.name}\n\n`;
    result += `- **状态**: ${PROJECT_STATUS_LABELS[project.status] || project.status}\n`;
    result += `- **代号**: ${project.code || "-"}\n`;
    result += `- **类型**: ${project.model || project.type || "-"}\n`;
    result += `- **负责人**: ${pm || "-"}\n`;
    result += `- **开始时间**: ${project.begin || "-"}\n`;
    result += `- **结束时间**: ${project.end || "-"}\n`;
    result += `- **预计工时**: ${project.days ?? "-"} 天\n`;
    if (project.desc) result += `\n### 描述\n\n${project.desc}\n`;
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return { content: [{ type: "text", text: `获取项目详情失败: ${err.message}` }], isError: true };
  }
});

// ============ 执行（迭代）相关工具 ============

// 工具13: 获取迭代（执行）列表
server.tool(
  "get_executions",
  "获取迭代（执行）列表，可按项目筛选",
  {
    projectId: z.number().optional().describe("所属项目 ID（不传则查询全部）"),
    page: z.number().optional().describe("页码，默认 1"),
    limit: z.number().optional().describe("每页数量，默认 20"),
    status: z.enum(["all", "wait", "doing", "suspended", "closed"]).optional().describe("迭代状态筛选，默认 all"),
  },
  async ({ projectId, page = 1, limit = 20, status = "all" }) => {
    try {
      const query = `?page=${page}&limit=${limit}${status !== "all" ? `&status=${status}` : ""}`;
      const path = projectId ? `/projects/${projectId}/executions${query}` : `/executions${query}`;
      const data = await zentaoFetch(path);
      const executions = data.executions || [];

      let result = `## 迭代列表${projectId ? `（项目 ${projectId}）` : ""} (共 ${data.total ?? executions.length} 条，当前页 ${executions.length} 条)\n\n`;
      if (executions.length === 0) {
        result += "暂无迭代";
      } else {
        result += "| ID | 名称 | 状态 | 类型 | 开始时间 | 结束时间 | 所属项目 |\n";
        result += "|---|---|---|---|---|---|---|\n";
        for (const e of executions) {
          result += `| ${e.id} | ${e.name} | ${PROJECT_STATUS_LABELS[e.status] || e.status} | ${e.type || "-"} | ${e.begin || "-"} | ${e.end || "-"} | ${e.project || "-"} |\n`;
        }
      }
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `获取迭代列表失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具14: 获取迭代（执行）详情
server.tool("get_execution_detail", "获取指定迭代（执行）的详细信息", { executionId: z.number().describe("迭代（执行）ID") }, async ({ executionId }) => {
  try {
    const execution = await zentaoFetch(`/executions/${executionId}`);
    const pm = typeof execution.PM === "object" ? execution.PM?.realname || execution.PM?.account : execution.PM;

    let result = `## 迭代 #${execution.id}: ${execution.name}\n\n`;
    result += `- **状态**: ${PROJECT_STATUS_LABELS[execution.status] || execution.status}\n`;
    result += `- **类型**: ${execution.type || "-"}\n`;
    result += `- **代号**: ${execution.code || "-"}\n`;
    result += `- **所属项目**: ${execution.project || "-"}\n`;
    result += `- **负责人**: ${pm || "-"}\n`;
    result += `- **开始时间**: ${execution.begin || "-"}\n`;
    result += `- **结束时间**: ${execution.end || "-"}\n`;
    result += `- **总预计工时**: ${execution.totalEstimate ?? "-"}\n`;
    result += `- **总消耗工时**: ${execution.totalConsumed ?? "-"}\n`;
    result += `- **总剩余工时**: ${execution.totalLeft ?? "-"}\n`;
    if (execution.desc) result += `\n### 描述\n\n${execution.desc}\n`;
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return { content: [{ type: "text", text: `获取迭代详情失败: ${err.message}` }], isError: true };
  }
});

// 读取项目团队成员账号（新建迭代时用于继承团队）。
// 走 web 端点 /project-team-{id}.json：REST 的 /projects/{id} 不返回成员列表。
async function getProjectTeamAccounts(projectId) {
  const data = await zentaoWebFetch(`/project-team-${projectId}.json`);
  const tm = data?.teamMembers;
  const arr = Array.isArray(tm) ? tm : tm && typeof tm === "object" ? Object.values(tm) : [];
  return arr.map((m) => m.account).filter(Boolean);
}

// 禅道网页会话（cookie）登录。
// 「团队管理」等表单写操作不接受 REST 的 Token 认证，必须用网页会话 cookie：
// 先取 sessionID，再表单登录拿到可用的 zentaosid。结果缓存，过期时由调用方刷新。
let cachedWebSession = null;
async function getWebSession(forceRefresh = false) {
  if (cachedWebSession && !forceRefresh) return cachedWebSession;
  const sresp = await fetch(`${ZENTAO_URL}/api-getsessionid.json`);
  let sd = (await sresp.json()).data;
  if (typeof sd === "string") sd = JSON.parse(sd);
  const sid = sd.sessionID;
  const cookie = `zentaosid=${sid}; lang=zh-cn; device=desktop`;
  const login = await fetch(`${ZENTAO_URL}/user-login.json?zentaosid=${sid}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ account: ZENTAO_ACCOUNT, password: ZENTAO_PASSWORD }).toString(),
  });
  const lt = await login.json().catch(() => ({}));
  if (lt.result && lt.result !== "success") {
    throw new Error(`网页登录失败: ${lt.message || JSON.stringify(lt).slice(0, 120)}`);
  }
  cachedWebSession = { sid, cookie };
  return cachedWebSession;
}

// 通过网页「团队管理」表单设置迭代团队（REST 不支持设置 execution 团队）。
// 表单字段为并列数组：accounts[] / roles[] / days[] / hours[] 与按下标的 limited[i]。
// 会整体覆盖该迭代的团队为 accounts。session 过期时刷新重试一次。
async function setExecutionTeam(executionId, accounts, { days = 10, hours = 7 } = {}) {
  if (!accounts?.length) return 0;
  const buildBody = () => {
    const params = new URLSearchParams();
    accounts.forEach((a, i) => {
      params.append("accounts[]", a);
      params.append("roles[]", "");
      params.append("days[]", String(days));
      params.append("hours[]", String(hours));
      params.append(`limited[${i}]`, "no");
    });
    return params.toString();
  };
  const submit = async (session) => {
    const resp = await fetch(`${ZENTAO_URL}/execution-manageMembers-${executionId}.json?zentaosid=${session.sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: session.cookie },
      body: buildBody(),
    });
    const txt = await resp.text();
    let res;
    try {
      res = JSON.parse(txt);
    } catch {
      res = {};
    }
    return { ok: res.result === "success", res, status: resp.status };
  };

  let out = await submit(await getWebSession());
  if (!out.ok) {
    // 可能是会话过期/未登录，刷新后重试一次
    out = await submit(await getWebSession(true));
  }
  if (!out.ok) {
    throw new Error(out.res.message || `提交团队表单失败 (HTTP ${out.status})`);
  }
  return accounts.length;
}

// 工具: 新建迭代（执行）。默认继承所属项目的团队成员，避免新迭代空团队导致派单失败。
server.tool(
  "create_execution",
  "在指定项目下新建迭代（执行），默认自动继承所属项目的团队成员",
  {
    projectId: z.number().describe("所属项目 ID"),
    name: z.string().describe("迭代名称"),
    code: z.string().optional().describe("迭代代号，默认按日期生成"),
    begin: z.string().optional().describe("开始日期 YYYY-MM-DD，默认今天"),
    end: z.string().optional().describe("结束日期 YYYY-MM-DD，默认 14 天后"),
    days: z.number().optional().describe("可用工作日，默认按起止日期估算"),
    inheritTeam: z.boolean().optional().describe("是否继承项目团队成员，默认 true"),
    teamMembers: z.array(z.string()).optional().describe("额外指定的团队成员账号，会与继承的合并去重"),
    desc: z.string().optional().describe("迭代描述"),
  },
  async ({ projectId, name, code, begin, end, days, inheritTeam = true, teamMembers, desc }) => {
    try {
      const fmt = (d) => d.toISOString().slice(0, 10);
      const now = new Date();
      const beginDate = begin || fmt(now);
      const endDate = end || fmt(new Date(now.getTime() + 14 * 86400000));
      const estDays = days ?? Math.max(1, Math.round((new Date(endDate) - new Date(beginDate)) / 86400000));

      // 继承项目团队 + 合并额外指定成员，去重
      let accounts = [];
      let inheritWarning = "";
      if (inheritTeam) {
        try {
          accounts = await getProjectTeamAccounts(projectId);
        } catch (e) {
          inheritWarning = `（继承项目团队失败: ${e.message}）`;
        }
      }
      if (teamMembers?.length) accounts = [...new Set([...accounts, ...teamMembers])];

      // 1) 创建迭代（注意：禅道 POST 会忽略 teamMembers，团队需在第 2 步用表单单独设置）
      const body = {
        project: projectId,
        name,
        code: code || `sprint${beginDate.replace(/-/g, "")}`,
        begin: beginDate,
        end: endDate,
        days: estDays,
      };
      if (desc) body.desc = normalizeDesc(desc);

      const created = await zentaoFetch(`/projects/${projectId}/executions`, "POST", body);
      const id = created.id || created.execution?.id || "-";

      // 2) 通过网页团队管理表单设置团队（REST 无法设置 execution 团队）
      let teamWarning = "";
      if (id !== "-" && accounts.length) {
        try {
          await setExecutionTeam(id, accounts);
        } catch (e) {
          teamWarning = `（⚠️ 设置团队失败: ${e.message}，请在禅道页面手动添加）`;
        }
      }

      // 3) 回读实际团队确认
      let actualTeam = [];
      if (id !== "-") {
        try {
          const detail = await zentaoFetch(`/executions/${id}`);
          actualTeam = (detail.teamMembers || []).map((m) => m.account).filter(Boolean);
        } catch (e) {
          /* 回读失败不阻断 */
        }
      }

      const intended = accounts.length;
      let teamNote;
      if (actualTeam.length) {
        teamNote = `，团队 ${actualTeam.length} 人：${actualTeam.join(", ")}`;
        if (intended && actualTeam.length < intended) {
          teamNote += `（预期 ${intended} 人，部分未写入）`;
        }
      } else if (intended) {
        teamNote = `，团队设置未生效${teamWarning}`;
      } else {
        teamNote = `，未继承到团队成员${inheritWarning || "（项目团队为空？）"}`;
      }

      return { content: [{ type: "text", text: `✅ 迭代已创建: #${id} ${name}（项目 ${projectId}）${teamNote}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `创建迭代失败: ${err.message}` }], isError: true };
    }
  },
);

// ============ 提测：版本（Build）与测试单（TestTask）相关工具 ============

// 工具: 创建版本（Build）。测试单（提测单）必须挂在某个版本上。
server.tool(
  "create_build",
  "在指定执行（迭代）下创建版本（Build），用于提测",
  {
    executionId: z.number().describe("所属执行（迭代）ID"),
    name: z.string().describe("版本名称，如 v1.2.0 / 20260613-提测"),
    productId: z.number().optional().describe("所属产品 ID"),
    builds: z.string().optional().describe("代码版本 / 分支 / commit 说明"),
    desc: z.string().optional().describe("版本说明"),
    date: z.string().optional().describe("打包日期 YYYY-MM-DD，默认今天"),
  },
  async ({ executionId, name, productId, builds, desc, date }) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const body = { name, date: date || today };
      if (productId !== undefined) body.product = productId;
      if (builds) body.builds = builds;
      if (desc) body.desc = normalizeDesc(desc);

      const created = await zentaoFetch(`/executions/${executionId}/builds`, "POST", body);
      const id = created.id || created.build?.id || "-";
      return { content: [{ type: "text", text: `✅ 版本已创建: #${id} ${name}（执行 ${executionId}）` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `创建版本失败: ${err.message}` }], isError: true };
    }
  },
);

// 工具: 创建测试单（提测）。提测后测试负责人会在「我的测试单」看到。
server.tool(
  "create_testtask",
  "创建测试单（提测单），指派测试负责人进行测试",
  {
    productId: z.number().describe("所属产品 ID"),
    name: z.string().describe("测试单名称，如「需求#101 提测」"),
    build: z.union([z.number(), z.string()]).describe("关联版本（Build）ID"),
    owner: z.string().describe("测试负责人（用户账号）"),
    begin: z.string().optional().describe("开始日期 YYYY-MM-DD，默认今天"),
    end: z.string().optional().describe("结束日期 YYYY-MM-DD，默认 3 天后"),
    executionId: z.number().optional().describe("所属执行（迭代）ID"),
    pri: z.number().optional().describe("优先级 1-4，默认 3"),
    type: z.string().optional().describe("测试类型，默认 function"),
    desc: z.string().optional().describe("测试说明 / 验收标准"),
  },
  async ({ productId, name, build, owner, begin, end, executionId, pri = 3, type = "function", desc }) => {
    try {
      const fmt = (d) => d.toISOString().slice(0, 10);
      const now = new Date();
      const body = {
        product: productId,
        name,
        build: String(build),
        owner,
        begin: begin || fmt(now),
        end: end || fmt(new Date(now.getTime() + 3 * 86400000)),
        pri,
        type,
      };
      if (executionId !== undefined) body.execution = executionId;
      if (desc) body.desc = normalizeDesc(desc);

      const created = await zentaoFetch(`/testtasks`, "POST", body);
      const id = created.id || created.testtask?.id || "-";
      return { content: [{ type: "text", text: `✅ 测试单已创建: #${id} ${name}，负责人 ${owner}，版本 ${build}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `创建测试单失败: ${err.message}` }], isError: true };
    }
  },
);

// ============ 启动服务 ============

const transport = new StdioServerTransport();
await server.connect(transport);
