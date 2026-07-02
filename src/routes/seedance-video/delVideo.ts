import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";

export default express.Router().post("/", async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) return res.json(error("缺少 videoId"));

    // 查视频记录
    const video = await u.db("o_video").where("id", videoId).first();
    if (!video) return res.json(error("视频不存在"));

    // 删除 OSS 文件
    if (video.filePath) {
      try { await u.oss.deleteFile(video.filePath); } catch {}
    }

    // 删除数据库记录
    await u.db("o_video").where("id", videoId).del();

    res.json(success(true));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
