import u from "@/utils";
import { tool, jsonSchema } from "ai";
import { z } from "zod";
import Memory from "@/utils/agent/memory";
import { createSkillTools, parseFrontmatter, scanSkills } from "@/utils/agent/skillsTools";
import { resolveArtDesignAssets } from "@/utils/resolveStageAssets";
import { ContentStream } from "@/socket/resTool";
import type { ChatPipelineContext } from "./chatPipeline";
import fs from "fs";
import path from "path";

/**
 * 消费 AI fullStream，统一处理 thinking/text/error 输出
 * 从 ProductionAgent 的 consumeFullStream 移植
 */
async function consumeFullStream(
  fullStream: AsyncIterable<any>,
  textStream: ContentStream<string>,
): Promise<string> {
  let fullResponse = "";

  try {
    for await (const chunk of fullStream) {
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 1));
      if (chunk.type === "text-delta") {
        textStream.append(chunk.text);
        fullResponse += chunk.text;
      } else if (chunk.type === "reasoning-delta") {
        textStream.append(chunk.text);
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    textStream.append(errMsg);
    textStream.error();
    throw err;
  }

  return fullResponse;
}

/**
 * 谜沃流程入口：单连接全流程导演管线
 */
export async function runMiwoWithStream(ctx: ChatPipelineContext): Promise<void> {
  const episode = await u.db("seedance_episode").where("id", ctx.episodeId).first();
  if (!episode) return;

  const project = await u.db("o_project").where("id", episode.projectId).first();
  if (!project) return;

  // 检测重跑：清空关联数据
  if (/重跑|重新开始|rerun/i.test(ctx.userMessage)) {
    await u.db("memories").where({ isolationKey: ctx.isolationKey }).del();
    await u.db("seedance_output").where({ episodeId: ctx.episodeId }).del();
    await u.db("o_storyboard").where({ scriptId: ctx.episodeId }).del();
  }

  const memory = new Memory("seedanceAgent", ctx.isolationKey);
  await memory.add("user", ctx.userMessage);

  // 构建项目配置块（注入 Miwo system prompt）
  const projectConfigBlock = [
    `- 项目名称: ${project.name || "未命名"}`,
    `- 视觉风格: ${project.type || "真人写实"}`,
    `- 目标媒介: ${project.mode || "短剧"}`,
    `- 画面比例: ${project.videoRatio || "16:9"}`,
    `- 导演手册版本: ${project.directorManual || "pro"}`,
  ].join("\n");

  // 加载谜沃主 skill（直接从 data/skills/ 根目录读取）
  const miwoSkillPath = u.getPath(["skills", "miwo-director-skill", "SKILL.md"]);
  const miwoContent = fs.existsSync(miwoSkillPath) ? fs.readFileSync(miwoSkillPath, "utf-8") : "";

  // 加载已有素材库供子 skill 引用
  const existingAssets = await Promise.all([
    loadExistingAssets(episode.projectId, "character"),
    loadExistingAssets(episode.projectId, "scene"),
  ]);
  const assetBlock = existingAssets[0] || existingAssets[1]
    ? `\n\n## 已有素材库（o_assets）\n### 角色资产\n${existingAssets[0]}\n### 场景资产\n${existingAssets[1]}`
    : "";

  // 剧本内容
  const scriptBlock = episode.scriptContent
    ? `\n\n## 剧本内容\n${episode.scriptContent}`
    : "";

  const systemPrompt = `${miwoContent}\n\n## 项目配置\n${projectConfigBlock}${scriptBlock}${assetBlock}`;

  // 获取历史记忆
  const mem = await memory.get(ctx.userMessage);
  const memPrompt = mem
    ? `## 历史记忆\n以下是你与用户的对话记忆，供参考：\n${buildMemPrompt(mem)}`
    : "";

  // 加载此版本下所有可用的子 skill，供 activate_skill 工具注册
  const base = ctx.directorVersion === "ultra" ? "director_ultra" : "director_pro";
  const skillsDir = u.getPath(["skills", base]);
  const skillFiles = await scanSkills(`${skillsDir}/*/SKILL.md`);
  const mainSkills: { path: string; name: string; description: string }[] = [];
  const secondarySkills: string[] = [];
  for (const skillPath of skillFiles) {
    const content = await fs.promises.readFile(skillPath, "utf-8");
    const parsed = parseFrontmatter(content);
    mainSkills.push({ path: skillPath, ...parsed });
    // 扫描子 skill 目录下的模板/参考文件，供 read_skill_file 使用
    const skillDir = path.dirname(skillPath);
    const relativeDir = path.relative(u.getPath("skills"), skillDir);
    for (const subDir of ["templates", "examples", "references"]) {
      const subPath = path.join(skillDir, subDir);
      if (fs.existsSync(subPath)) {
        for (const f of fs.readdirSync(subPath)) {
          if (f.endsWith(".md")) {
            secondarySkills.push(path.join(relativeDir, subDir, f).replace(/\\/g, "/"));
          }
        }
      }
    }
  }

  const skillTools = createSkillTools(mainSkills, { mainSkill: mainSkills, secondarySkills, tertiarySkills: [] });

  // report_stage_output 工具
  const reportStageInput = z.object({
    stage: z.enum(["director_analysis", "art_design", "seedance_prompts"]).describe("阶段标识"),
    content: z.string().describe("当前阶段的完整产出内容"),
  }).toJSONSchema();

  const reportStageOutputTool = tool({
    description: "保存当前阶段的产出内容，供后续阶段参考和最终保存使用。每次保存一个新的阶段产出。",
    inputSchema: jsonSchema<{ stage: string; content: string }>(reportStageInput),
    execute: async ({ stage, content }) => {
      await memory.add(stage, content);

      // 服化道阶段产出：解析 XML 并写入 o_assets（新增角色/场景落库）
      if (stage === "art_design") {
        try {
          await resolveArtDesignAssets(u.db, episode.projectId, content);
        } catch (e) {
          console.error("[miwo] resolveArtDesignAssets error:", e);
        }
      }

      // 发 stageStatus 告诉前端进度
      ctx.socket?.emit("stageStatus", {
        episodeId: ctx.episodeId,
        stage,
        status: "passed",
      });

      // 切换下一阶段状态
      const nextStage = stage === "director_analysis" ? "art_design"
        : stage === "art_design" ? "seedance_prompts"
        : null;
      if (nextStage) {
        ctx.socket?.emit("stageStatus", {
          episodeId: ctx.episodeId,
          stage: nextStage,
          status: "generating",
        });
      }

      return `已保存「${stage}」阶段产出`;
    },
  });

  // report_final 工具
  const reportFinalInput = z.object({}).toJSONSchema();

  const reportFinalTool = tool({
    description: "三个阶段全部完成后调用，保存最终数据到 DB。无参数，工具内部读取之前 report_stage_output 保存的内容。",
    inputSchema: jsonSchema<{}>(reportFinalInput),
    execute: async () => {
      // 从 memories 读取三个阶段的最终产出
      const stages = ["director_analysis", "art_design", "seedance_prompts"] as const;
      const results: Record<string, string | null> = {};
      for (const stage of stages) {
        const mem = await readStageOutput(ctx.isolationKey, ctx.episodeId, stage);
        results[stage] = mem;
      }
      // 保存到 seedance_output 表（先删旧记录再插入）
      for (const stage of stages) {
        if (results[stage]) {
          await u.db("seedance_output").where({ episodeId: ctx.episodeId, stage }).del();
          await u.db("seedance_output").insert({
            episodeId: ctx.episodeId,
            stage,
            content: results[stage],
            stageStatus: "passed",
          });
        }
      }
      // 同步分镜数据
      if (results.seedance_prompts) {
        try {
          const sync = (await import("@/utils/syncStoryboardShots")).default;
          await sync(ctx.episodeId);
        } catch {}
      }
      // 最终全部完成信号
      ctx.socket?.emit("stageStatus", {
        episodeId: ctx.episodeId,
        stage: "seedance_prompts",
        status: "passed",
      });
      ctx.textStream.append("\n\n✅ **全部阶段已完成！**\n");
      return "全部阶段已完成并保存。";
    },
  });

  // 组装消息
  const messages: any[] = [];
  if (memPrompt) {
    messages.push({ role: "assistant", content: memPrompt });
  }
  messages.push({ role: "user", content: ctx.userMessage });

  // 发初始状态：导演分析开始生成
  ctx.socket?.emit("stageStatus", {
    episodeId: ctx.episodeId,
    stage: "director_analysis",
    status: "generating",
  });

  // 单次 AI 调用，走工具驱动
  const { fullStream } = await u.Ai.Text("seedanceAgent:miwoDirector", ctx.directorVersion === "ultra", 0).stream({
    system: systemPrompt,
    messages,
    abortSignal: ctx.abortSignal,
    tools: {
      ...memory.getTools(),
      ...skillTools,
      report_stage_output: reportStageOutputTool,
      report_final: reportFinalTool,
    },
  });

  // 消费 AI 流，所有内容输出到主文本流
  const mainStream = ctx.msg.text("🎬 谜沃工作区");
  await consumeFullStream(fullStream, mainStream);
  mainStream.complete();
  ctx.msg.complete();

  // 最终完成状态
  ctx.socket?.emit("stageStatus", {
    episodeId: ctx.episodeId,
    stage: "seedance_prompts",
    status: "passed",
  });
}

