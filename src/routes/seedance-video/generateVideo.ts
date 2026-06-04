import express from "express";
import u from "@/utils";
import { v4 as uuidv4 } from "uuid";
import { success, error } from "@/lib/responseFormat";
import { ReferenceList } from "@/utils/ai";

interface UploadItem {
  sources?: "assets" | "storyboard";
  id?: number;
}

export default express.Router().post("/", async (req, res) => {
  try {
    const { projectId, episodeId, shotKey, prompt, uploadData, model, mode, resolution, duration, audio, storyboardId } = req.body;
    if (!projectId || !episodeId || !prompt || !model) {
      return res.json(error("缺少必要参数"));
    }

    const finalDuration = duration || 8;
    let finalMode: any = mode || "text";
    if (typeof mode === "string" && mode.startsWith("[") && mode.endsWith("]")) {
      try { finalMode = JSON.parse(mode); } catch {}
    }

    // 获取视频比例：优先从 seedance_project 读取
    let aspectRatio = "16:9";
    const seedanceConfig = await u.db("seedance_project").where("projectId", projectId).first();
    if (seedanceConfig?.aspectRatio) {
      aspectRatio = seedanceConfig.aspectRatio;
    } else {
      const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
      aspectRatio = (ratio?.videoRatio as string) || "16:9";
    }
    const videoPath = `/${projectId}/video/${shotKey}_${uuidv4()}.mp4`;

    // 根据 mode 过滤参考图
    let filteredUploadData = uploadData || [];
    const modeStr = typeof mode === "string" ? mode : "";
    if (modeStr === "singleImage") {
      filteredUploadData = filteredUploadData.slice(0, 1);
    } else if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(modeStr)) {
      filteredUploadData = filteredUploadData.slice(0, 2);
    } else if (modeStr === "text") {
      filteredUploadData = [];
    }
    // JSON array (multi-reference) sends all images — no filtering needed

    // 解析参考图
    const images = await Promise.all(
      (filteredUploadData || []).map(async (item: UploadItem) => {
        if (item.sources === "assets") {
          const filePath = await u
            .db("o_assets")
            .where("o_assets.id", item.id)
            .leftJoin("o_image", "o_assets.imageId", "o_image.id")
            .select("o_image.filePath", "o_image.type")
            .first();
          return { path: filePath?.filePath, sources: filePath?.type };
        }
        return null;
      }),
    );

    const base64 = (await Promise.all(
      images.filter(Boolean).map(async (item: any) => ({
        base64: await u.oss.getImageBase64(item.path),
        type: item.sources === "audio" ? "audio" : "image",
      })),
    )) as ReferenceList[];

    // 保存到 o_video（关联 storyboardId 用于视频匹配）
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath,
      time: Date.now(),
      state: "生成中",
      scriptId: episodeId,
      projectId,
      videoTrackId: storyboardId || null,
    } as any);

    res.json(success(videoId));

    console.log("[Seedance generateVideo] mode:", mode, "finalMode:", JSON.stringify(finalMode));
    console.log("[Seedance generateVideo] uploadData:", JSON.stringify(uploadData));
    console.log("[Seedance generateVideo] images found:", images.length);
    console.log("[Seedance generateVideo] base64 refs:", base64.length);

    // 异步执行视频生成
    const aiVideo = u.Ai.Video(model);
    aiVideo
      .run(
        {
          prompt,
          referenceList: base64,
          mode: finalMode,
          duration: finalDuration,
          aspectRatio: aspectRatio as "16:9" | "9:16",
          resolution: resolution || "480p",
          audio: !!audio,
        },
        {
          projectId,
          taskClass: "视频生成",
          describe: "Seedance 视频生成",
          relatedObjects: JSON.stringify({ projectId, videoId, episodeId, type: "视频" }),
        },
      )
      .then(async () => await aiVideo.save(videoPath))
      .then(async () => await u.db("o_video").where("id", videoId).update({ state: "生成成功" } as any))
      .catch(async (err: any) => {
        await u.db("o_video").where("id", videoId).update({
          state: "生成失败",
          errorReason: u.error(err).message,
        } as any);
      });
  } catch (e: any) {
    res.json(error(e.message));
  }
});
