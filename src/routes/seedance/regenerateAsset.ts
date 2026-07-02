import express from "express";
import { success, error } from "@/lib/responseFormat";

export default express.Router().post("/", async (req, res) => {
  try {
    const { episodeId, assetType, assetIndex } = req.body;

    res.json(success({ episodeId, assetType, assetIndex, status: "regenerating" }));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
