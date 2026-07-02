import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

export default router.get("/", async (_req, res) => {
    const switchAiDevTool = await u.db("o_setting").where("key", "switchAiDevTool").first();
    res.status(200).send(success(switchAiDevTool?.value || "0"));
});
