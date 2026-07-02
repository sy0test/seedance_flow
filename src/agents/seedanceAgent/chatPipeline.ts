import u from "@/utils";
import { loadSkill } from "./skillLoader";
import { runMiwoWithStream } from "./miwoPipeline";
import type { PipelineStage } from "./types";
import type { MessageBuilder } from "@/socket/resTool";
import type { ContentStream } from "@/socket/resTool";
import Memory from "@/utils/agent/memory";
import syncStoryboardShots from "@/utils/syncStoryboardShots";
// import { resolveArtDesignAssets } from "@/utils/resolveStageAssets";
import fs from "fs";
import path from "path";

// ── 定位追踪日志 ──
const tracePath = path.join(__dirname, "..", "..", "data", "seedance_trace.log");
let traceSeq = 0;
function trace(...args: any[]) {
  traceSeq++;
  const line = `[${Date.now()}] #${traceSeq} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ")}`;
  try { fs.appendFileSync(tracePath, line + "\n"); } catch {}
  console.log(line);
}

export interface ChatPipelineContext {
  episodeId: number;
  userMessage: string;
  textStream: ContentStream<string>;
  resTool: any;
  msg: MessageBuilder;
  abortSignal: AbortSignal;
  isolationKey: string;
  socket: any;
  directorVersion?: string;
}


type Intent =
  | { type: "start"; stage: PipelineStage }
  | { type: "modify"; stage: PipelineStage }
  | { type: "confirm"; stage: PipelineStage }
  | { type: "chat" };

const stageNames: Record<PipelineStage, string> = {
  director_analysis: "导演分析",
  art_design: "服化道设计",
  seedance_prompts: "分镜提示词",
  miwo: "全流程制作",
};


function buildMemPrompt(mem: Awaited<ReturnType<Memory["get"]>>): string {
  let ctx = "";
  if (mem.rag.length) {
    ctx += `[相关记忆]\n${mem.rag.map((r) => r.content).join("\n")}`;
  }
  if (mem.summaries.length) {
    if (ctx) ctx += "\n\n";
    ctx += `[历史摘要]\n${mem.summaries.map((s, i) => `${i + 1}. ${s.content}`).join("\n")}`;
  }
  if (mem.shortTerm.length) {
    if (ctx) ctx += "\n\n";
    ctx += `[近期对话]\n${mem.shortTerm.map((m) => `${m.role}: ${m.content}`).join("\n")}`;
  }
  return ctx ? `## 历史记忆\n以下是你与用户的对话记忆，供参考：\n${ctx}` : "";
}

export async function runStageWithStream(ctx: ChatPipelineContext): Promise<void> {
  trace(">>> runStageWithStream", ctx.episodeId, ctx.userMessage.slice(0, 30));
  const episode = await u.db("seedance_episode").where("id", ctx.episodeId).first();
  if (!episode) {
    ctx.textStream.append("未找到该集数");
    trace("<<< runStageWithStream 未找到集数");
    return;
  }

  const project = await u.db("o_project").where("id", episode.projectId).first();
  ctx.directorVersion = project?.directorManual || "pro";

  const intent = detectIntent(ctx.userMessage.trim());
  trace(">>> intent", intent.type, intent.type !== "chat" ? (intent as any).stage : "");
  const memory = new Memory("seedanceAgent", ctx.isolationKey);

  switch (intent.type) {
    case "confirm":
      await handleConfirm(ctx, intent.stage, memory);
      trace("<<< handleConfirm done");
      return;
    case "start":
      // 新管线：谜沃全流程
      await runMiwoWithStream(ctx);
      trace("<<< runMiwoWithStream done");
      return;
    // ====== 旧管线已注释 ======
    // case "modify":
    //   await handleStartOrModify(ctx, episode, intent, visualStyle, targetMedium, aspectRatio, memory);
    //   trace("<<< handleStartOrModify done");
    //   return;
    case "chat":
      ctx.textStream.append(
        "请使用以下指令操作 Seedance 管线：\n\n" +
        "▶️ **开始制作**\n" +
        "  • `开始` 一键启动全流程制作\n\n" +
        "▶️ **单步执行**\n" +
        "  • `开始导演分析` / `开始服化道设计` / `开始分镜提示词`\n\n" +
        "✅ **确认通过**\n" +
        "  • 输入 `通过` 确认当前阶段审核\n\n" +
        "🔄 **修改重做**\n" +
        "  • `修改导演分析` / `修改服化道` / `修改分镜`\n"
      );
      return;
  }
  trace("<<< runStageWithStream 意外走到结尾");
}

