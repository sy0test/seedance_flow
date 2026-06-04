import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

export default express.Router().post("/", async (req, res) => {
  try {
    const { episodeId, stage, feedback } = req.body;
    const now = Date.now();

    await u.db("seedance_output")
      .where({ episodeId, stage })
      .update({
        reviewFeedback: feedback,
        stageStatus: "failed",
        updatedAt: now,
      });

    res.json(success({ episodeId, stage }));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
