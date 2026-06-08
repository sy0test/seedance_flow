/**
 * 从 seedance_output 解析分镜提示词并同步到 o_storyboard 表
 * 优先使用 XML 标签解析，降级到正则解析（旧数据兼容）
 */
import u from "@/utils";

/** 简单 XML 容器标签解析 */
function parseContainerXml(content: string): Record<string, any[]> {
  const result: Record<string, any[]> = {};
  function parseAttrs(str: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /(\w+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(str)) !== null) attrs[m[1]] = m[2];
    return attrs;
  }
  const containerRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let containerMatch;
  while ((containerMatch = containerRe.exec(content)) !== null) {
    const tagName = containerMatch[1];
    const inner = containerMatch[2];
    const items: any[] = [];
    // 自闭合 <item ... />
    let itemRe = /<item\s+([^>]*?)\s*\/>/g;
    let itemMatch;
    while ((itemMatch = itemRe.exec(inner)) !== null) {
      items.push({ tag: "item", ...parseAttrs(itemMatch[1]) });
    }
    // 自闭合 <reference ... />
    let refRe = /<reference\s+([^>]*?)\s*\/>/g;
    let refMatch;
    while ((refMatch = refRe.exec(inner)) !== null) {
      items.push({ tag: "reference", ...parseAttrs(refMatch[1]) });
    }
    // 带内容 <shot>...</shot>
    let contentRe = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>/g;
    let contentMatch;
    while ((contentMatch = contentRe.exec(inner)) !== null) {
      items.push({ tag: contentMatch[1], ...parseAttrs(contentMatch[2]), value: contentMatch[3].trim() });
    }
    if (items.length > 0) result[tagName] = items;
  }
  return result;
}

export default async function syncStoryboardShots(episodeId: number): Promise<{ shotKey: string; prompt: string }[]> {
  const output = await u.db("seedance_output")
    .where({ episodeId, stage: "seedance_prompts" })
    .first();
  if (!output?.content) return [];

  const content: string = output.content;
  const episode = await u.db("seedance_episode").where("id", episodeId).first();
  if (!episode) return [];

  // ── 第1步：提取素材对应表 @图N → 资产名 ──

  const assetNameByRef: Record<string, string> = {};

  // 1a. 优先解析 XML <references>
  const xmlData = parseContainerXml(content);
  if (xmlData.references) {
    for (const ref of xmlData.references) {
      if (ref.ref && ref.name) {
        assetNameByRef[ref.ref] = ref.name;
      }
    }
  }

  // 1b. 降级：正则解析 markdown 表格（旧数据）
  if (Object.keys(assetNameByRef).length === 0) {
    const tableMatch = content.match(/## 素材对应表[\s\S]*?(?=\n## |\n---|$)/);
    if (tableMatch) {
      const rowRe = /\| @图(\d+) \| [^|]+ \| ([^|]+) \|/g;
      let rowM: RegExpExecArray | null;
      while ((rowM = rowRe.exec(tableMatch[0])) !== null) {
        let rawName = rowM[2].trim();
        rawName = rawName.split(/[，,]/)[0].trim();
        rawName = rawName.replace(/[（(][^）)]*[）)]/, "").trim();
        assetNameByRef[`@图${rowM[1]}`] = rawName;
      }
    }
  }

  // 查 o_assets
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


  // ── 第2步：提取分镜列表 ──

  const shots: Array<{ shotKey: string; prompt: string; title: string }> = [];

  // 2a. 优先解析 XML <shots>
  if (xmlData.shots) {
    for (const shot of xmlData.shots) {
      const chars = shot.characters ? `**出场人物**：${shot.characters}
` : "";
      const scns = shot.scenes ? `**参考场景**：${shot.scenes}
` : "";
      const fullPrompt = (chars || scns) ? `${chars}${scns}
${shot.value || ""}` : (shot.value || "");
      shots.push({
        shotKey: shot.id || "",
        prompt: fullPrompt,
        title: shot.id || "",
      });
    }
  }

  // 2b. 降级：正则解析 markdown（旧数据）
  if (shots.length === 0) {
    const shotRe = /## (P\d+)[^\n]*\n[\s\S]*?\*\*Seedance 2.0 提示词\*\*：\s*\n([\s\S]*?)(?=\n(?:---|\n##)|$)/g;
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
  }

  if (shots.length === 0) return [];

  // ── 第3步：UPSERT o_storyboard ──

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
      // ★ 不覆盖 prompt，保留用户手动编辑的内容
      await u.db("o_storyboard").where("id", existing.id).update({
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
