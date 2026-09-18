import {
  loadBaseline, saveBaseline, loadLocks, saveLocks, appendLog
} from "../core.js";

export const name = "title_rename";
export const description = "实时重命名指定会话的标题（走运行时 session:update）。不传目标时作用于当前会话。写下的标题会记入基线，此后用户手动改名会触发自动锁定。";
export const parameters = {
  type: "object",
  properties: {
    title: { type: "string", description: "新的标题，建议「类别 emoji 对象｜目标」格式" },
    sessionId: { type: "string", description: "目标会话 ID（sess_ 前缀），可选" },
    sessionPath: { type: "string", description: "目标会话 JSONL 路径，可选" }
  },
  required: ["title"]
};
export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "local_write",
    summary: "通过 session:update 更新指定会话的标题并记入基线",
    ruleId: "title-rename"
  })
};

export async function execute(input, ctx) {
  const title = String(input.title || "").trim();
  if (!title) return { content: [{ type: "text", text: "FAIL: title 不能为空" }] };

  const sessionId = input.sessionId ? String(input.sessionId) : null;
  const sessionPath = input.sessionPath ? String(input.sessionPath) : (!sessionId && ctx.sessionPath ? String(ctx.sessionPath) : null);
  if (!sessionId && !sessionPath) {
    return { content: [{ type: "text", text: "FAIL: 无法定位目标会话" }] };
  }

  const payload = { title };
  if (sessionId) payload.sessionId = sessionId;
  else payload.sessionPath = sessionPath;

  const res = await ctx.bus.request("session:update", payload);
  if (!res?.ok) {
    return { content: [{ type: "text", text: "FAIL: " + JSON.stringify(res).slice(0, 300) }] };
  }

  // 记基线 + 日志（手动写入同样受锁定机制保护）
  const dataDir = ctx.dataDir;
  const key = sessionPath || null;
  if (key) {
    const baseline = loadBaseline(dataDir);
    baseline[key] = title;
    saveBaseline(dataDir, baseline);
    appendLog(dataDir, { via: "manual", sessionPath: key, sessionId, event: "renamed", newTitle: title });
  }

  return {
    content: [{ type: "text", text: `OK: 已改名「${title}」${sessionId ? " (" + sessionId + ")" : ""}` }],
    details: { titleRename: { sessionId, sessionPath, title } }
  };
}
