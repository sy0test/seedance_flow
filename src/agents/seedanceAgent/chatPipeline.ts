import u from "@/utils";
import { loadSkill } from "./skillLoader";
import type { PipelineStage } from "./types";
import type { MessageBuilder } from "@/socket/resTool";
import type { ContentStream } from "@/socket/resTool";
import Memory from "@/utils/agent/memory";
import { tool, jsonSchema } from "ai";
import { z } from "zod";
import syncStoryboardShots from "@/utils/syncStoryboardShots";

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
  const episode = await u.db("seedance_episode").where("id", ctx.episodeId).first();
  if (!episode) {
    ctx.textStream.append("未找到该集数");
    return;
  }

  const config = await u.db("seedance_project").where("projectId", episode.projectId).first();
  const visualStyle = config?.visualStyle || "真人写实";
  const targetMedium = config?.targetMedium || "短剧";
  const aspectRatio = config?.aspectRatio || "16:9";

  // ★ 意图识别：根据用户消息决定 confirm / start / modify / chat
  const outputs = await u.db("seedance_output").where("episodeId", ctx.episodeId) as StageOutput[];
  const intent = detectIntent(ctx.userMessage.trim(), outputs);
  const memory = new Memory("seedanceAgent", ctx.isolationKey);

  switch (intent.type) {
    case "confirm":
      await handleConfirm(ctx, intent.stage, memory);
      return;
    case "start":
    case "modify":
      await handleStartOrModify(ctx, episode, intent, visualStyle, targetMedium, aspectRatio, memory);
      return;
    case "chat":
      await runFreeChat(ctx, episode, memory);
      return;
  }
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
    if (output.stageStatus === "review") return null; // 审核中的阶段需等待确认
    if (output.stageStatus === "pending" || output.stageStatus === "failed") return stage;
  }
  return null;
}

// ====== 处理器 ======

