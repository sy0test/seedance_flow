import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

function normalizeRole(role?: string | null): "user" | "assistant" {
  if (!role) return "user";
  // 原版：以 "assistant" 开头 → assistant
  if (role.startsWith("assistant")) return "assistant";
  // Seedance 版：stage key（director_analysis/art_design/seedance_prompts）→ assistant
  if (["director_analysis", "art_design", "seedance_prompts"].includes(role)) return "assistant";
  return "user";
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent", "productionAgent", "seedanceAgent"]),
    episodesId: z.number().optional(),
  }),
  async (req, res) => {
    const { projectId, agentType, episodesId } = req.body;
    const isolationKey = `${projectId}:${agentType}${episodesId ? `:${episodesId}` : ""}`;

    const rows = await u
      .db("memories")
      .where({ isolationKey, type: "message" })
      .orderBy("createTime", "desc")
      .limit(50)
      .select("id", "role", "name", "content", "createTime");

    rows.reverse(); // 保持时间升序

    const history = rows.map((row) => ({
      id: row.id,
      role: normalizeRole(row.role),
      name: row.name ?? undefined,
      status: "complete",
      datetime: new Date(row.createTime).toISOString(),
      content: [{ type: "markdown", status: "complete", data: row.content }],
      createTime: row.createTime,
    }));

    res.status(200).send(success(history));
  },
);
