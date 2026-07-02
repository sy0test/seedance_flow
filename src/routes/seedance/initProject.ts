import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

export default express.Router().post("/", async (req, res) => {
  try {
    const { projectId, visualStyle, targetMedium, aspectRatio, directorVersion } = req.body;
    const existing = await u.db("seedance_project").where("projectId", projectId).first();
    const data: any = { visualStyle, targetMedium, aspectRatio, directorVersion: directorVersion || "pro" };
    if (existing) {
      await u.db("seedance_project").where("projectId", projectId).update(data);
    } else {
      data.projectId = projectId;
      data.createdAt = Date.now();
      await u.db("seedance_project").insert(data);
    }
    res.json(success({ projectId }));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
