import {
  isChatSessionPath, agentFromPath, heuristicBadTitle, extractTranscript,
  loadCategories, buildNamingPrompt, sampleText, parseNaming,
  loadBaseline, saveBaseline, loadLocks, appendLog, buildMigratePrompt
} from "../core.js";

export const name = "title_optimize";
export const description = "批量整理历史会话标题：扫描烂标题 → LLM 按命名规范重写 → 逐个写回。默认 dry_run 只预览不写入。";
export const parameters = {
  type: "object",
  properties: {
    dryRun: { type: "boolean", description: "true=只预览新标题不写入（默认），false=真实写入" },
    agentId: { type: "string", description: "只处理某个 Agent，留空扫全部" },
    limit: { type: "number", description: "本次最多处理多少条，默认受 maxRenamesPerRun 配置限制" },
    applyLimit: { type: "number", description: "覆盖单次写入上限" },
    fallbackEndpoint: { type: "string", description: "临时覆盖降级端点（调试用）" },
    fallbackApiKey: { type: "string", description: "临时覆盖降级端点 Key（调试用）" },
    fallbackModel: { type: "string", description: "临时覆盖降级模型（调试用）" }
  }
};
export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: (input) => ({
    kind: "local_write",
    summary: input?.dryRun === false
      ? "批量更新多个会话的标题（通过 session:update）"
      : "只读扫描并预览新标题，不写入",
    ruleId: "title-optimize"
  })
};

export async function execute(input, ctx) {
  const dryRun = input.dryRun !== false;
  const dataDir = ctx.dataDir;
  const maxRenames = Math.max(1, Number(input.applyLimit) || Number(ctx.config?.get?.("maxRenamesPerRun")) || 20);
  const agentFilter = String(input.agentId || "").trim();

  // 1. 扫描
  const res = await ctx.bus.request("session:list", {});
  const list = res?.sessions || res?.items || (Array.isArray(res) ? res : []);
  const candidates = [];
  for (const s of list) {
    const sp = s.sessionPath || s.path;
    if (!sp || !isChatSessionPath(sp)) continue;
    const agentId = s.agentId || agentFromPath(sp);
    if (agentFilter && agentId !== agentFilter) continue;
    const title = String(s.title || "").trim();
    const firstMessage = String(s.firstMessage || "");
    const h = title ? heuristicBadTitle(title) : heuristicBadTitle(firstMessage.slice(0, 80));
    if (h.bad) candidates.push({ sessionId: s.sessionId, sessionPath: sp, agentId, title, firstMessage, reason: h.reason });
  }

  const locks = loadLocks(dataDir);
  const baseline = loadBaseline(dataDir);
  const cats = loadCategories({
    genEndpoint: "", categoriesJson: String(ctx.config?.get?.("categoriesJson") || "")
  });
  const sysJudge = buildNamingPrompt(cats);
  const sysMigrate = buildMigratePrompt(cats);

  const limit = Math.min(Math.max(1, Number(input.limit) || maxRenames), maxRenames);
  const results = [];
  let applied = 0;

  for (const cand of candidates) {
    if (results.length >= limit) break;
    if (locks[cand.sessionPath]) { results.push({ ...cand, action: "skip", note: "已锁定" }); continue; }
    if (baseline[cand.sessionPath] && cand.title && cand.title !== baseline[cand.sessionPath]) {
      results.push({ ...cand, action: "skip", note: "用户手动改名" });
      continue;
    }

    const tr = extractTranscript(cand.sessionPath);
    if (tr.messageCount < 2) { results.push({ ...cand, action: "skip", note: "对话过短" }); continue; }

    const formatOnly = (cand.reason || "").startsWith("格式不符");
    const userPayload = JSON.stringify({
      currentTitle: cand.title,
      titleFlag: cand.reason || null,
      firstUserMessage: tr.firstUser,
      recentTurns: tr.excerpt
    });

    let naming = null, rawText = "";
    try {
      rawText = await sampleText(ctx.bus, {
        genEndpoint: String(input.genEndpoint || ctx.config?.get?.("genEndpoint") || "").trim(),
        genApiKey: String(input.genApiKey || ctx.config?.get?.("genApiKey") || ""),
        genModel: String(input.genModel || ctx.config?.get?.("genModel") || "").trim(),
        fallbackEndpoint: String(input.fallbackEndpoint || ctx.config?.get?.("fallbackEndpoint") || "").trim(),
        fallbackApiKey: String(input.fallbackApiKey || ctx.config?.get?.("fallbackApiKey") || ""),
        fallbackModel: String(input.fallbackModel || ctx.config?.get?.("fallbackModel") || "").trim()
      }, ctx.pluginId, cand.agentId, formatOnly ? sysMigrate : sysJudge, userPayload, 1500);
      naming = parseNaming(rawText, cand.title, formatOnly);
    } catch (e) {
      results.push({ ...cand, action: "error", note: String(e?.message || e).slice(0, 80) });
      continue;
    }

    if (!naming) { results.push({ ...cand, action: "error", note: "解析失败:" + String(rawText).replace(/\n/g, " ").slice(0, 140) }); continue; }

    if (naming.action === "keep" || !naming.title || naming.title === cand.title) {
      results.push({ ...cand, action: "keep", reason: naming.reason });
      continue;
    }

    if (dryRun) {
      results.push({ ...cand, action: "preview", newTitle: naming.title, reason: naming.reason });
      continue;
    }

    try {
      const r = await ctx.bus.request("session:update", { sessionId: cand.sessionId || undefined, sessionPath: cand.sessionPath, title: naming.title });
      if (r?.ok) {
        baseline[cand.sessionPath] = naming.title;
        saveBaseline(dataDir, baseline);
        appendLog(dataDir, { via: "optimize", sessionPath: cand.sessionPath, agentId: cand.agentId, sessionId: cand.sessionId, event: "renamed", oldTitle: cand.title, newTitle: naming.title, reason: naming.reason });
        results.push({ ...cand, action: "applied", newTitle: naming.title, reason: naming.reason });
        applied += 1;
      } else {
        results.push({ ...cand, action: "error", note: "session:update 失败" });
      }
    } catch (e) {
      results.push({ ...cand, action: "error", note: String(e?.message || e).slice(0, 80) });
    }
  }

  const counts = {};
  for (const r of results) counts[r.action] = (counts[r.action] || 0) + 1;
  const lines = [`${dryRun ? "【预览】" : "【已写入】"}候选 ${candidates.length} 条，处理 ${results.length} 条：${JSON.stringify(counts)}`];
  for (const r of results) {
    const from = r.title === "（无）" || !r.title ? "无标题" : r.title.slice(0, 30);
    if (r.action === "applied" || r.action === "preview") lines.push(`- [${r.agentId}] ${from} → ${r.newTitle}（${r.reason}）`);
    else if (r.action === "keep") lines.push(`- [${r.agentId}] ${from} → keep（${r.reason}）`);
    else lines.push(`- [${r.agentId}] ${from} → ${r.action}（${r.note || ""}）`);
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { titleOptimize: { dryRun, counts, results } }
  };
}
