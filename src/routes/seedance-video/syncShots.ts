import express from "express";
import { success, error } from "@/lib/responseFormat";
import syncStoryboardShots from "@/utils/syncStoryboardShots";

export default express.Router().post("/", async (req, res) => {
  try {
    const { episodeId } = req.body;
    if (!episodeId) return res.json(error("缺少 episodeId"));

    const resultShots = await syncStoryboardShots(episodeId);
    if (!resultShots.length) return res.json(error("尚未生成分镜提示词"));

    res.json(success(resultShots));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
