import express from "express";
import { success } from "@/lib/responseFormat";
import fg from "fast-glob";
import u from "@/utils";

const router = express.Router();

export default router.post("/", async (_req, res) => {
  const skillsRoot = u.getPath(["skills"]);

  const entries = await fg("**/*.md", {
    cwd: skillsRoot.replace(/\\/g, "/"),
    onlyFiles: true,
  });

  res.status(200).send(success(entries));
});
