import {
  isChatSessionPath, agentFromPath, heuristicBadTitle
} from "../core.js";

export const name = "title_scan";
export const description = "扫描会话标题：找出烂标题（URL、问候、思考过程泄露、超长截断等）和无标题的会话，返回候选清单。纯读取，不做任何修改。";
export const parameters = {
  type: "object",
  properties: {
    agentId: { type: "string", description: "只扫某个 Agent（如 hanako、hanako-lab），留空扫全部" },
    limit: { type: "number", description: "最多返回多少条，默认 50" },
    includeGood: { type: "boolean", description: "是否附带健康标题清单，默认 false" }
  }
};
export const sessionPermission = { readOnly: true };

export async function execute(input, ctx) {
  const res = await ctx.bus.request("session:list", {});
  const list = res?.sessions || res?.items || (Array.isArray(res) ? res : []);
  const limit = Math.max(1, Number(input.limit) || 50);
  const agentFilter = String(input.agentId || "").trim();

  const bad = [];
  const good = [];
  for (const s of list) {
    const sp = s.sessionPath || s.path;
    if (!sp || !isChatSessionPath(sp)) continue;
    const agentId = s.agentId || agentFromPath(sp);
    if (agentFilter && agentId !== agentFilter) continue;
    const title = String(s.title || "").trim();
    const firstMessage = String(s.firstMessage || "").slice(0, 120);
    if (title) {
      const h = heuristicBadTitle(title);
      const item = { sessionId: s.sessionId, agentId, title, reason: h.reason, firstMessage };
      if (h.bad) bad.push(item); else good.push(item);
    } else {
      // 无显式标题：UI 显示首条消息，判断首条消息质量
      const h = heuristicBadTitle(firstMessage);
      const item = { sessionId: s.sessionId, agentId, title: "（无标题）", display: firstMessage, reason: h.bad ? h.reason : "无标题但首条消息尚可", firstMessage };
      bad.push(item);
    }
  }
  bad.sort((a, b) => (a.agentId || "").localeCompare(b.agentId || ""));

  const lines = [`扫描完成：烂标题 ${bad.length} 条，健康 ${good.length} 条。`];
  for (const b of bad.slice(0, limit)) {
    lines.push(`- [${b.agentId}] ${b.reason}｜${b.title === "（无标题）" ? "无标题 → " + b.display.slice(0, 40) : b.title.slice(0, 40)}`);
  }
  if (bad.length > limit) lines.push(`（其余 ${bad.length - limit} 条省略）`);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      titleScan: {
        badCount: bad.length, goodCount: good.length,
        bad: bad.slice(0, limit),
        good: input.includeGood ? good.slice(0, 50) : undefined
      }
    }
  };
}
