import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

export default express.Router().post("/", async (req, res) => {
  const { videoIds } = req.body;
  if (!videoIds?.length) return res.json(success([]));

  const videos = await u.db("o_video")
    .whereIn("id", videoIds)
    .select("id", "state", "filePath", "errorReason");

  const result = await Promise.all(
    videos.map(async (v: any) => {
      const isSuccess = v.state === "生成成功" || v.state === "已完成";
      console.log(`[checkState] video ${v.id}: state=${v.state}, isSuccess=${isSuccess}, filePath=${v.filePath}`);
      return {
        id: v.id,
        state: v.state,
        src: isSuccess && v.filePath ? await u.oss.getFileUrl(v.filePath) : "",
        errorReason: v.errorReason,
      };
    }),
  );

  res.json(success(result));
});
