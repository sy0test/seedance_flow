import jwt from "jsonwebtoken";
import u from "@/utils";
import type { Namespace, Socket } from "socket.io";
import ResTool from "@/socket/resTool";
import { runStageWithStream } from "@/agents/seedanceAgent/chatPipeline";

async function verifyToken(rawToken: string): Promise<boolean> {
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting) return false;
  const token = rawToken.replace("Bearer ", "");
  try {
    jwt.verify(token, setting.value as string);
    return true;
  } catch {
    return false;
  }
}

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    if (!token || !(await verifyToken(token))) {
      console.log("[seedanceAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }

    const episodeId = Number(socket.handshake.auth.episodeId);
    if (!episodeId) {
      console.log("[seedanceAgent] 连接失败，缺少 episodeId");
      socket.disconnect();
      return;
    }

    const isolationKey = socket.handshake.auth.isolationKey as string || `${episodeId}:seedanceAgent`;

    console.log("[seedanceAgent] 已连接:", socket.id, "episodeId:", episodeId);

    const resTool = new ResTool(socket, { episodeId });
    let abortController: AbortController | null = null;

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "Seedance");
      const textStream = msg.text();

      try {
        await runStageWithStream({
          episodeId,
          userMessage: content,
          textStream,
          resTool,
          msg,
          abortSignal: currentController.signal,
          isolationKey,
          socket,
        });
      } catch (err: any) {
        if (err.name !== "AbortError" && !currentController.signal.aborted) {
          textStream.append(`\n\n错误: ${u.error(err).message}`);
          msg.error(u.error(err).message);
        }
      } finally {
        textStream.complete();
        msg.complete();
        if (abortController === currentController) {
          abortController = null;
        }
      }
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });

    socket.on("disconnect", () => {
      abortController?.abort();
      abortController = null;
      console.log("[seedanceAgent] 已断开:", socket.id);
    });
  });
};
