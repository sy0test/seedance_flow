import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

export default express.Router().get("/", async (req, res) => {
  try {
    const { episodeId, stage } = req.query;
    const output = await u.db("seedance_output").where({ episodeId, stage }).first();
    res.json(success(output || null));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
