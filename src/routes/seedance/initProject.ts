import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

export default express.Router().post("/", async (req, res) => {
  try {
    const { projectId, visualStyle, targetMedium, aspectRatio } = req.body;
    const existing = await u.db("seedance_project").where("projectId", projectId).first();
    if (existing) {
      await u.db("seedance_project").where("projectId", projectId).update({
        visualStyle,
        targetMedium,
        aspectRatio,
      });
    } else {
      await u.db("seedance_project").insert({
        projectId,
        visualStyle,
        targetMedium,
        aspectRatio,
        createdAt: Date.now(),
      });
    }
    res.json(success({ projectId }));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
