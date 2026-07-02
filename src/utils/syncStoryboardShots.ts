/**
 * 从 seedance_output 解析分镜提示词并同步到 o_storyboard 表
 *
 * 查询流程（优先使用预解析的 assetIds，降级到 name 匹配）：
 * 1. 从 seedance_output.director_analysis.assetIds 加载 name→assetId 映射
 * 2. 有映射 → 直接使用 ID（精确关联）
 * 3. 无映射（旧数据） → o_assets.whereIn("name") 降级匹配
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

/** 从 <shot characters="林薇@图1,夜（黑豹）"> 属性中解析角色名列表 */
function parseCharactersAttr(val: string): string[] {
  if (!val) return [];
  return val.split(/[,，]/).map((s) => s.replace(/@图\d+/g, "").trim()).filter(Boolean);
}

/** 从 <shot scenes="王国大厅@图3"> 属性中解析场景名列表 */
function parseScenesAttr(val: string): string[] {
  if (!val) return [];
  return val.split(/[,，]/).map((s) => s.replace(/@图\d+/g, "").trim()).filter(Boolean);
}

/** 加载服化道阶段解析的 name→assetId 映射 */
async function loadResolvedAssetIds(episodeId: number, projectId: number): Promise<Record<string, number>> {
  // 从 memories 读
  const isolationKey = `${projectId}:seedanceAgent:${episodeId}`;
  const mem = await u.db("memories")
    .where({ isolationKey, role: "art_design" })
    .orderBy("createTime", "desc").first();
  if (mem?.content) {
    // 尝试从 content 的 XML <references> 中解析 name→assetId
    // 或从旧格式的 assetIds 字段查
    // 暂时用旧路径降级
  }
  // 降级：旧数据从 seedance_output 查
  const out = await u.db("seedance_output")
    .where({ episodeId, stage: "art_design" })
    .select("assetIds")
    .first();
  if (!out?.assetIds) return {};
  try { return JSON.parse(out.assetIds); } catch { return {}; }
}

/** 从 memories 读 stage 内容（降级到 seedance_output） */
async function readStageContent(episodeId: number, role: string, projectId?: number): Promise<string | null> {
  if (projectId) {
    const mem = await u.db("memories")
      .where({ isolationKey: `${projectId}:seedanceAgent:${episodeId}`, role })
      .orderBy("createTime", "desc").first();
    if (mem?.content) return mem.content;
  }
  const old = await u.db("seedance_output").where({ episodeId, stage: role }).first();
  return old?.content || null;
}

export default async function syncStoryboardShots(episodeId: number): Promise<{ shotKey: string; prompt: string }[]> {
  const episode = await u.db("seedance_episode").where("id", episodeId).first();
  if (!episode) return [];

  const content = await readStageContent(episodeId, "seedance_prompts", episode.projectId);
  if (!content) return [];

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

  // ── 第2步：构建 name → assetId 映射 ──
  // 优先用预解析的 assetIds，降级到 name 查询
  const resolvedAssetIds = await loadResolvedAssetIds(episodeId, episode.projectId);
  const assetIdByName: Record<string, number> = { ...resolvedAssetIds };

  // 如果预解析的映射不够，补查 o_assets
  const unresolvedNames = Object.values(assetNameByRef).filter((n) => !assetIdByName[n]);
  if (unresolvedNames.length > 0) {
    const allAssets = await u.db("o_assets")
      .where("projectId", episode.projectId)
      .whereIn("name", unresolvedNames)
      .select("id", "name");
    for (const a of allAssets) {
      if (a.name != null && a.id != null && !assetIdByName[a.name]) {
        assetIdByName[a.name] = a.id;
      }
    }
  }

  // ── 第3步：提取分镜列表 ──

  const shots: Array<{ shotKey: string; prompt: string; title: string; characters?: string; scenes?: string }> = [];

  // 3a. 优先解析 XML <shots>
  if (xmlData.shots) {
    for (const shot of xmlData.shots) {
      // prompt 直接取 shot value，绑定由 o_assets2Storyboard 管理
      const fullPrompt = shot.value || "";
      shots.push({
        shotKey: shot.id || "",
        prompt: fullPrompt,
        title: shot.id || "",
        characters: shot.characters,
        scenes: shot.scenes,
      });
    }
  }

  // 3b. 降级：正则解析 markdown（旧数据）
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

  // ── 第4步：UPSERT o_storyboard ──

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

    // ── 重新关联资产（用 ID） ──
    await u.db("o_assets2Storyboard").where("storyboardId", storyboardId).del();

    const linkedAssetIds = new Set<number>();

    // 方式1：从 characters/scenes 属性解析角色/场景名 → 查 assetId
    if (shot.characters) {
      for (const charName of parseCharactersAttr(shot.characters)) {
        const assetId = assetIdByName[charName];
        if (assetId && !linkedAssetIds.has(assetId)) {
          linkedAssetIds.add(assetId);
          await u.db("o_assets2Storyboard").insert({ storyboardId, assetId } as any);
        }
      }
    }
    if (shot.scenes) {
      for (const sceneName of parseScenesAttr(shot.scenes)) {
        const assetId = assetIdByName[sceneName];
        if (assetId && !linkedAssetIds.has(assetId)) {
          linkedAssetIds.add(assetId);
          await u.db("o_assets2Storyboard").insert({ storyboardId, assetId } as any);
        }
      }
    }

    // 方式2（降级/补充）：从 prompt 文本中 @图N → name → assetId
    for (const [ref, name] of Object.entries(assetNameByRef)) {
      if (shot.prompt.includes(ref)) {
        const assetId = assetIdByName[name];
        if (assetId && !linkedAssetIds.has(assetId)) {
          linkedAssetIds.add(assetId);
          await u.db("o_assets2Storyboard").insert({ storyboardId, assetId } as any);
        }
      }
    }

    resultShots.push({ shotKey: shot.shotKey, prompt: shot.prompt });
  }

  return resultShots;
}
