import fs from "node:fs";
import path from "node:path";
import {
  agentFromPath, isChatSessionPath, heuristicBadTitle, extractTranscript,
  loadCategories, buildNamingPrompt, sampleText, parseNaming,
  loadBaseline, saveBaseline, loadLocks, saveLocks, appendLog
} from "./core.js";

const SETTLE_EVENTS = new Set(["turn_end", "message_end", "tool_execution_end"]);
const ACTIVE_ONLY = new Set(["message_update", "llm_usage", "tool_execution_start", "token_usage", "context_usage"]);

export default class SessionTitleOptimizer {
  async onload() {
    const { dataDir, config, log, bus, pluginId } = this.ctx;
    fs.mkdirSync(dataDir, { recursive: true });

    const shared = {
      dataDir, bus, pluginId, log,
      sessions: new Map(),   // sessionPath -> { sessionPath, agentId, dirtyTs, lastSeenAt, lastEvalAt, lastMsgCount, generating }
      titleCache: new Map(), // sessionPath -> { sessionId, title, firstMessage, agentId }
      titleCacheAt: 0,
      evaluating: 0,
      queue: Promise.resolve()
    };
    globalThis.__sessionTitleOptimizer = shared;

    const cfg = () => ({
      enabled: config.get("enabled") !== false,
      debounceMs: Math.max(3, Number(config.get("debounceSec")) || 12) * 1000,
      minIntervalMs: Math.max(30, Number(config.get("minIntervalSec")) || 180) * 1000,
      driftCheckMessages: Math.max(1, Number(config.get("driftCheckMessages")) || 6),
      maxRenamesPerRun: Math.max(1, Number(config.get("maxRenamesPerRun")) || 20),
      genEndpoint: String(config.get("genEndpoint") || "").trim(),
      genApiKey: String(config.get("genApiKey") || ""),
      genModel: String(config.get("genModel") || "").trim(),
      fallbackEndpoint: String(config.get("fallbackEndpoint") || "").trim(),
      fallbackApiKey: String(config.get("fallbackApiKey") || ""),
      fallbackModel: String(config.get("fallbackModel") || "").trim(),
      debug: config.get("debugEvents") === true
    });

    // ── 调试事件日志 ──
    const debugPath = path.join(dataDir, "debug-events.jsonl");
    const debugSeen = new Set();
    const debugLog = (ev, sp) => {
      if (!cfg().debug) return;
      try {
        const type = ev?.type || (typeof ev === "string" ? ev : "?");
        const key = type + (sp ? "+sp" : "-sp");
        if (debugSeen.has(key)) return;
        debugSeen.add(key);
        fs.appendFileSync(debugPath, JSON.stringify({ ts: new Date().toISOString(), type, hasPath: !!sp }) + "\n");
      } catch { /* ignore */ }
    };

    // ── 标题缓存（session:list，5 分钟 TTL）──
    const refreshTitles = async () => {
      if (Date.now() - shared.titleCacheAt < 5 * 60 * 1000 && shared.titleCache.size) return shared.titleCache;
      try {
        const res = await bus.request("session:list", {});
        const list = res?.sessions || res?.items || (Array.isArray(res) ? res : []);
        for (const s of list) {
          const sp = s.sessionPath || s.path;
          if (!sp) continue;
          shared.titleCache.set(sp, {
            sessionId: s.sessionId || null,
            title: s.title || "",
            firstMessage: (s.firstMessage || "").slice(0, 200),
            agentId: s.agentId || agentFromPath(sp)
          });
        }
        shared.titleCacheAt = Date.now();
      } catch (e) {
        log?.debug?.("[title-opt] session:list failed:", e?.message);
      }
      return shared.titleCache;
    };
    shared.refreshTitles = refreshTitles;

    // ── 会话登记 ──
    const ensure = (sp) => {
      if (!isChatSessionPath(sp)) return null;
      let ent = shared.sessions.get(sp);
      if (!ent) {
        ent = { sessionPath: sp, agentId: agentFromPath(sp), dirtyTs: 0, lastSeenAt: 0, lastEvalAt: 0, lastMsgCount: -1, generating: false };
        shared.sessions.set(sp, ent);
      }
      return ent;
    };

    // ── 核心评估：单个会话 ──
    const evaluate = async (ent) => {
      const c = cfg();
      const sp = ent.sessionPath;
      const info = (await refreshTitles()).get(sp);
      const sessionId = info?.sessionId || null;
      const explicitTitle = String(info?.title || "").trim();

      // 锁定检查：用户手动改过 → 永久跳过
      const locks = loadLocks(dataDir);
      if (locks[sp]) return;

      // 基线检查：上次是我们写的，现在变了 → 用户手动改名 → 锁定
      const baseline = loadBaseline(dataDir);
      if (baseline[sp] && explicitTitle && explicitTitle !== baseline[sp]) {
        locks[sp] = { lockedAt: new Date().toISOString(), reason: "手动改名检测", title: explicitTitle };
        saveLocks(dataDir, locks);
        appendLog(dataDir, { via: "auto", sessionPath: sp, agentId: ent.agentId, event: "locked", title: explicitTitle, reason: "检测到用户手动改名" });
        return;
      }

      const tr = extractTranscript(sp);
      if (tr.messageCount < 2) return; // 至少一轮实质对话
      if (ent.lastMsgCount === tr.messageCount) return; // 没有新消息

      // 评估门槛：标题烂 → 立即；标题好 → 每 N 条新消息复查一次漂移
      const displayTitle = explicitTitle || tr.firstUser.slice(0, 60);
      const bad = heuristicBadTitle(displayTitle);
      const driftDue = tr.messageCount - (ent.lastDriftCheckCount || 0) >= c.driftCheckMessages;
      if (!bad.bad && !driftDue) return;

      const sys = buildNamingPrompt(loadCategories(cfg()));
      const userPayload = JSON.stringify({
        currentTitle: explicitTitle,
        titleFlag: bad.bad ? bad.reason : null,
        firstUserMessage: tr.firstUser,
        recentTurns: tr.excerpt
      });
      const text = await sampleText(bus, cfg(), pluginId, ent.agentId, sys, userPayload, 400);
      const naming = parseNaming(text, explicitTitle);
      if (!naming) {
        appendLog(dataDir, { via: "auto", sessionPath: sp, agentId: ent.agentId, event: "parse_fail", raw: text.slice(0, 120) });
        return;
      }

      if (naming.action === "rename" && naming.title && naming.title !== explicitTitle) {
        if (sessionId) {
          const res = await bus.request("session:update", { sessionId: sessionId || undefined, sessionPath: sp, title: naming.title });
          if (res?.ok) {
            baseline[sp] = naming.title;
            saveBaseline(dataDir, baseline);
            if (info) info.title = naming.title;
            appendLog(dataDir, { via: "auto", sessionPath: sp, agentId: ent.agentId, sessionId, event: "renamed", oldTitle: explicitTitle, newTitle: naming.title, reason: naming.reason, msgCount: tr.messageCount });
            log?.info?.(`[title-opt] renamed ${ent.agentId}: "${explicitTitle}" → "${naming.title}"`);
          }
        }
      } else {
        appendLog(dataDir, { via: "auto", sessionPath: sp, agentId: ent.agentId, event: "kept", title: explicitTitle, reason: naming.reason, msgCount: tr.messageCount });
      }
      if (!bad.bad) ent.lastDriftCheckCount = tr.messageCount;
    };

    shared.evaluateSessionPath = async (sp) => {
      const ent = ensure(sp);
      if (!ent || ent.generating) return null;
      ent.generating = true;
      try { return await evaluate(ent); }
      catch (e) {
        log?.warn?.("[title-opt] evaluate failed:", e?.message);
        try { appendLog(dataDir, { via: "auto", sessionPath: sp, agentId: ent.agentId, event: "error", note: String(e?.message || e).slice(0, 200) }); } catch { /* ignore */ }
        return null;
      }
      finally { ent.generating = false; ent.lastEvalAt = Date.now(); }
    };

    // ── 调度循环 ──
    const tick = () => {
      if (!cfg().enabled) return;
      const now = Date.now();
      const c = cfg();
      for (const [, ent] of shared.sessions) {
        if (!ent.dirtyTs || ent.generating) continue;
        if (now - ent.dirtyTs < c.debounceMs) continue;
        if (now - ent.lastEvalAt < c.minIntervalMs) continue;
        if (shared.evaluating >= 2) break;
        ent.dirtyTs = 0;
        shared.evaluating += 1;
        shared.queue = shared.queue
          .then(() => shared.evaluateSessionPath(ent.sessionPath))
          .catch(() => {})
          .finally(() => { shared.evaluating -= 1; });
      }
    };
    const timer = setInterval(tick, 5000);
    timer.unref?.();
    this.register(() => clearInterval(timer));

    // ── 事件订阅（Hanako 版 Stop Hook）──
    const unsub = bus.subscribe((ev, sp) => {
      debugLog(ev, sp);
      const p = sp || ev?.sessionPath || ev?.meta?.sessionPath || ev?.payload?.sessionPath || null;
      if (!p || !isChatSessionPath(p)) return;
      const t = ev?.type || "";
      const ent = ensure(p);
      if (!ent) return;
      ent.lastSeenAt = Date.now();
      if (ACTIVE_ONLY.has(t)) return;
      ent.dirtyTs = Date.now(); // 已知落定信号 + 未知类型保守标脏
    });
    this.register(unsub);

    // ── 启动播种：预热标题缓存 ──
    refreshTitles().catch(() => {});
    log?.info?.("[title-opt] session-title-optimizer loaded");
  }

  async onunload() {
    delete globalThis.__sessionTitleOptimizer;
  }
}
