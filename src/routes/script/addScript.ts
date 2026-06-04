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
    name: z.string(),
    content: z.string(),
    projectId: z.number(),
    assets: z.array(z.number()),
  }),
  async (req, res) => {
    const { name, content, projectId, assets } = req.body;
    const [scriptId] = await u.db("o_script").insert({
      name,
      content,
      projectId,
      createTime: Date.now(),
    });
    if (assets.length) {
      const assetsData = await u.db("o_assets").whereIn("id", assets).select();
      if (assetsData.length) {
        const assetsIds = assetsData.map((item) => item.id);
        const insertData = assetsIds.map((i) => {
          return {
            scriptId,
            assetId: i,
          };
        });
        await u.db("o_scriptAssets").insert(insertData);
      }
    }

    // Seedance 模式下，同步写入 seedance_episode 表
    const project = await u.db("o_project").where("id", projectId).select("projectType").first();
    if (project?.projectType === "seedance") {
      const existing = await u.db("seedance_episode").where("projectId", projectId).select("episodeKey");
      const existingKeys = new Set(existing.map((e: any) => e.episodeKey));
      const key = name || `ep${String(existing.length + 1).padStart(2, "0")}`;
      if (!existingKeys.has(key)) {
        await u.db("seedance_episode").insert({
          projectId,
          episodeKey: key,
          scriptContent: content,
          scriptId,
          status: "pending",
          createdAt: Date.now(),
        });
      }
    }

    res.status(200).send(success({ message: "添加剧本成功" }));
  },
);
