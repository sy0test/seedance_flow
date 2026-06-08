import u from "@/utils";
import { loadSkill } from "./skillLoader";
import type { PipelineStage } from "./types";
import type { MessageBuilder } from "@/socket/resTool";
import type { ContentStream } from "@/socket/resTool";
import Memory from "@/utils/agent/memory";
import { tool, jsonSchema } from "ai";
import { z } from "zod";
import syncStoryboardShots from "@/utils/syncStoryboardShots";
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

interface ChatPipelineContext {
  episodeId: number;
  userMessage: string;
  textStream: ContentStream<string>;
  resTool: any;
  msg: MessageBuilder;
  abortSignal: AbortSignal;
  isolationKey: string;
  socket: any;
}

type StageOutput = {
  stage: string;
  stageStatus: string | null;
  messages?: string;
  content?: string;
  reviewFeedback?: string;
};

type Intent =
  | { type: "start"; stage: PipelineStage }
  | { type: "modify"; stage: PipelineStage }
  | { type: "confirm"; stage: PipelineStage }
  | { type: "chat" };

const stageNames: Record<PipelineStage, string> = {
  director_analysis: "导演分析",
  art_design: "服化道设计",
  seedance_prompts: "分镜提示词",
};

const episodeStatusMap: Record<PipelineStage, string> = {
  director_analysis: "directing",
  art_design: "designing",
  seedance_prompts: "done",
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

function removeAllXmlTags(text: string): string {
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>/g, "");
  text = text.replace(/<([a-zA-Z][\w-]*)(\s+[^>]*)?\/>/g, "");
  text = text.replace(/<\/?[a-zA-Z][\w-]*(\s+[^>]*)?>/g, "");
  return text.trim();
}

export async function runStageWithStream(ctx: ChatPipelineContext): Promise<void> {
  trace(">>> runStageWithStream", ctx.episodeId, ctx.userMessage.slice(0, 30));
  const episode = await u.db("seedance_episode").where("id", ctx.episodeId).first();
  if (!episode) {
    ctx.textStream.append("未找到该集数");
    trace("<<< runStageWithStream 未找到集数");
    return;
  }

  const config = await u.db("seedance_project").where("projectId", episode.projectId).first();
  const visualStyle = config?.visualStyle || "真人写实";
  const targetMedium = config?.targetMedium || "短剧";
  const aspectRatio = config?.aspectRatio || "16:9";

  // ★ 意图识别：根据用户消息决定 confirm / start / modify / chat
  const outputs = await u.db("seedance_output").where("episodeId", ctx.episodeId) as StageOutput[];
  const intent = detectIntent(ctx.userMessage.trim(), outputs);
  trace(">>> intent", intent.type, intent.type !== "chat" ? (intent as any).stage : "");
  const memory = new Memory("seedanceAgent", ctx.isolationKey);

  switch (intent.type) {
    case "confirm":
      await handleConfirm(ctx, intent.stage, memory);
      trace("<<< handleConfirm done");
      return;
    case "start":
    case "modify":
      await handleStartOrModify(ctx, episode, intent, visualStyle, targetMedium, aspectRatio, memory);
      trace("<<< handleStartOrModify done");
      return;
    case "chat":
      ctx.textStream.append(
        "请使用以下指令操作 Seedance 管线：\n\n" +
        "▶️ **开始阶段**\n" +
        "  • `开始导演分析` — 分析剧本，提取人物/场景/分镜要素\n" +
        "  • `开始服化道设计` — 设计角色造型和场景环境提示词\n" +
        "  • `开始分镜提示词` — 编写 Seedance 2.0 视频生成提示词\n\n" +
        "✅ **确认通过**\n" +
        "  • 输入 `通过` 确认当前阶段审核\n\n" +
        "🔄 **修改重做**\n" +
        "  • `修改导演分析` / `修改服化道` / `修改分镜` — 重新执行指定阶段\n" +
        "  • 或直接输入修改意见，AI 会按你的要求调整\n\n"
      );
      return;
  }
  trace("<<< runStageWithStream 意外走到结尾");
}

