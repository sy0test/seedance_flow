import express from "express";
import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent", "productionAgent", "seedanceAgent"]),
    episodesId: z.number().optional(),
    messages: z.array(
      z.object({
        role: z.string(),
        content: z.string(),
        name: z.string().optional().nullable(),
      }),
    ),
  }),
  async (req, res) => {
    const { projectId, agentType, episodesId, messages } = req.body;
    const isolationKey = `${projectId}:${agentType}${episodesId ? `:${episodesId}` : ""}`;
    const now = Date.now();

    const rows = messages.map((msg: { role: string; content: string; name?: string | null }) => ({
      id: uuidv4(),
      isolationKey,
      type: "message",
      role: msg.role,
      name: msg.name ?? null,
      content: msg.content,
      embedding: null,
      relatedMessageIds: null,
      summarized: 0,
      createTime: now,
    }));

    // 批量插入，忽略重复
    for (const row of rows) {
      await u.db("memories").insert(row as any).catch(() => {});
    }

    res.status(200).send(success(null));
  },
);
