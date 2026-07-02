import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 编辑剧本
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    content: z.string(),
    assets: z.array(z.number()),
  }),
  async (req, res) => {
    const { id, name, content, assets } = req.body;
    await u.db("o_script").where({ id }).update({
      name,
      content,
    });
    if (assets.length) {
      const assetsData = await u.db("o_assets").whereIn("id", assets).select();
      await u.db("o_scriptAssets").where({ scriptId: id }).delete();
      if (assetsData.length) {
        const insertData = assetsData.map((item) => {
          return {
            scriptId: id,
            assetId: item.id,
          };
        });
        await u.db("o_scriptAssets").insert(insertData);
      }
    }

    // Seedance 模式下，同步更新 seedance_episode 表
    const script = await u.db("o_script").where("id", id).select("projectId").first();
    if (script) {
      const project = await u.db("o_project").where("id", script.projectId).select("projectType").first();
      if (project?.projectType === "seedance") {
        const key = name || `ep${String(id).padStart(2, "0")}`;
        const existing = await u.db("seedance_episode").where("scriptId", id).first();
        if (existing) {
          await u.db("seedance_episode").where("scriptId", id).update({
            episodeKey: key,
            scriptContent: content,
          });
        } else {
          await u.db("seedance_episode").insert({
            projectId: script.projectId,
            episodeKey: key,
            scriptContent: content,
            scriptId: id,
            status: "pending",
            createdAt: Date.now(),
          });
        }
      }
    }

    res.status(200).send(success({ message: "编辑剧本成功" }));
  },
);
