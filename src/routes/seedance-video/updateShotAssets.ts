import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";

export default express.Router().post(
  "/",
  validateFields({
    storyboardId: z.number(),
    assetIds: z.array(z.number()),
  }),
  async (req, res) => {
    try {
      const { storyboardId, assetIds } = req.body;

      // 清除旧绑定
      await u.db("o_assets2Storyboard").where("storyboardId", storyboardId).del();

      // 插入新绑定
      for (const assetId of assetIds) {
        await u.db("o_assets2Storyboard").insert({ storyboardId, assetId } as any);
      }

      res.json(success(null));
    } catch (e: any) {
      res.json(error(e.message));
    }
  },
);
