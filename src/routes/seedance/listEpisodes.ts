import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

export default express.Router().get("/", async (req, res) => {
  try {
    const projectId = req.query.projectId;
    const episodes = await u.db("seedance_episode")
      .where("projectId", projectId)
      .orderBy("id", "asc")
      .select("*");
    res.json(success(episodes));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
