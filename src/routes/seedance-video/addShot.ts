import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";

export default express.Router().post("/", async (req, res) => {
  try {
    const { episodeId, projectId, afterStoryboardId, prompt } = req.body;
    if (!episodeId || !projectId || !afterStoryboardId || !prompt) {
      return res.json(error("缺少必要参数"));
    }

    // 找到目标分镜的存储 index
    const target = await u.db("o_storyboard")
      .where("id", afterStoryboardId)
      .where("scriptId", episodeId)
      .first();

    if (!target) return res.json(error("目标分镜不存在"));

    const targetIndex = target.index ?? 0;

    // 找到目标之后的下一个分镜
    const nextShot = await u.db("o_storyboard")
      .where("scriptId", episodeId)
      .where("index", ">", targetIndex)
      .orderBy("index")
      .first();

    // 在两个 index 之间取中间值，不重编号已有分镜
    const newIndex = nextShot?.index != null
      ? (targetIndex + nextShot.index) / 2
      : targetIndex + 1;

    const now = Date.now();

    const [sid] = await u.db("o_storyboard").insert({
      projectId,
      scriptId: episodeId,
      prompt,
      videoDesc: "",
      duration: "8",
      state: "未生成",
      track: "manual",
      index: newIndex,
      createTime: now,
    } as any);

    res.json(success({ storyboardId: sid }));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