// ====== 意图识别 ======

function detectIntent(userMessage: string): Intent {
  // 1. 检测确认意图——用户说"通过"/"确认"
  if (/^(通过|确认|可以|好的|pass|confirm|approve)/i.test(userMessage)) {
    return { type: "confirm", stage: "director_analysis" as PipelineStage };
  }

  // 2. 检测修改意图（"修改导演分析"、"调整服化道"等）
  const modStage = detectModificationRequest(userMessage);
  if (modStage) return { type: "modify", stage: modStage };

  // 3. 检测重跑意图（"重跑"、"重新开始"）
  if (/^(重跑|重新开始|rerun)/i.test(userMessage)) {
    return { type: "start", stage: "miwo" as PipelineStage };
  }

  // 4. 检测开始/执行意图
  if (/^(开始|执行|继续|下一步|go|start|run|next)/i.test(userMessage)) {
    const specifiedStage = extractStageFromMessage(userMessage);
    if (specifiedStage) return { type: "start", stage: specifiedStage };
    // 未指定具体阶段 → 走 miwo 全流程
    return { type: "start", stage: "miwo" as PipelineStage };
  }

  // 4. 其他 → 自由对话
  return { type: "chat" };
}

function extractStageFromMessage(userMessage: string): PipelineStage | null {
  if (/导演分析|导演|director/i.test(userMessage)) return "director_analysis";
  if (/服化道|美术|造型|art|design/i.test(userMessage)) return "art_design";
  if (/提示词|分镜|prompt|storyboard|seedance/i.test(userMessage)) return "seedance_prompts";
  return null;
}


function detectModificationRequest(userMessage: string): PipelineStage | null {
  const hasModifyIntent = /修改|调整|重做|重新|modify|change|revise|rework/i.test(userMessage);
  if (!hasModifyIntent) return null;

  if (/导演分析|导演|director/i.test(userMessage)) return "director_analysis";
  if (/服化道|美术|造型|art|design/i.test(userMessage)) return "art_design";
  if (/提示词|分镜|prompt|storyboard|seedance/i.test(userMessage)) return "seedance_prompts";

  if (/角色|场景|character|scene/i.test(userMessage)) return "art_design";

  return null;
}

// ====== 处理器 ======

async function handleConfirm(ctx: ChatPipelineContext, stage: PipelineStage, _memory: Memory): Promise<void> {
  trace(">>> handleConfirm", stage);
  const episode = await u.db("seedance_episode").where("id", ctx.episodeId).first();
  if (episode?.scriptId) {
    await u.db("o_script").where("id", episode.scriptId).update({ extractState: 0 } as any);
  }

  // 分镜提示词确认通过后，立即同步到 o_storyboard
  if (stage === "seedance_prompts") {
    try {
      const synced = await syncStoryboardShots(ctx.episodeId);
      if (synced.length > 0) {
        ctx.textStream.append(`\n📋 已同步 ${synced.length} 条分镜数据到视频制作页。\n`);
      }
    } catch (e: any) {
      ctx.textStream.append(`\n⚠️ 分镜数据同步失败: ${e.message}\n`);
    }
  }

  ctx.socket?.emit("stageStatus", { episodeId: ctx.episodeId, stage, status: "passed" });
  ctx.textStream.append(`✅ 「${stageNames[stage]}」已通过！`);
  trace("<<< handleConfirm");
}

async function ensureOutput(episodeId: number, stage: PipelineStage, ctx?: ChatPipelineContext): Promise<void> {
  const episode = await u.db("seedance_episode").where("id", episodeId).first();
  if (episode?.scriptId) {
    await u.db("o_script").where("id", episode.scriptId).update({ extractState: 1 } as any);
  }
  ctx?.socket?.emit("stageStatus", { episodeId, stage, status: "generating" });
}

