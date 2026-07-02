import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";

export default express.Router().post(
  "/",
  validateFields({
    storyboardId: z.number(),
    prompt: z.string(),
  }),
  async (req, res) => {
    try {
      const { storyboardId, prompt } = req.body;
      await u.db("o_storyboard").where("id", storyboardId).update({ prompt, createTime: Date.now() } as any);
      res.json(success(null));
    } catch (e: any) {
      res.json(error(e.message));
    }
  },
);
