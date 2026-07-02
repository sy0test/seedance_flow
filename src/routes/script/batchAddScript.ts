import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 新增剧本
export default router.post(
  "/",
  validateFields({
    data: z.array(
      z.object({
        scriptName: z.string(),
        scriptData: z.string(),
      }),
    ),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { data, projectId } = req.body;
    await u.db("o_script").insert(
      data.map((i: { scriptName: string; scriptData: string }) => {
        return {
          name: i.scriptName,
          content: i.scriptData,
          projectId,
          createTime: Date.now(),
        };
      }),
    );

    // Seedance 模式下，同步写入 seedance_episode 表
    const project = await u.db("o_project").where("id", projectId).select("projectType").first();
    if (project?.projectType === "seedance") {
      const existing = await u.db("seedance_episode").where("projectId", projectId).select("episodeKey");
      const existingKeys = new Set(existing.map((e: any) => e.episodeKey));
      const scripts = await u.db("o_script").where("projectId", projectId).select("id", "name", "content");
      const now = Date.now();
      for (const script of scripts) {
        const key = script.name || `ep${String(scripts.indexOf(script) + 1).padStart(2, "0")}`;
        if (existingKeys.has(key)) continue;
        await u.db("seedance_episode").insert({
          projectId,
          episodeKey: key,
          scriptContent: script.content,
          scriptId: script.id,
          status: "pending",
          createdAt: now,
        });
      }
    }

    res.status(200).send(success({ message: "添加剧本成功" }));
  },
);