/** 从 memories 读上游阶段产出（降级到 seedance_output） */
async function readStageOutput(isolationKey: string, episodeId: number, role: string): Promise<string | null> {
  const mem = await u.db("memories")
    .where({ isolationKey, role })
    .orderBy("createTime", "desc").first();
  if (mem?.content) return mem.content;
  // 降级：旧数据
  const old = await u.db("seedance_output")
    .where({ episodeId, stage: role }).first();
  return old?.content || null;
}

// --- Agent 流式执行 ---

async function runDirectorWithStream(
  ctx: ChatPipelineContext,
  episode: any,
  visualStyle: string,
  targetMedium: string,
  aspectRatio: string,
  memory: Memory,
  reviewFeedback: string,
  cardStream: ContentStream<string>,
): Promise<string> {
  trace(">>> runDirectorWithStream", ctx.episodeId);
  const skill = loadSkill("director-skill", ctx.directorVersion);
  const template = skill.templates["director-analysis-template"] || "";
  const scriptContent = episode?.scriptContent || "";
  const existingCharacters = await loadExistingAssets(episode.projectId, "character");
  const existingScenes = await loadExistingAssets(episode.projectId, "scene");

  const systemPrompt = [
    skill.systemPrompt,
    "## 输出模板",
    template,
    "## 项目配置",
    `- 视觉风格: ${visualStyle}`,
    `- 目标媒介: ${targetMedium}`,
    `- 画面比例: ${aspectRatio}`,
    "## 已有素材库（o_assets）",
    `### 角色资产\n${existingCharacters}`,
    `### 场景资产\n${existingScenes}`,
    "## 重要约束",
    "1. 必须保留剧本原文中对话的语言，勿擅自翻译",
    "2. 必须严格遵循用户的最新指令，用户的指令优先级高于以上所有规则",
  ].join("\n\n");

  // 获取历史记忆
  const mem = await memory.get(ctx.userMessage);
  const memPrompt = buildMemPrompt(mem);

  const baseMessages: any[] = [{ role: "system", content: systemPrompt }];
  const feedbackContext = reviewFeedback ? `

【审核意见】
${reviewFeedback}
` : "";
  const userMsg = ctx.userMessage.trim()
    ? `${ctx.userMessage}${feedbackContext}

---

`
    : "";
  const aiMessages = [
    ...baseMessages,
    ...(memPrompt ? [{ role: "assistant", content: memPrompt }] : []),
    { role: "user", content: userMsg + scriptContent },
  ];

  return streamAI("seedanceAgent:director", aiMessages, cardStream, ctx.abortSignal);
}

async function runArtDesignWithStream(
  ctx: ChatPipelineContext,
  _episode: any,
  visualStyle: string,
  targetMedium: string,
  aspectRatio: string,
  memory: Memory,
  reviewFeedback: string,
  cardStream: ContentStream<string>,
): Promise<string> {
  trace(">>> runArtDesignWithStream", ctx.episodeId);
  const skill = loadSkill("art-design-skill", ctx.directorVersion);
  const template = skill.templates["art-design-template"] || "";
  const guide = skill.references["gemini-image-prompt-guide"] || "";
  const charExamples = skill.examples["character-prompt-examples"] || "";
  const sceneExamples = skill.examples["scene-prompt-examples"] || "";

  const directorContent = await readStageOutput(ctx.isolationKey, ctx.episodeId, "director_analysis");
  if (!directorContent) throw new Error("导演分析尚未完成");

  const systemPrompt = [
    skill.systemPrompt,
    "## 提示词写法指南",
    guide,
    "## 角色提示词示例",
    charExamples,
    "## 场景提示词示例",
    sceneExamples,
    "## 输出模板",
    template,
    "## 项目配置",
    `- 视觉风格: ${visualStyle}`,
    `- 目标媒介: ${targetMedium}`,
    `- 画面比例: ${aspectRatio}`,
    "## 重要约束",
    "1. 必须保留剧本原文中对话的语言，勿擅自翻译",
    "2. 必须严格遵循用户的最新指令，用户的指令优先级高于以上所有规则",
  ].join("\n\n");

  // 获取历史记忆
  const mem = await memory.get(ctx.userMessage);
  const memPrompt = buildMemPrompt(mem);

  const baseMessages: any[] = [{ role: "system", content: systemPrompt }];
  const feedbackContext = reviewFeedback ? `

【审核意见】
${reviewFeedback}
` : "";
  const userMsg = ctx.userMessage.trim()
    ? `${ctx.userMessage}${feedbackContext}

---

`
    : "";
  const aiMessages = [
    ...baseMessages,
    ...(memPrompt ? [{ role: "assistant", content: memPrompt }] : []),
    { role: "user", content: userMsg + directorContent },
  ];

  return streamAI("seedanceAgent:artDesigner", aiMessages, cardStream, ctx.abortSignal);
}

