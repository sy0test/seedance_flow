import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";

export default express.Router().post("/", async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) return res.json(error("缺少 projectId"));

    // 查找该项目所有关联了 storyboard 的角色资产
    const linkedAssets = await u.db("o_assets2Storyboard as a2s")
      .join("o_storyboard as sb", "a2s.storyboardId", "sb.id")
      .join("o_assets as a", "a2s.assetId", "a.id")
      .where("sb.projectId", projectId)
      .where("a.type", "role")
      .distinct("a.id", "a.name")
      .select("a.id", "a.name");

    let replacedCount = 0;

    for (const asset of linkedAssets) {
      // 查找该角色最新的手动反检测衍生资产
      const derived = await u.db("o_assets")
        .where("assetsId", asset.id)
        .where("name", `${asset.name}_手动反检测`)
        .orderBy("id", "desc")
        .first();

      if (!derived?.imageId) continue;

      // 将原始资产的 imageId 更新为反检测图的 imageId
      await u.db("o_assets").where("id", asset.id).update({ imageId: derived.imageId } as any);
      replacedCount++;
    }

    res.json(success({ replacedCount }));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
