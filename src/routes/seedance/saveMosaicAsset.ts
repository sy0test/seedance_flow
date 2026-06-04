import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";

export default express.Router().post("/", async (req, res) => {
  try {
    const { projectId, assetId, imageData, model, resolution } = req.body;
    if (!projectId || !assetId || !imageData) return res.json(error("缺少必要参数"));

    // 1. 读取角色资产信息
    const asset = await u.db("o_assets").where("id", assetId).first();
    if (!asset) return res.json(error("资产不存在"));

    // 2. 生成保存路径
    const now = Date.now();
    const outputPath = `/${projectId}/mosaic/${now}.png`;

    // 3. 保存图片到 OSS
    await u.oss.writeFile(outputPath, imageData);

    // 4. 创建衍生资产
    const [newId] = await u.db("o_assets").insert({
      projectId,
      name: `${asset.name}_手动反检测`,
      prompt: asset.prompt || "",
      describe: `${asset.name} 手动反检测参考图`,
      type: "role",
      assetsId: asset.id,
      promptState: "已完成",
      startTime: now,
    } as any);

    // 5. 创建图片记录
    const [imageId] = await u.db("o_image").insert({
      filePath: outputPath,
      type: "role",
      assetsId: newId,
      model: model || "",
      resolution: resolution || "1K",
      state: "已完成",
    } as any);

    // 6. 更新衍生资产的 imageId
    await u.db("o_assets").where("id", newId).update({ imageId } as any);

    res.json(success({ id: newId, name: `${asset.name}_手动反检测`, filePath: outputPath }));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