async function runStoryboardWithStream(
  ctx: ChatPipelineContext,
  _episode: any,
  visualStyle: string,
  targetMedium: string,
  aspectRatio: string,
  memory: Memory,
  reviewFeedback: string,
  cardStream: ContentStream<string>,
): Promise<string> {
  trace(">>> runStoryboardWithStream", ctx.episodeId);
  const skill = loadSkill("seedance-storyboard-skill", ctx.directorVersion);
  const template = skill.templates["seedance-prompts-template"] || "";
  const methodology = skill.references["seedance-prompt-methodology"] || "";
  const examples = skill.examples["seedance-prompt-examples"] || "";

  const directorContent = await readStageOutput(ctx.isolationKey, ctx.episodeId, "director_analysis");
  const artContent = await readStageOutput(ctx.isolationKey, ctx.episodeId, "art_design");
  if (!directorContent || !artContent) throw new Error("前置阶段尚未完成");

  const systemPrompt = [
    skill.systemPrompt,
    "## 方法论",
    methodology,
    "## 参考示例",
    examples,
    "## 输出模板",
    template,
    "## 项目配置",
    `- 视觉风格: ${visualStyle}`,
    `- 目标媒介: ${targetMedium}`,
    `- 画面比例: ${aspectRatio}`,
    "## 重要约束",
    "1. 必须保留剧本原文中对话的语言，勿擅自翻译",
    "2. 必须严格遵循用户的最新指令，用户的指令优先级高于以上所有规则",
  ].join("\n\n");

  // 查询场景资产及其关联图片，构建素材对应表
  const sceneAssets = await u.db("o_assets")
    .where({ projectId: _episode.projectId, type: "scene" })
    .whereNotNull("prompt")
    .select("id", "name", "prompt");
  const sceneImageMap: Record<number, string> = {};
  if (sceneAssets.length > 0) {
    const sceneImageRows = await u.db("o_image")
      .whereIn("assetsId", sceneAssets.map(a => a.id))
      .where("state", "已完成")
      .select("assetsId", "filePath");
    for (const row of sceneImageRows) {
      if (row.assetsId != null && !sceneImageMap[row.assetsId]) {
        sceneImageMap[row.assetsId] = row.filePath ?? "";
      }
    }
  }

  let assetTable = "";
  if (Object.keys(sceneImageMap).length > 0) {
    const lines: string[] = ["## 素材对应表\n"];
    let imgIndex = 1;
    for (const asset of sceneAssets) {
      if (asset.id == null) continue;
      const filePath = sceneImageMap[asset.id];
      if (filePath) {
        lines.push(`@图片${imgIndex}  场景参考(id=${asset.id})  ${asset.name}  ${filePath}`);
        imgIndex++;
      }
    }
    assetTable = lines.join("\n");
  }

  const userPrompt = [
    "## 导演讲戏本",
    directorContent,
    "## 服化道设计",
    artContent,
    assetTable,
    "请基于以上内容编写 Seedance 2.0 视频提示词。",
  ].join("\n\n");

  // 获取历史记忆
  const mem = await memory.get(ctx.userMessage);
  const memPrompt = buildMemPrompt(mem);

  const baseMessages: any[] = [{ role: "system", content: systemPrompt }];
  const feedbackContext = reviewFeedback ? `

【审核意见】
${reviewFeedback}
` : "";
  const userMsg = ctx.userMessage.trim()
    ? `${ctx.userMessage}${feedbackContext}

---

`
    : "";
  const aiMessages = [
    ...baseMessages,
    ...(memPrompt ? [{ role: "assistant", content: memPrompt }] : []),
    { role: "user", content: userMsg + userPrompt },
  ];

  return streamAI("seedanceAgent:storyboardArtist", aiMessages, cardStream, ctx.abortSignal);
}

