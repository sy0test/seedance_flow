import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

export default express.Router().get("/", async (req, res) => {
  try {
    const episodeId = req.query.episodeId;
    const episode = await u.db("seedance_episode").where("id", episodeId).first();
    const outputs = await u.db("seedance_output").where("episodeId", episodeId).select("*");
    res.json(success({ episode, outputs }));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
