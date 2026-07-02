import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

export default express.Router().post("/", async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) return res.json(error("缺少 projectId"));

    // 从 o_script 读取已有剧本
    const scripts = await u.db("o_script")
      .where("projectId", projectId)
      .select("id", "name", "content");

    if (scripts.length === 0) {
      return res.json(error("该项目暂无剧本，请先到剧本管理页面导入"));
    }

    // 获取已同步的 episodeKey，避免重复
    const existing = await u.db("seedance_episode")
      .where("projectId", projectId)
      .select("episodeKey");
    const existingKeys = new Set(existing.map((e: any) => e.episodeKey));

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

    const episodes = await u.db("seedance_episode")
      .where("projectId", projectId)
      .orderBy("id", "asc")
      .select("*");

    res.json(success(episodes));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
