import express from "express";
import { success } from "@/lib/responseFormat";
const router = express.Router();

export default router.post(
    "/",
    async (_req, res) => {
        res.status(200).send(success("123"));
    },
);
