import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

export default express.Router().post("/", async (_req, res) => {
  try {
    // 第一轮：处理 videoTrackId 为 NULL 的
    const nullVideos = await u.db("o_video")
      .whereNull("videoTrackId")
      .select("id", "filePath", "scriptId", "projectId", "time");

    // 第二轮：处理 videoTrackId 指向已删除 storyboard 的
    const staleVideos = await u.db("o_video")
      .whereNotNull("videoTrackId")
      .select("id", "filePath", "scriptId", "projectId", "time", "videoTrackId");

    const validSbIds = new Set<number>();
    const allStoryboards = await u.db("o_storyboard").select("id");
    for (const sb of allStoryboards) if (sb.id != null) validSbIds.add(sb.id);

    const orphanVideos = staleVideos.filter((v: any) => !validSbIds.has(v.videoTrackId));
    const allVideos = [...nullVideos, ...orphanVideos];

    let filled = 0;
    let skipped = 0;
    const details: any[] = [];

    const byEpisode = new Map<number, any[]>();
    for (const v of allVideos) {
      if (!v.filePath || !v.scriptId) { skipped++; continue; }
      if (!byEpisode.has(v.scriptId)) byEpisode.set(v.scriptId, []);
      byEpisode.get(v.scriptId)!.push(v);
    }

    for (const [episodeId, epVideos] of byEpisode) {
      const storyboards = await u.db("o_storyboard")
        .where("scriptId", episodeId)
        .orderBy("index")
        .select("id", "index");

      if (storyboards.length === 0) {
        skipped += epVideos.length;
        details.push({ episodeId, reason: "没有storyboard", videoIds: epVideos.map((v: any) => v.id) });
        continue;
      }

      // 第一轮：按文件名 P 编号匹配
      const fuzzyVideos: any[] = [];
      const usedSbIds = new Set<number>();

      for (const v of epVideos) {
        const filename = v.filePath.substring(v.filePath.lastIndexOf("/") + 1);
        const firstPart = filename.split("_")[0];
        const idx = parseInt(firstPart.replace("P", ""), 10);

        if (!isNaN(idx) && idx >= 1 && idx <= 999) {
          const match = storyboards.find((sb: any) => sb.index === idx);
          if (match) {
            if (match.id != null) {
              await u.db("o_video").where("id", v.id).update({ videoTrackId: match.id } as any);
              usedSbIds.add(match.id);
            }
            filled++;
            details.push({ videoId: v.id, filename, matchedBy: "P编号", storyboardId: match.id });
            continue;
          }
        }
        fuzzyVideos.push(v);
      }

      // 第二轮：按时间顺序匹配
      if (fuzzyVideos.length > 0) {
        const availableSbs = storyboards.filter((sb: any) => !usedSbIds.has(sb.id));
        fuzzyVideos.sort((a: any, b: any) => (a.time || 0) - (b.time || 0));

        for (let i = 0; i < Math.min(fuzzyVideos.length, availableSbs.length); i++) {
          await u.db("o_video").where("id", fuzzyVideos[i].id).update({ videoTrackId: availableSbs[i].id } as any);
          filled++;
          details.push({ videoId: fuzzyVideos[i].id, matchedBy: "时间顺序→" + availableSbs[i].index, storyboardId: availableSbs[i].id });
        }

        if (fuzzyVideos.length > availableSbs.length) {
          skipped += fuzzyVideos.length - availableSbs.length;
        }
      }
    }

    res.json(success({ filled, skipped, totalNull: nullVideos.length, totalOrphan: orphanVideos.length, details }));
  } catch (e: any) {
    res.json({ code: 500, message: e.message });
  }
});
