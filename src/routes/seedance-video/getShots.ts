import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

export default express.Router().post("/", async (req, res) => {
  const { episodeId, projectId } = req.body;
  if (!episodeId) return res.json({ code: 400, message: "缺少 episodeId" });

  // 从 o_storyboard 查询该 episode 的分镜，按 index 排序
  const storyboards = await u.db("o_storyboard")
    .where("scriptId", episodeId)
    .andWhere("projectId", projectId)
    .orderBy("index")
    .select("id", "prompt", "videoDesc", "index", "track");

  // 查询该 episode 已有的 o_video 记录，通过 videoTrackId 关联到 storyboard
  const videosByStoryboardId: Record<number, { id: number; state: string; src: string; errorReason?: string }[]> = {};
  if (projectId) {
    const rows = await u.db("o_video")
      .where("scriptId", episodeId)
      .where("projectId", projectId)
      .select("id", "filePath", "state", "errorReason", "videoTrackId");

    for (const v of rows) {
      const sbId = v.videoTrackId;
      if (!sbId) continue;
      if (!videosByStoryboardId[sbId]) videosByStoryboardId[sbId] = [];
      const isReady = v.state === "生成成功" || v.state === "已完成";
      const src = isReady && v.filePath ? await u.oss.getFileUrl(v.filePath) : "";
      videosByStoryboardId[sbId].push({ id: v.id!, state: v.state ?? "", src, errorReason: v.errorReason || undefined });
    }
  }

  const shots = await Promise.all(
    storyboards.map(async (sb: any) => {
      const assetLinks = await u.db("o_assets2Storyboard")
        .where("storyboardId", sb.id)
        .orderBy("rowid")
        .select("assetId");

      const assets = await Promise.all(
        assetLinks.map(async (link: any) => {
          const asset = await u.db("o_assets")
            .where("id", link.assetId)
            .andWhere("projectId", projectId)
            .select("id", "name", "imageId")
            .first();

          if (!asset) return null;
          let filePath = "";
          if (asset.imageId) {
            const img = await u.db("o_image").where("id", asset.imageId).first();
            filePath = img?.filePath || "";
          }
          if (filePath) {
            filePath = await u.oss.getSmallImageUrl(filePath);
          }
          return { id: asset.id, name: asset.name, filePath };
        }),
      );

      return {
        storyboardId: sb.id,
        prompt: sb.prompt || "",
        title: sb.videoDesc || "",
        assets: assets.filter(Boolean),
        videos: videosByStoryboardId[sb.id] || [],
        track: sb.track || "main",
        _sortIndex: sb.index,
      };
    }),
  );

  // 按原始 index 排序后，重新分配显示用 shotKey（P01, P02… 顺延）
  shots.sort((a: any, b: any) => a._sortIndex - b._sortIndex);
  const result = shots.map((shot: any, i: number) => {
    const { _sortIndex, ...rest } = shot;
    return { ...rest, shotKey: `P${String(i + 1).padStart(2, "0")}` };
  });

  // 项目总资产列表（按 id 升序，用于前端 @图N 下标匹配）
  const rawAssets = projectId
    ? await u.db("o_assets").where("projectId", projectId).orderBy("id", "asc").select("id", "name", "imageId")
    : [];
  const globalAssets = await Promise.all(
    rawAssets.map(async (a: any) => {
      let filePath = "";
      if (a.imageId) {
        const img = await u.db("o_image").where("id", a.imageId).first();
        filePath = img?.filePath || "";
      }
      return { id: a.id, name: a.name, filePath: filePath ? await u.oss.getSmallImageUrl(filePath) : "" };
    }),
  );

  res.json(success({ shots: result, globalAssets }));
});
