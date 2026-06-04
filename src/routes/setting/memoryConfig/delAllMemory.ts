import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
const router = express.Router();

export default router.post("/", async (_req, res) => {
  await u.db("memories").del();
  res.status(200).send(success(true));
});
