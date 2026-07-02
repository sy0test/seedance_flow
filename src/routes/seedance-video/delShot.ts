import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";

export default express.Router().post("/", async (req, res) => {
  try {
    const { storyboardId } = req.body;
    if (!storyboardId) return res.json(error("缺少 storyboardId"));

    // 查分镜
    const sb = await u.db("o_storyboard").where("id", storyboardId).first();
    if (!sb) return res.json(error("分镜不存在"));

    // 删除关联资产
    await u.db("o_assets2Storyboard").where("storyboardId", storyboardId).del();

    // 删除关联视频记录
    const videos = await u.db("o_video").where("videoTrackId", storyboardId).select("id", "filePath");
    for (const v of videos) {
      if (v.filePath) {
        try { await u.oss.deleteFile(v.filePath); } catch {}
      }
    }
    await u.db("o_video").where("videoTrackId", storyboardId).del();

    // 删除分镜
    await u.db("o_storyboard").where("id", storyboardId).del();

    res.json(success(true));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