// 辅助函数
function buildMemPrompt(mem: any): string {
  const parts: string[] = [];
  if (mem.rag?.length) {
    parts.push(`[相关记忆]\n${mem.rag.map((r: any) => r.content).join("\n")}`);
  }
  if (mem.summaries?.length) {
    parts.push(`[历史摘要]\n${mem.summaries.map((s: any, i: number) => `${i + 1}. ${s.content}`).join("\n")}`);
  }
  if (mem.shortTerm?.length) {
    parts.push(`[近期对话]\n${mem.shortTerm.map((m: any) => `${m.role}: ${m.content}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

async function readStageOutput(isolationKey: string, episodeId: number, role: string): Promise<string | null> {
  const mem = await u.db("memories")
    .where({ isolationKey, role })
    .orderBy("createTime", "desc").first();
  if (mem?.content) return mem.content;
  const old = await u.db("seedance_output")
    .where({ episodeId, stage: role }).first();
  return old?.content || null;
}

async function loadExistingAssets(projectId: number, type: string): Promise<string> {
  const assets = await u.db("o_assets")
    .where({ projectId, type: type === "character" ? "role" : "scene" })
    .select("name", "prompt", "id");
  if (!assets.length) return "";
  return assets.map((a: any) => `- ${a.name} (id=${a.id}) | 提示词：${a.prompt || "无"}`).join("\n");
}
