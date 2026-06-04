import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

export default express.Router().get("/", async (req, res) => {
  try {
    const projectId = req.query.projectId;
    const config = await u.db("seedance_project").where("projectId", projectId).first();
    res.json(success(config || null));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