async function handleConfirm(ctx: ChatPipelineContext, stage: PipelineStage, memory: Memory): Promise<void> {
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

  // 如果是修改请求，先重置阶段状态
  if (intent.type === "modify") {
    await u.db("seedance_output")
      .where({ episodeId: ctx.episodeId, stage })
      .update({ stageStatus: "failed", messages: JSON.stringify([]), updatedAt: Date.now() });
    ctx.socket?.emit("stageStatus", { episodeId: ctx.episodeId, stage, status: "failed" });
    ctx.textStream.append(`检测到修改请求，正在重新执行「${stageNames[stage]}」阶段...\n\n`);
  } else {
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

  while (retryCount <= MAX_RETRIES) {
    // 执行对应阶段（含错误处理，防止卡在 generating）
    try {
      switch (stage) {
        case "director_analysis":
          result = await runDirectorWithStream(ctx, episode, messages, visualStyle, targetMedium, aspectRatio, memory);
          break;
        case "art_design":
          result = await runArtDesignWithStream(ctx, episode, messages, visualStyle, targetMedium, aspectRatio, memory);
          const extractedAssets = await extractArtDesignAssets(episode.projectId, result);
          await saveArtDesignAssets(ctx.episodeId, episode.projectId, extractedAssets);
          break;
        case "seedance_prompts":
          result = await runStoryboardWithStream(ctx, episode, messages, visualStyle, targetMedium, aspectRatio, memory);
          break;
        default:
          ctx.textStream.append("未知阶段");
          await task(-1, "未知阶段");
          return;
      }
    } catch (e: any) {
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
    ctx.textStream.append(`\n\n---\n正在审核「${stageNames[stage]}」阶段产出...\n`);
    try {
      review = await runReview(ctx, stage, result);
    } catch (e: any) {
      ctx.textStream.append(`\n\n⚠️ AI审核异常，已跳过: ${e.message}`);
      review = { passed: true, feedback: "" };
    }

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

    // 将审核意见注入 messages 并持久化到 DB，使重试可恢复
    messages.push({ role: "system", content: `以下是对你之前产出的审核意见，请根据这些意见和用户的修改要求重新生成：\n\n${review.feedback}` });
    await u.db("seedance_output")
      .where({ episodeId: ctx.episodeId, stage })
      .update({
        reviewFeedback: review.feedback,
        messages: JSON.stringify(messages),
        updatedAt: Date.now(),
      });

    ctx.textStream.append(`\n⚠️ 审核未通过，正在根据意见重新生成（第${retryCount}次重试）...\n\n`);

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

  // 保存最终结果（去掉 XML 标签）
  const cleanResult = removeAllXmlTags(result);

  // 保存到记忆（带向量嵌入）
  await memory.add("user", ctx.userMessage);
  await memory.add("assistant", cleanResult, { name: "Seedance" });

  const messagesJson = JSON.stringify([
    ...messages,
    { role: "user", content: ctx.userMessage },
    { role: "assistant", content: cleanResult },
  ]);

  // ★ 不自动通过！设置为 review 等待用户确认通过
  await u.db("seedance_output")
    .where({ episodeId: ctx.episodeId, stage })
    .update({
      content: cleanResult,
      messages: messagesJson,
      reviewFeedback: review.feedback,
      stageStatus: "review",
      updatedAt: Date.now(),
    });

  ctx.socket?.emit("stageStatus", { episodeId: ctx.episodeId, stage, status: "review" });

  ctx.textStream.append(`\n\n---\n「${stageNames[stage]}」阶段已生成完毕。`);
  if (review.passed) {
    ctx.textStream.append(`\n审核意见：${review.feedback ? `\n${review.feedback}` : "无"}`);
    ctx.textStream.append(`\n\n请点击「确认通过」按钮确认，或发送修改意见。`);
  } else {
    ctx.textStream.append(`\n⚠️ 审核未通过（已重试${Math.min(retryCount, MAX_RETRIES)}次），请根据以下意见修改：\n${review.feedback}`);
    ctx.textStream.append(`\n\n请在聊天框中发送修改要求（如"按需修改"），我会根据审核意见重新生成。`);
  }

  await task(review.passed ? 1 : -1, review.feedback || "完成");
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

/**
 * 自由对话模式 — 用户提问/聊天时不触发管线，直接用 AI 回复
 * 参考生产管线的做法：用户消息直接传递，不加额外框架
 */
async function runFreeChat(ctx: ChatPipelineContext, episode: any, memory: Memory): Promise<void> {
  // 收集已有分析上下文
  const context: string[] = [];
  if (episode.scriptContent) {
    context.push(`## 剧本内容\n${episode.scriptContent}`);
  }
  const outputs = await u.db("seedance_output").where("episodeId", ctx.episodeId);
  for (const out of outputs) {
    if (out.content) {
      context.push(`## ${out.stage} 阶段产出\n${out.content}`);
    }
    if (out.reviewFeedback) {
      context.push(`## ${out.stage} 审核意见\n${out.reviewFeedback}`);
    }
  }

  // 获取历史记忆
  const mem = await memory.get(ctx.userMessage);
  const memPrompt = buildMemPrompt(mem);

  const messages: any[] = [
    {
      role: "system",
      content: [
        "你是一个专业的影视制作助手。基于当前剧集的上下文回答用户。",
        "使用用户所用的语言回复，不要擅自翻译。",
        context.length > 0 ? `\n当前上下文：\n${context.join("\n\n---\n\n")}` : "",
      ].filter(Boolean).join("\n"),
    },
    ...(memPrompt ? [{ role: "assistant", content: memPrompt }] : []),
    { role: "user", content: ctx.userMessage }, // 直接传递，不加工
  ];

  // 保存用户消息到记忆
  await memory.add("user", ctx.userMessage);

  const result = await u.Ai.Text("universalAi").stream({ messages, abortSignal: ctx.abortSignal });
  let fullResponse = "";
  for await (const chunk of result.textStream) {
    if (ctx.abortSignal.aborted) break;
    fullResponse += chunk;
    ctx.textStream.append(chunk);
  }

  // 保存助手回复到记忆（去掉 XML 标签）
  const cleanResponse = removeAllXmlTags(fullResponse);
  await memory.add("assistant", cleanResponse, { name: "Seedance" });
}

// --- Agent 流式执行 ---

async function runDirectorWithStream(
  ctx: ChatPipelineContext,
  episode: any,
  messages: any[],
  visualStyle: string,
  targetMedium: string,
  aspectRatio: string,
  memory: Memory,
): Promise<string> {
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
    "## 已有素材",
    `### 已有角色\n${existingCharacters}`,
    `### 已有场景\n${existingScenes}`,
    "## 重要约束",
    "1. 必须保留剧本原文中对话的语言，勿擅自翻译",
    "2. 必须严格遵循用户的最新指令，用户的指令优先级高于以上所有规则",
  ].join("\n\n");

  // 获取历史记忆
  const mem = await memory.get(ctx.userMessage);
  const memPrompt = buildMemPrompt(mem);

  const baseMessages: any[] = [{ role: "system", content: systemPrompt }];
  let aiMessages: any[];
  if (messages.length === 0) {
    const baseUserMsg = `请分析以下剧本第${episode.episodeKey}集：\n\n${scriptContent}`;
    aiMessages = [
      ...baseMessages,
      ...(memPrompt ? [{ role: "assistant", content: memPrompt }] : []),
      { role: "user", content: ctx.userMessage.trim() ? `${ctx.userMessage}\n\n---\n\n${baseUserMsg}` : baseUserMsg },
    ];
  } else {
    aiMessages = [
      ...baseMessages,
      ...(memPrompt ? [{ role: "assistant", content: memPrompt }] : []),
      ...messages,
      { role: "user", content: ctx.userMessage },
    ];
  }

  return streamAI("seedanceAgent:director", aiMessages, ctx.textStream, ctx.abortSignal, ctx.msg);
}

async function runArtDesignWithStream(
  ctx: ChatPipelineContext,
  _episode: any,
  messages: any[],
  visualStyle: string,
  targetMedium: string,
  aspectRatio: string,
  memory: Memory,
): Promise<string> {
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
  let aiMessages: any[];
  if (messages.length === 0) {
    const baseUserMsg = `请根据以下导演分析，设计人物造型和场景环境提示词：\n\n${directorOutput.content}`;
    aiMessages = [
      ...baseMessages,
      ...(memPrompt ? [{ role: "assistant", content: memPrompt }] : []),
      { role: "user", content: ctx.userMessage.trim() ? `${ctx.userMessage}\n\n---\n\n${baseUserMsg}` : baseUserMsg },
    ];
  } else {
    aiMessages = [
      ...baseMessages,
      ...(memPrompt ? [{ role: "assistant", content: memPrompt }] : []),
      ...messages,
      { role: "user", content: ctx.userMessage },
    ];
  }

  return streamAI("seedanceAgent:artDesigner", aiMessages, ctx.textStream, ctx.abortSignal, ctx.msg);
}

async function runStoryboardWithStream(
  ctx: ChatPipelineContext,
  _episode: any,
  messages: any[],
  visualStyle: string,
  targetMedium: string,
  aspectRatio: string,
  memory: Memory,
): Promise<string> {
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
  let aiMessages: any[];
  if (messages.length === 0) {
    aiMessages = [
      ...baseMessages,
      ...(memPrompt ? [{ role: "assistant", content: memPrompt }] : []),
      { role: "user", content: ctx.userMessage.trim() ? `${ctx.userMessage}\n\n---\n\n${userPrompt}` : userPrompt },
    ];
  } else {
    aiMessages = [
      ...baseMessages,
      ...(memPrompt ? [{ role: "assistant", content: memPrompt }] : []),
      ...messages,
      { role: "user", content: ctx.userMessage },
    ];
  }

  return streamAI("seedanceAgent:storyboardArtist", aiMessages, ctx.textStream, ctx.abortSignal, ctx.msg);
}

const REVIEW_SKILLS: Record<PipelineStage, string[]> = {
  director_analysis: ["script-analysis-review-skill", "compliance-review-skill"],
  art_design: ["art-direction-review-skill", "compliance-review-skill"],
  seedance_prompts: ["seedance-prompt-review-skill", "compliance-review-skill"],
};

async function runReview(ctx: ChatPipelineContext, stage: PipelineStage, content: string): Promise<{ passed: boolean; feedback: string }> {
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
    const skill = loadSkill(skillName);
    if (!skill.systemPrompt) continue;
    // 检查总审核预算（所有 skill 合计不超过 180s）
    if (Date.now() > reviewDeadline) {
      if (allFeedback.length > 0) break;
      throw new Error(`审核总时间超过 ${REVIEW_TOTAL_BUDGET_MS / 1000} 秒限制`);
    }
    ctx.textStream.append(`\n【${skillName}】审核中...\n`);
    const userPrompt = upstreamContext
      ? `${upstreamContext}\n\n---\n\n请审核以下内容：\n\n${content}`
      : `请审核以下内容：\n\n${content}`;
    const reviewSystemPrompt = skill.systemPrompt + projectConfigBlock + "\n\n## 重要约束\n1. 必须保留剧本原文中对话的语言，勿擅自翻译\n2. 必须严格遵循用户的最新指令";
    const aiMessages: any[] = [
      { role: "system", content: reviewSystemPrompt },
      { role: "user", content: userPrompt },
    ];
    const REVIEW_TIMEOUT_MS = 30_000; // 审核 30 秒无响应判定超时（原来 60s）
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
      for await (const chunk of result.textStream) {
        startReviewTimer();
        if (ctx.abortSignal.aborted) break;
        if (reviewTimeoutController.signal.aborted && !ctx.abortSignal.aborted) {
          throw new Error(`审核超时（${REVIEW_TIMEOUT_MS / 1000} 秒无响应）`);
        }
        feedbackText += chunk;
        ctx.textStream.append(chunk);
      }
      allFeedback.push(feedbackText);
    } finally {
      clearReviewTimer();
      ctx.abortSignal.removeEventListener("abort", onReviewAbort);
    }
    ctx.textStream.append("\n\n");
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
  if (!assets.length) return "无";
  return assets.map((a: any) => `- ${a.name}: ${a.prompt || "无提示词"}`).join("\n");
}

async function streamAI(
  agentKey: string,
  messages: any[],
  textStream: ContentStream<string>,
  abortSignal: AbortSignal,
  msg?: MessageBuilder,
): Promise<string> {
  const TIMEOUT_MS = 120_000; // 2 分钟无新 chunk 则判定超时

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
    let thinking: ReturnType<MessageBuilder["thinking"]> | null = null;

    for await (const chunk of result.fullStream) {
      // 有任何 chunk 到达就重置超时定时器
      startTimer();

      if (abortSignal.aborted) break;
      if (timeoutController.signal.aborted && !abortSignal.aborted) {
        throw new Error(`AI 响应超时（${TIMEOUT_MS / 1000} 秒无响应），请重试`);
      }

      if (chunk.type === "reasoning-start") {
        thinking = msg?.thinking("思考中...") ?? null;
      } else if (chunk.type === "reasoning-delta") {
        thinking?.appendText(chunk.text);
      } else if (chunk.type === "reasoning-end") {
        thinking?.updateTitle("思考完毕");
        thinking?.complete();
        thinking = null;
      } else if (chunk.type === "text-delta") {
        fullText += chunk.text;
        textStream.append(chunk.text);
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }

    return fullText;
  } finally {
    clearTimer();
    abortSignal.removeEventListener("abort", onOriginalAbort);
  }
}
