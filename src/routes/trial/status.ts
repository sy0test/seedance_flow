import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";

const router = express.Router();
const TRIAL_DAYS = 30;

// 获取当前试用状态
export default router.get("/", async (_req, res) => {
  try {
    const setting = await u.db("o_setting").where("key", "trialInstallDate").first();
    if (!setting) {
      return res.status(200).send(success({ daysLeft: TRIAL_DAYS, expired: false, trial: true }));
    }
    const installDate = parseInt(setting.value, 10);
    const elapsedDays = Math.floor((Date.now() - installDate) / (1000 * 60 * 60 * 24));
    const daysLeft = Math.max(0, TRIAL_DAYS - elapsedDays);

    return res.status(200).send(
      success({ installDate, daysLeft, expired: daysLeft <= 0, trial: true }),
    );
  } catch (err) {
    return res.status(500).send(error("获取试用状态失败"));
  }
});