const REVIEW_SKILLS: Record<PipelineStage, string[]> = {
  director_analysis: ["script-analysis-review-skill", "compliance-review-skill"],
  art_design: ["art-direction-review-skill", "compliance-review-skill"],
  seedance_prompts: ["seedance-prompt-review-skill", "compliance-review-skill"],
  miwo: [],
};

const SKILL_CARD_TITLES: Record<string, string> = {
  "script-analysis-review-skill": "📋 剧本分析审核",
  "compliance-review-skill": "📋 合规审核",
  "art-direction-review-skill": "📋 美术指导审核",
  "seedance-prompt-review-skill": "📋 分镜提示词审核",
};
function skillNameToCardTitle(name: string): string {
  return SKILL_CARD_TITLES[name] || `📋 ${name}`;
}

async function runReview(ctx: ChatPipelineContext, stage: PipelineStage, content: string): Promise<{ passed: boolean; feedback: string }> {
  trace(">>> runReview", stage, "contentLen:", content?.length || 0);
  const skillNames = REVIEW_SKILLS[stage];
  const allFeedback: string[] = [];

  // 读取项目配置，注入审核 AI 供风格匹配检查使用
  const episode = await u.db("seedance_episode").where("id", ctx.episodeId).first();
  const project = episode?.projectId
    ? await u.db("o_project").where("id", episode.projectId).first()
    : null;
  const projectConfigBlock = project
    ? `\n\n## 项目配置\n- 视觉风格: ${project.type || "真人写实"}\n- 目标媒介: ${project.mode || "短剧"}\n- 画面比例: ${project.videoRatio || "16:9"}`
    : "";

  // 根据阶段从 DB 加载上游上下文注入审核 AI
  const contextParts: string[] = [];
  if (stage === "director_analysis") {
    const episode = await u.db("seedance_episode").where("id", ctx.episodeId).first();
    if (episode?.scriptContent) {
      contextParts.push("## 原始剧本\n" + episode.scriptContent);
    }
  } else if (stage === "art_design") {
    const dc = await readStageOutput(ctx.isolationKey, ctx.episodeId, "director_analysis");
    if (dc) contextParts.push("## 导演分析（上游输入）\n" + dc);
  } else if (stage === "seedance_prompts") {
    const dc = await readStageOutput(ctx.isolationKey, ctx.episodeId, "director_analysis");
    if (dc) contextParts.push("## 导演讲戏本（上游输入）\n" + dc);
    const ac = await readStageOutput(ctx.isolationKey, ctx.episodeId, "art_design");
    if (ac) contextParts.push("## 服化道设计/角色场景提示词（上游输入）\n" + ac);
  }

  const upstreamContext = contextParts.length > 0
    ? "以下是供审核参考的上游上下文信息：\n\n" + contextParts.join("\n\n---\n\n")
    : "";

  const REVIEW_TOTAL_BUDGET_MS = 600_000; // 所有 review skill 合计不超过 10 分钟
  const reviewDeadline = Date.now() + REVIEW_TOTAL_BUDGET_MS;

  for (const skillName of skillNames) {
    trace(">>> runReview skill:", skillName);
    const skill = loadSkill(skillName, ctx.directorVersion);
    if (!skill.systemPrompt) continue;
    // 检查总审核预算（所有 skill 合计不超过 180s）
    if (Date.now() > reviewDeadline) {
      if (allFeedback.length > 0) break;
      throw new Error(`审核总时间超过 ${REVIEW_TOTAL_BUDGET_MS / 1000} 秒限制`);
    }
    const reviewCard = ctx.msg.text(skillNameToCardTitle(skillName));
    // 写入初始提示，确保即使超时卡片也不为空
    reviewCard.append(`正在审核「${skillNameToCardTitle(skillName).replace(/^📋 /, "")}」...

`);
    const userPrompt = upstreamContext
      ? `${upstreamContext}\n\n---\n\n请审核以下内容：\n\n${content}`
      : `请审核以下内容：\n\n${content}`;
    const userInstructionBlock = ctx.userMessage.trim()
      ? `\n\n## 用户原始指令\n${ctx.userMessage}`
      : "";
    const reviewSystemPrompt = skill.systemPrompt + projectConfigBlock + userInstructionBlock;
    const aiMessages: any[] = [
      { role: "system", content: reviewSystemPrompt },
      { role: "user", content: userPrompt },
    ];
    const REVIEW_TIMEOUT_MS = 60_000; // 审核 30 秒无响应判定超时
    const reviewTimeoutController = new AbortController();
    let reviewTimer: ReturnType<typeof setTimeout> | null = null;
    const startReviewTimer = () => {
      if (reviewTimer) clearTimeout(reviewTimer);
      reviewTimer = setTimeout(() => reviewTimeoutController.abort(), REVIEW_TIMEOUT_MS);
    };
    const clearReviewTimer = () => { if (reviewTimer) { clearTimeout(reviewTimer); reviewTimer = null; } };
    const onReviewAbort = () => { reviewTimeoutController.abort(); clearReviewTimer(); };
    ctx.abortSignal.addEventListener("abort", onReviewAbort, { once: true });

    // 心跳定时器（在 finally 中清理，故定义在 try 外）
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let firstChunkArrived = false;

    try {
      startReviewTimer();
      const result = await u.Ai.Text("universalAi").stream({
        messages: aiMessages,
        abortSignal: reviewTimeoutController.signal,
      });
      // stream 就绪后重置计时器，开始响应超时（60s 无任何 chunk 才算超时）
      startReviewTimer();

      // 应用层心跳：第一个 chunk 到达前每 15s 更新卡片，让前端知道还在处理
      const streamStartTime = Date.now();
      const HEARTBEAT_INTERVAL_MS = 15_000;
      heartbeatTimer = setInterval(() => {
        if (firstChunkArrived) return;
        const waited = Math.floor((Date.now() - streamStartTime) / 1000);
        reviewCard.append(`\n⏳ AI 处理中（已等待 ${waited} 秒）...`);
      }, HEARTBEAT_INTERVAL_MS);

      let feedbackText = "";
      let hasShownThinking = false;
      const consumeReview = (async () => {
        for await (const chunk of result.fullStream) {
          // 第一个 chunk 到达 → 停止心跳
          if (!firstChunkArrived) {
            firstChunkArrived = true;
            clearInterval(heartbeatTimer);
          }
          // 任何 chunk 到达都重置计时器
          startReviewTimer();
          if (ctx.abortSignal.aborted) break;
          if (reviewTimeoutController.signal.aborted && !ctx.abortSignal.aborted) {
            throw new Error(`审核超时（${REVIEW_TIMEOUT_MS / 1000} 秒无响应）`);
          }
          if (chunk.type === "text-delta") {
            feedbackText += chunk.text;
            reviewCard.append(chunk.text);
          } else if (chunk.type === "reasoning-delta") {
            if (!hasShownThinking) {
              reviewCard.append("\n🤔 思考中...");
              hasShownThinking = true;
            }
            // 不展示具体思考内容
          } else if (chunk.type === "error") {
            throw chunk.error;
          }
        }
        return feedbackText;
      })().catch((e) => {
        console.error(`[seedanceAgent] consumeReview 异常:`, e?.stack || e?.message || String(e));
        throw e;
      });
      // 审核流超时兜底（递归轮询，和 streamAI 对齐）
      const REVIEW_SAFETY_MS = 10_000;
      const reviewForceTimeout = new Promise<string>((_, reject) => {
        const check = () => {
          if (reviewTimeoutController.signal.aborted) {
            reject(new Error(`审核超时（${REVIEW_TIMEOUT_MS / 1000} 秒无响应），已强制终止`));
          } else if (ctx.abortSignal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
          } else {
            setTimeout(check, 1000);
          }
        };
        setTimeout(() => check(), REVIEW_TIMEOUT_MS + REVIEW_SAFETY_MS);
      });
      // 兜底：超时后仍未结束则强制终止
      const REVIEW_HARD_DEADLINE_MS = 300_000; // 单个 skill 最长 5 分钟（含排队+思考+输出）
      const reviewHardDeadline = new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error(`审核总时间超过 ${REVIEW_HARD_DEADLINE_MS / 1000} 秒，已强制终止`)), REVIEW_HARD_DEADLINE_MS);
      });
      await Promise.race([consumeReview, reviewForceTimeout, reviewHardDeadline]);
      allFeedback.push(feedbackText);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      clearReviewTimer();
      ctx.abortSignal.removeEventListener("abort", onReviewAbort);
      reviewCard.complete();
    }
  }

  const combinedFeedback = allFeedback.join("\n\n---\n\n");
  const passed = !combinedFeedback.includes("FAIL") &&
    !combinedFeedback.includes("❌") &&
    !combinedFeedback.includes("未通过") &&
    !combinedFeedback.includes("审核不通过");
  return { passed, feedback: combinedFeedback };
}

