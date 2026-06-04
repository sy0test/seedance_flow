import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

export default express.Router().post("/", async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) return res.json(error("缺少 projectId"));

    // 删除旧正则误捕获的章节标题条目
    const invalidNames = ["人物提示词", "场景道具提示词", "场景提示词", "角色提示词"];
    const deletedInvalid = await u.db("o_assets")
      .where("projectId", projectId)
      .whereIn("name", invalidNames)
      .delete();

    // 删除无 prompt 的 role 条目（旧数据残留）
    const deletedEmpty = await u.db("o_assets")
      .where("projectId", projectId)
      .where("type", "role")
      .whereNull("prompt")
      .delete();

    res.json(success({ deletedInvalid, deletedEmpty }));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
