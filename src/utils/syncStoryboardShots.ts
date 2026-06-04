/**
 * 从 seedance_output 解析分镜提示词并同步到 o_storyboard 表
 * 提取自 /seedance-video/syncShots 路由，供路由和 Agent 管线共用
 */
import u from "@/utils";

export default async function syncStoryboardShots(episodeId: number): Promise<{ shotKey: string; prompt: string }[]> {
  // 1. 读取 seedance_prompts 产出
  const output = await u.db("seedance_output")
    .where({ episodeId, stage: "seedance_prompts" })
    .first();
  if (!output?.content) return [];

  const content: string = output.content;
  const episode = await u.db("seedance_episode").where("id", episodeId).first();
  if (!episode) return [];

  // 2. 解析素材对应表
  const tableMatch = content.match(/## 素材对应表[\s\S]*?(?=\n## |\n---|$)/);
  const assetNameByRef: Record<string, string> = {};
  if (tableMatch) {
    const rowRe = /\| @图片(\d+) \| [^|]+ \| ([^|]+) \|/g;
    let rowM: RegExpExecArray | null;
    while ((rowM = rowRe.exec(tableMatch[0])) !== null) {
      let rawName = rowM[2].trim();
      rawName = rawName.split(/[，,]/)[0].trim();
      rawName = rawName.replace(/[（(][^）)]*[）)]/, "").trim();
      assetNameByRef[`@图片${rowM[1]}`] = rawName;
    }
  }

  const assetNames = Object.values(assetNameByRef);
  const allAssets = assetNames.length
    ? await u.db("o_assets")
        .where("projectId", episode.projectId)
        .whereIn("name", assetNames)
        .select("id", "name")
    : [];
  const assetIdByName: Record<string, number> = {};
  for (const a of allAssets) {
    if (a.name != null && a.id != null) assetIdByName[a.name] = a.id;
  }

  // 3. 解析分镜列表
  const shotRe = /## (P\d+)[^\n]*\n[\s\S]*?\*\*Seedance 2.0 提示词\*\*：\s*\n([\s\S]*?)(?=\n(?:---|\n##)|$)/g;
  const shots: Array<{ shotKey: string; prompt: string; title: string }> = [];
  let shotM: RegExpExecArray | null;
  while ((shotM = shotRe.exec(content)) !== null) {
    const headerLine = content.slice(content.lastIndexOf("##", shotM.index));
    const titleMatch = headerLine.match(/## P\d+\s+(.+)/);
    shots.push({
      shotKey: shotM[1].trim(),
      prompt: shotM[2].trim(),
      title: titleMatch ? titleMatch[1].trim() : shotM[1].trim(),
    });
  }

  if (shots.length === 0) return [];

  // 4. UPSERT
  const existingMain = await u.db("o_storyboard")
    .where({ projectId: episode.projectId, scriptId: episodeId, track: "main" })
    .select("id", "index");

  const existingByIndex = new Map(existingMain.map((s: any) => [s.index, s]));
  const newIndices = new Set(shots.map((_, i) => i + 1));
  const now = Date.now();
  const resultShots: Array<{ shotKey: string; prompt: string }> = [];

  // 删除已不在 AI 输出中的 track="main" 分镜
  for (const [idx, sb] of existingByIndex) {
    if (!newIndices.has(idx)) {
      await u.db("o_assets2Storyboard").where("storyboardId", sb.id).del();
      await u.db("o_storyboard").where("id", sb.id).del();
    }
  }

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const idx = i + 1;
    const existing = existingByIndex.get(idx);

    let storyboardId: number;

    if (existing) {
      storyboardId = existing.id;
      await u.db("o_storyboard").where("id", existing.id).update({
        prompt: shot.prompt,
        videoDesc: shot.title,
        duration: "8",
        state: "未生成",
        createTime: now,
      } as any);
    } else {
      const [sid] = await u.db("o_storyboard").insert({
        projectId: episode.projectId,
        scriptId: episodeId,
        prompt: shot.prompt,
        videoDesc: shot.title,
        duration: "8",
        state: "未生成",
        track: "main",
        index: idx,
        createTime: now,
      } as any);
      storyboardId = sid;
    }

    // 重新关联资产
    await u.db("o_assets2Storyboard").where("storyboardId", storyboardId).del();
    for (const [ref, name] of Object.entries(assetNameByRef)) {
      if (shot.prompt.includes(ref)) {
        const assetId = assetIdByName[name];
        if (assetId) {
          await u.db("o_assets2Storyboard").insert({ storyboardId, assetId } as any);
        }
      }
    }

    resultShots.push({ shotKey: shot.shotKey, prompt: shot.prompt });
  }

  return resultShots;
}