async function loadExistingAssets(projectId: number, type: string): Promise<string> {
  const assets = await u.db("o_assets")
    .where({ projectId, type: type === "character" ? "role" : "scene" })
    .select("name", "prompt", "id");
  if (!assets.length) return "暂无";
  return assets.map((a: any) => `- ${a.name} (id=${a.id}) | 提示词：${a.prompt || "无"}`).join("\n");
}

async function streamAI(
  agentKey: string,
  messages: any[],
  textStream: ContentStream<string>,
  abortSignal: AbortSignal,
): Promise<string> {
  trace(">>> streamAI", agentKey);
  const TIMEOUT_MS = 60_000; // 60 秒无新 chunk 则判定超时

  // 创建独立的超时控制器
  const timeoutController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const startTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timeoutController.abort();
    }, TIMEOUT_MS);
  };
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  // 用户主动取消时也终止超时控制器
  const onOriginalAbort = () => { timeoutController.abort(); clearTimer(); };
  abortSignal.addEventListener("abort", onOriginalAbort, { once: true });

  try {
    startTimer();
    const result = await u.Ai.Text(agentKey as any).stream({
      messages,
      abortSignal: timeoutController.signal,
    });

    let fullText = "";

    // 用 Promise.race 确保 for-await 不会因为 AI SDK 不响应 abort 而永久挂起
    const consumeResult = (async () => {
      for await (const chunk of result.fullStream) {
        // 有任何 chunk 到达就重置超时定时器
        startTimer();

        if (abortSignal.aborted) break;
        if (timeoutController.signal.aborted && !abortSignal.aborted) {
          throw new Error(`AI 响应超时（${TIMEOUT_MS / 1000} 秒无响应），请重试`);
        }

        if (chunk.type === "text-delta") {
          fullText += chunk.text;
          textStream.append(chunk.text);
        } else if (chunk.type === "error") {
          throw chunk.error;
        }
        // reasoning-delta 不展示内容，但上面的 startTimer() 确保超时计时器被重置
      }
      return fullText;
    })().catch((e) => {
      // 流内部异常日志（不吞异常，继续传播）
      console.error(`[seedanceAgent] streamAI consumeResult 异常:`, e?.stack || e?.message || String(e));
      throw e;
    });

    // 硬超时兜底：超时后额外给 10s 让 SDK 自行关闭，否则强制抛错
    const SAFETY_MARGIN_MS = 10_000;
    const forceTimeout = new Promise<string>((_, reject) => {
      const check = () => {
        if (timeoutController.signal.aborted) {
          reject(new Error(`AI 响应超时（${TIMEOUT_MS / 1000} 秒无响应），已强制终止`));
        } else if (abortSignal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
        } else {
          setTimeout(check, 1000);
        }
      };
      setTimeout(() => check(), TIMEOUT_MS + SAFETY_MARGIN_MS);
    });

    return await Promise.race([consumeResult, forceTimeout]);
  } finally {
    clearTimer();
    abortSignal.removeEventListener("abort", onOriginalAbort);
  }
}

// ====== 旧函数保留引用（避免 TS6133）=======
void ensureOutput;
void runDirectorWithStream;
void runArtDesignWithStream;
void runStoryboardWithStream;
void runReview;