// ====== 意图识别 ======

function detectIntent(userMessage: string, outputs: StageOutput[]): Intent {
  if (!userMessage) {
    const nextStage = determineNextStageLogic(outputs);
    if (nextStage) return { type: "start", stage: nextStage };
    return { type: "chat" };
  }

  // 1. 检测确认意图——当前有 review 状态的阶段，且用户说"通过"/"确认"
  const reviewingStage = outputs.find(o => o.stageStatus === "review");
  if (reviewingStage && /^(通过|确认|可以|好的|pass|confirm|approve)/i.test(userMessage)) {
    return { type: "confirm", stage: reviewingStage.stage as PipelineStage };
  }

  // 2. 检测修改意图（"修改导演分析"、"调整服化道"等）
  const modStage = detectModificationRequest(userMessage, outputs);
  if (modStage) return { type: "modify", stage: modStage };

  // 3. 检测开始/执行意图
  trace(">>> detectIntent 检查开始正则:", /^(开始|执行|继续|下一步|go|start|run|next)/i.test(userMessage));
  if (/^(开始|执行|继续|下一步|go|start|run|next)/i.test(userMessage)) {
    const specifiedStage = extractStageFromMessage(userMessage);
    if (specifiedStage) {
      // 如果指定的阶段正在审核中，引导用户说"通过"确认
      if (reviewingStage?.stage === specifiedStage) {
        return { type: "chat" };
      }
      return { type: "start", stage: specifiedStage };
    }
    // 否则找下一个 pending/failed 阶段
    const nextStage = determineNextStageLogic(outputs);
    if (nextStage) return { type: "start", stage: nextStage };
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

function determineNextStageLogic(outputs: StageOutput[]): PipelineStage | null {
  const stages: PipelineStage[] = ["director_analysis", "art_design", "seedance_prompts"];
  for (const stage of stages) {
    const output = outputs.find(o => o.stage === stage);
    if (!output) return stage;
    if (output.stageStatus === "review") return null;
    if (output.stageStatus === "pending" || output.stageStatus === "failed") return stage;
  }
  return null;
}

// ====== 处理器 ======

async function handleConfirm(ctx: ChatPipelineContext, stage: PipelineStage, memory: Memory): Promise<void> {
  trace(">>> handleConfirm", stage);
  await u.db("seedance_output")
    .where({ episodeId: ctx.episodeId, stage })
    .update({ stageStatus: "passed", updatedAt: Date.now() });

  await u.db("seedance_episode")
    .where("id", ctx.episodeId)
    .update({ status: episodeStatusMap[stage] });

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

  // 保存确认对话到记忆
  const confirmText = `✅ 「${stageNames[stage]}」已通过！`;
  await memory.add("user", ctx.userMessage);
  await memory.add("assistant", confirmText, { name: "Seedance" });

  ctx.socket?.emit("stageStatus", { episodeId: ctx.episodeId, stage, status: "passed" });
  ctx.textStream.append(confirmText);
  trace("<<< handleConfirm");
}

async function handleStartOrModify(
  ctx: ChatPipelineContext,
  episode: any,
  intent: { type: "start" | "modify"; stage: PipelineStage },
  visualStyle: string,
  targetMedium: string,
  aspectRatio: string,
  memory: Memory,
): Promise<void> {
  const stage = intent.stage;
  trace(">>> handleStartOrModify", stage, "type:", intent.type);

  // 如果是修改请求，先重置阶段状态
  if (intent.type === "modify") {
    await u.db("seedance_output")
      .where({ episodeId: ctx.episodeId, stage })
      .update({ stageStatus: "failed", messages: JSON.stringify([]), updatedAt: Date.now() });
    ctx.socket?.emit("stageStatus", { episodeId: ctx.episodeId, stage, status: "failed" });
    const retrySignalCard = ctx.msg.text("🔄 重试信号");
    try {
      retrySignalCard.append(`检测到修改请求，正在重新执行「${stageNames[stage]}」阶段...`);
    } finally {
      retrySignalCard.complete();
    }
  }

  // start 请求：检查前置阶段是否已完成
  const stageOrder: PipelineStage[] = ["director_analysis", "art_design", "seedance_prompts"];
  const curIdx = stageOrder.indexOf(stage);
  for (let i = 0; i < curIdx; i++) {
    const prev = await u.db("seedance_output").where({ episodeId: ctx.episodeId, stage: stageOrder[i] }).first();
    if (!prev || prev.stageStatus === "review") {
      ctx.textStream.append(`⚠️ 请先完成「${stageNames[stageOrder[i]]}」阶段的审核。\n可以在聊天框中输入"通过"确认，或提出修改意见。\n`);
      return;
    }
    if (prev.stageStatus !== "passed") {
      ctx.textStream.append(`⚠️ 「${stageNames[stageOrder[i]]}」阶段尚未完成，无法开始「${stageNames[stage]}」。\n`);
      return;
    }
  }

  // 获取或创建 output 记录（设为 generating）
  await ensureOutput(ctx.episodeId, stage, ctx);
  const output = await u.db("seedance_output").where({ episodeId: ctx.episodeId, stage }).first();
  const messages = output?.messages ? JSON.parse(output.messages) : [];

  // 创建审计任务
  const task = await u.task(episode.projectId, stage, `seedanceAgent:${stage}`, {
    describe: `开始${stageNames[stage]}阶段`,
    content: ctx.userMessage,
  });

  const MAX_RETRIES = 3;
  let result = "";
  let review: { passed: boolean; feedback: string } = { passed: true, feedback: "" };
  let retryCount = 0;
  let reviewFeedback = "";

  while (retryCount <= MAX_RETRIES) {
    trace(">>> while loop retry", retryCount, "of", MAX_RETRIES, stage);
    // 执行对应阶段（含错误处理，防止卡在 generating）
    try {
      switch (stage) {
        case "director_analysis": {
          const stageCard = ctx.msg.text(stageNames[stage]);
          try {
            result = await runDirectorWithStream(ctx, episode, visualStyle, targetMedium, aspectRatio, memory, reviewFeedback, stageCard);
          } catch (e) {
            stageCard.error();
            throw e;
          }
          stageCard.complete();
          break;
        }
        case "art_design": {
          const stageCard = ctx.msg.text(stageNames[stage]);
          try {
            result = await runArtDesignWithStream(ctx, episode, visualStyle, targetMedium, aspectRatio, memory, reviewFeedback, stageCard);
          } catch (e) {
            stageCard.error();
            throw e;
          }
          stageCard.complete();
          const extractedAssets = await extractArtDesignAssets(episode.projectId, result);
          await saveArtDesignAssets(ctx.episodeId, episode.projectId, extractedAssets);
          break;
        }
        case "seedance_prompts": {
          const stageCard = ctx.msg.text(stageNames[stage]);
          try {
            result = await runStoryboardWithStream(ctx, episode, visualStyle, targetMedium, aspectRatio, memory, reviewFeedback, stageCard);
          } catch (e) {
            stageCard.error();
            throw e;
          }
          stageCard.complete();
          break;
        }
        default:
          ctx.textStream.append("未知阶段");
          await task(-1, "未知阶段");
          return;
      }
    } catch (e: any) {
      console.error(`[seedanceAgent] stage执行出错 (${stage} retry=${retryCount}):`, e?.stack || e?.message || String(e));
      if (!ctx.abortSignal.aborted) {
        ctx.textStream.append(`\n\n❌ 阶段执行出错: ${e.message}`);
        await u.db("seedance_output")
          .where({ episodeId: ctx.episodeId, stage })
          .update({ stageStatus: "failed", updatedAt: Date.now() });
        ctx.socket?.emit("stageStatus", { episodeId: ctx.episodeId, stage, status: "failed" });
      }
      await task(-1, e.message);
      return;
    }

    // ★ 检查是否在阶段执行中被停止
    if (ctx.abortSignal.aborted) {
      ctx.textStream.append(`\n\n已停止。`);
      await u.db("seedance_output")
        .where({ episodeId: ctx.episodeId, stage })
        .update({ stageStatus: "pending", messages: JSON.stringify(messages), updatedAt: Date.now() });
      ctx.socket?.emit("stageStatus", { episodeId: ctx.episodeId, stage, status: "pending" });
      await task(-1, "已停止");
      return;
    }

    // AI 审核
    ctx.textStream.append(`\n\n---\n**📋 正在审核「${stageNames[stage]}」阶段产出...**\n\n`);
    try {
      review = await runReview(ctx, stage, result);
    } catch (e: any) {
      console.error(`[seedanceAgent] AI审核异常 (${stage} retry=${retryCount}):`, e?.stack || e?.message || String(e));
      ctx.textStream.append(`\n⚠️ AI审核异常，已跳过: ${e.message}`);
      review = { passed: true, feedback: "" };
    }
    ctx.textStream.append(`\n**📋 审核结果：${review.passed ? '✅ 通过' : '❌ 需修改'}**\n`);

    // ★ 检查是否在审核中被停止
    if (ctx.abortSignal.aborted) {
      ctx.textStream.append(`\n\n已停止。`);
      await u.db("seedance_output")
        .where({ episodeId: ctx.episodeId, stage })
        .update({ stageStatus: "pending", messages: JSON.stringify(messages), updatedAt: Date.now() });
      ctx.socket?.emit("stageStatus", { episodeId: ctx.episodeId, stage, status: "pending" });
      await task(-1, "已停止");
      return;
    }

    if (review.passed) break;

    retryCount++;
    if (retryCount > MAX_RETRIES) break;

    // 持久化审核意见到 DB（不 feed 回 AI）
    reviewFeedback = review.feedback;
    await u.db("seedance_output")
      .where({ episodeId: ctx.episodeId, stage })
      .update({
        reviewFeedback: review.feedback,
        messages: JSON.stringify(messages),
        updatedAt: Date.now(),
      });

    const retrySignalCard = ctx.msg.text("🔄 重试信号");
    retrySignalCard.append(`审核未通过，正在根据意见重新生成（第${retryCount}次重试）...`);
    retrySignalCard.complete();

    // 检查是否在保存审核意见后被中止
    if (ctx.abortSignal.aborted) {
      ctx.textStream.append(`\n\n已停止。`);
      await u.db("seedance_output")
        .where({ episodeId: ctx.episodeId, stage })
        .update({
          stageStatus: "pending",
          messages: JSON.stringify(messages),
          updatedAt: Date.now(),
        });
      ctx.socket?.emit("stageStatus", { episodeId: ctx.episodeId, stage, status: "pending" });
      await task(-1, "已停止");
      return;
    }
  }

  // 保存最终结果（保留 XML 标签，供服务端解析 structuredData 和 syncStoryboardShots）
  const rawResult = result;

  // 保存到记忆（带向量嵌入）
  const MAX_HISTORY_PAIRS = 10; // 保留最近 10 轮对话，防止 messages 字段无限膨胀

  // ★ 记忆持久化（含卡片 stage 名称），失败不影响主流程
  try {
    await memory.add("user", ctx.userMessage);
    await memory.add("assistant", removeAllXmlTags(rawResult), { name: `Seedance:${stageNames[stage]}` });
  } catch (e: any) {
    console.error(`[seedanceAgent] 记忆持久化失败 (${stage}):`, e?.message);
  }

  const messagesJson = JSON.stringify([
    ...messages.slice(-MAX_HISTORY_PAIRS * 2),
    { role: "user", content: ctx.userMessage },
    { role: "assistant", content: removeAllXmlTags(rawResult) },
  ]);

  // ★ 不自动通过！设置为 review 等待用户确认通过
  await u.db("seedance_output")
    .where({ episodeId: ctx.episodeId, stage })
    .update({
      content: rawResult,
      messages: messagesJson,
      reviewFeedback: review.feedback,
      stageStatus: "review",
      updatedAt: Date.now(),
    });

  ctx.socket?.emit("stageStatus", { episodeId: ctx.episodeId, stage, status: "review" });

  ctx.textStream.append(`\n\n---\n✅ **「${stageNames[stage]}」阶段已生成完毕。**`);
  if (review.passed) {
    ctx.textStream.append(`\n\n请点击「确认通过」按钮确认，或发送修改意见。`);
  } else {
    ctx.textStream.append(`\n\n审核未通过（已重试${Math.min(retryCount, MAX_RETRIES)}次），请在聊天框中发送修改要求。`);
  }

  await task(review.passed ? 1 : -1, review.feedback || "完成");
  trace("<<< handleStartOrModify", stage);
}

/**
 * 检测用户消息中是否包含修改意图，并识别目标阶段
 */
function detectModificationRequest(userMessage: string, outputs?: StageOutput[]): PipelineStage | null {
  const hasModifyIntent = /修改|调整|重做|重新|modify|change|revise|rework/i.test(userMessage);
  if (!hasModifyIntent) return null;

  if (/导演分析|导演|director/i.test(userMessage)) return "director_analysis";
  if (/服化道|美术|造型|art|design/i.test(userMessage)) return "art_design";
  if (/提示词|分镜|prompt|storyboard|seedance/i.test(userMessage)) return "seedance_prompts";

  // 角色/场景关键词：优先匹配 art_design（服化道阶段负责角色场景设计）
  if (/角色|场景|character|scene/i.test(userMessage)) return "art_design";

  // 未指定具体阶段时，若存在 review 状态的阶段则默认指向它
  if (outputs) {
    const reviewing = outputs.find(o => o.stageStatus === "review");
    if (reviewing) return reviewing.stage as PipelineStage;
  }

  return null;
}

async function ensureOutput(episodeId: number, stage: PipelineStage, ctx?: ChatPipelineContext): Promise<void> {
  const existing = await u.db("seedance_output").where({ episodeId, stage }).first();
  if (existing) {
    await u.db("seedance_output").where({ episodeId, stage }).update({
      stageStatus: "generating",
      updatedAt: Date.now(),
    });
  } else {
    const now = Date.now();
    await u.db("seedance_output").insert({
      episodeId,
      stage,
      stageStatus: "generating",
      content: null,
      assetIds: null,
      reviewFeedback: null,
      messages: JSON.stringify([]),
      createdAt: now,
      updatedAt: now,
    });
  }

  ctx?.socket?.emit("stageStatus", { episodeId, stage, status: "generating" });
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
  const skill = loadSkill("director-skill");
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
  const skill = loadSkill("art-design-skill");
  const template = skill.templates["art-design-template"] || "";
  const guide = skill.references["gemini-image-prompt-guide"] || "";
  const charExamples = skill.examples["character-prompt-examples"] || "";
  const sceneExamples = skill.examples["scene-prompt-examples"] || "";

  const directorOutput = await u.db("seedance_output")
    .where({ episodeId: ctx.episodeId, stage: "director_analysis" })
    .first();
  if (!directorOutput?.content) throw new Error("导演分析尚未完成");

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
    { role: "user", content: userMsg + directorOutput.content },
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
  const skill = loadSkill("seedance-storyboard-skill");
  const template = skill.templates["seedance-prompts-template"] || "";
  const methodology = skill.references["seedance-prompt-methodology"] || "";
  const examples = skill.examples["seedance-prompt-examples"] || "";

  const directorOutput = await u.db("seedance_output")
    .where({ episodeId: ctx.episodeId, stage: "director_analysis" })
    .first();
  const artOutput = await u.db("seedance_output")
    .where({ episodeId: ctx.episodeId, stage: "art_design" })
    .first();
  if (!directorOutput?.content || !artOutput?.content) throw new Error("前置阶段尚未完成");

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
        lines.push(`@图片${imgIndex}  场景参考  ${asset.name}  ${filePath}`);
        imgIndex++;
      }
    }
    assetTable = lines.join("\n");
  }

  const userPrompt = [
    "## 导演讲戏本",
    directorOutput.content,
    "## 服化道设计",
    artOutput.content,
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
  const config = episode?.projectId
    ? await u.db("seedance_project").where("projectId", episode.projectId).first()
    : null;
  const projectConfigBlock = config
    ? `\n\n## 项目配置\n- 视觉风格: ${config.visualStyle || "真人写实"}\n- 目标媒介: ${config.targetMedium || "短剧"}\n- 画面比例: ${config.aspectRatio || "16:9"}`
    : "";

  // 根据阶段从 DB 加载上游上下文注入审核 AI
  const contextParts: string[] = [];
  if (stage === "director_analysis") {
    const episode = await u.db("seedance_episode").where("id", ctx.episodeId).first();
    if (episode?.scriptContent) {
      contextParts.push("## 原始剧本\n" + episode.scriptContent);
    }
  } else if (stage === "art_design") {
    const directorOutput = await u.db("seedance_output")
      .where({ episodeId: ctx.episodeId, stage: "director_analysis" }).first();
    if (directorOutput?.content) {
      contextParts.push("## 导演分析（上游输入）\n" + directorOutput.content);
    }
  } else if (stage === "seedance_prompts") {
    const directorOutput = await u.db("seedance_output")
      .where({ episodeId: ctx.episodeId, stage: "director_analysis" }).first();
    if (directorOutput?.content) {
      contextParts.push("## 导演讲戏本（上游输入）\n" + directorOutput.content);
    }
    const artOutput = await u.db("seedance_output")
      .where({ episodeId: ctx.episodeId, stage: "art_design" }).first();
    if (artOutput?.content) {
      contextParts.push("## 服化道设计/角色场景提示词（上游输入）\n" + artOutput.content);
    }
  }

  const upstreamContext = contextParts.length > 0
    ? "以下是供审核参考的上游上下文信息：\n\n" + contextParts.join("\n\n---\n\n")
    : "";

  const REVIEW_TOTAL_BUDGET_MS = 180_000; // 所有 review skill 合计不超过 3 分钟
  const reviewDeadline = Date.now() + REVIEW_TOTAL_BUDGET_MS;

  for (const skillName of skillNames) {
    trace(">>> runReview skill:", skillName);
    const skill = loadSkill(skillName);
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
    const reviewSystemPrompt = skill.systemPrompt + projectConfigBlock + "\n\n## 重要约束\n1. 必须保留剧本原文中对话的语言，勿擅自翻译\n2. 必须严格遵循用户的最新指令";
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

    try {
      startReviewTimer();
      const result = await u.Ai.Text("universalAi").stream({
        messages: aiMessages,
        abortSignal: reviewTimeoutController.signal,
      });
      let feedbackText = "";
      const consumeReview = (async () => {
        for await (const chunk of result.textStream) {
          startReviewTimer();
          if (ctx.abortSignal.aborted) break;
          if (reviewTimeoutController.signal.aborted && !ctx.abortSignal.aborted) {
            throw new Error(`审核超时（${REVIEW_TIMEOUT_MS / 1000} 秒无响应）`);
          }
          feedbackText += chunk;
          reviewCard.append(chunk);
        }
        return feedbackText;
      })().catch((e) => {
        console.error(`[seedanceAgent] consumeReview 异常:`, e?.stack || e?.message || String(e));
        throw e;
      });
      // 审核流也加硬超时兜底
      const REVIEW_SAFETY_MS = 10_000;
      const reviewForceTimeout = new Promise<string>((_, reject) => {
        setTimeout(() => {
          if (reviewTimeoutController.signal.aborted) {
            reject(new Error(`审核超时（${REVIEW_TIMEOUT_MS / 1000} 秒无响应），已强制终止`));
          } else if (ctx.abortSignal.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
          }
        }, REVIEW_TIMEOUT_MS + REVIEW_SAFETY_MS);
      });
      // 兜底：超时后仍未结束则强制终止
      const reviewHardDeadline = new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error(`审核总时间超过 ${(REVIEW_TIMEOUT_MS + REVIEW_SAFETY_MS * 2) / 1000} 秒，已强制终止`)), REVIEW_TIMEOUT_MS + REVIEW_SAFETY_MS * 2);
      });
      await Promise.race([consumeReview, reviewForceTimeout, reviewHardDeadline]);
      allFeedback.push(feedbackText);
    } finally {
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

async function extractArtDesignAssets(
  projectId: number,
  content: string,
): Promise<Array<{ name: string; type: "role" | "scene"; prompt: string }>> {
  let items: Array<{ name: string; type: "role" | "scene"; prompt: string }> = [];

  // 查询已有资产列表，提供给 AI 参考
  const existingAssets = await u.db("o_assets").where({ projectId }).select("name", "type");
  const existingHint = existingAssets.length
    ? `\n已有资产列表：${existingAssets.map((a: any) => `${a.name}(${a.type})`).join("、")}`
    : "";

  const resultTool = tool({
    description: "返回提取结果时必须调用此工具",
    inputSchema: jsonSchema<{ items: Array<{ name: string; type: "role" | "scene"; prompt: string }> }>(
      z.object({
        items: z.array(z.object({
          name: z.string().describe("角色或场景名称，仅名称不做其他任何表述"),
          type: z.enum(["role", "scene"]).describe("类型：role=角色、scene=场景"),
          prompt: z.string().describe("完整提示词内容，保留原始描述细节"),
        })),
      }).toJSONSchema(),
    ),
    execute: async ({ items: result }) => {
      if (result?.length) items = result;
      return "ok";
    },
  });

  await u.Ai.Text("universalAi").invoke({
    messages: [
      {
        role: "system",
        content: `从服化道设计内容中提取所有角色和场景条目。每个条目需提供：名称(name)、类型(type: role/scene)、提示词(prompt)。
注意："人物提示词"章节下的条目 type=role，"场景提示词"章节下的条目 type=scene。
对于已在已有资产列表中的条目，仍需提取其名称和类型，但 prompt 以本次提取为准。
通过 resultTool 工具返回结果。`,
      },
      {
        role: "user",
        content: `${existingHint}\n\n请从以下服化道设计内容中提取角色和场景条目：\n\n${content}`,
      },
    ],
    tools: { resultTool },
  });

  return items;
}

async function saveArtDesignAssets(
  _episodeId: number,
  projectId: number,
  items: Array<{ name: string; type: "role" | "scene"; prompt: string }>,
): Promise<void> {
  const now = Date.now();
  for (const item of items) {
    const existing = await u.db("o_assets").where({ projectId, name: item.name, type: item.type }).first();
    if (existing) {
      await u.db("o_assets").where("id", existing.id).update({ prompt: item.prompt || "" });
    } else {
      await u.db("o_assets").insert({
        projectId, name: item.name, prompt: item.prompt || "", describe: item.name,
        type: item.type, promptState: "已完成", startTime: now,
      });
    }
  }
}

async function loadExistingAssets(projectId: number, type: string): Promise<string> {
  const assets = await u.db("o_assets")
    .where({ projectId, type: type === "character" ? "role" : "scene" })
    .select("name", "prompt", "id");
  if (!assets.length) return "暂无";
  return assets.map((a: any) => `- ${a.name} | 提示词：${a.prompt || "无"}`).join("\n");
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

        if (chunk.type === "reasoning-delta") {
          textStream.append(chunk.text);
        } else if (chunk.type === "text-delta") {
          fullText += chunk.text;
          textStream.append(chunk.text);
        } else if (chunk.type === "error") {
          throw chunk.error;
        }
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
