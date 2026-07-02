/**
 * Name → assetId 解析工具
 *
 * 设计原则：
 * - Stage1（导演分析）只解析名称，不碰 o_assets
 * - Stage2（服化道设计）唯一负责 o_assets 的写入
 * - Stage3（分镜提示词）从 Stage2 的 assetIds 读 ID 映射
 */

import type { Knex } from "knex";

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
    // 带内容 <character>...</character>, <scene>...</scene>
    let contentRe = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>/g;
    let contentMatch;
    while ((contentMatch = contentRe.exec(inner)) !== null) {
      items.push({
        tag: contentMatch[1],
        ...parseAttrs(contentMatch[2]),
        value: contentMatch[3].trim(),
      });
    }
    if (items.length > 0) result[tagName] = items;
  }
  return result;
}

/** 导演分析产出：纯解析结果（不含 DB 操作） */
export interface DirectorAnalysisNames {
  characters: Array<{ name: string; type: string; description: string }>;
  scenes: Array<{ name: string; type: string; description: string }>;
}

/** 解析导演分析阶段 XML，只返回名称清单，不写 o_assets */
export function parseDirectorAnalysisOutput(content: string): DirectorAnalysisNames {
  const xmlData = parseContainerXml(content);
  const characters: Array<{ name: string; type: string; description: string }> = [];
  const scenes: Array<{ name: string; type: string; description: string }> = [];

  if (xmlData.characters) {
    for (const item of xmlData.characters) {
      characters.push({
        name: item.name || "",
        type: item.type || "新增",
        description: item.description || "",
      });
    }
  }

  if (xmlData.scenes) {
    for (const item of xmlData.scenes) {
      const atmosphere = item.atmosphere || "";
      const lighting = item.lighting || "";
      const time = item.time || "";
      const descParts = [time, lighting, atmosphere].filter(Boolean);
      scenes.push({
        name: item.name || "",
        type: item.type || "新增",
        description: descParts.join(" / ") || "",
      });
    }
  }

  return { characters, scenes };
}

/**
 * 服化道设计阶段：解析 XML 并写入 o_assets
 *
 * - AI 输出提示词的条目 → INSERT（新）或 UPDATE（已有）
 * - AI 没有输出提示词（复用且无需重新生成）→ 跳过，保留已有内容
 * - 返回所有条目及其 assetId
 */
export async function resolveArtDesignAssets(
  db: Knex,
  projectId: number,
  content: string,
): Promise<{
  characterPrompts: Array<{ name: string; assetId: number; prompt: string }>;
  scenePrompts: Array<{ name: string; assetId: number; prompt: string }>;
}> {
  const xmlData = parseContainerXml(content);
  const now = Date.now();
  const characterPrompts: Array<{ name: string; assetId: number; prompt: string }> = [];
  const scenePrompts: Array<{ name: string; assetId: number; prompt: string }> = [];

  // ── 角色 ──
  if (xmlData.characterPrompts) {
    const names = xmlData.characterPrompts
      .map((c: any) => c.name || "")
      .filter(Boolean);
    const existing = names.length > 0
      ? await db("o_assets")
          .where("projectId", projectId)
          .whereIn("name", names)
          .where("type", "role")
          .select("id", "name")
      : [];
    const nameToId = new Map(existing.map((a: any) => [a.name, a.id]));

    for (const item of xmlData.characterPrompts) {
      let name = item.name || "";
      const prompt = item.value || "";
      const itemType = item.type || "新增";
      let assetId = nameToId.get(name);

      if (assetId) {
        if (itemType === "变体") {
          // 变体：同名已存在 → 创建新条目，不覆盖原资产
          let variantName = name + "（变体）";
          let suffix = 2;
          while (nameToId.has(variantName)) {
            variantName = name + `（变体${suffix}）`;
            suffix++;
          }
          const [newId] = await db("o_assets").insert({
            projectId,
            name: variantName,
            type: "role",
            describe: variantName,
            prompt,
            promptState: "已完成",
            startTime: now,
          } as any);
          assetId = newId;
          nameToId.set(variantName, assetId);
        } else if (prompt) {
          await db("o_assets").where("id", assetId).update({
            prompt,
            promptState: "已完成",
            describe: name,
          });
        }
      } else if (prompt) {
        const [newId] = await db("o_assets").insert({
          projectId,
          name,
          type: "role",
          describe: name,
          prompt,
          promptState: "已完成",
          startTime: now,
        } as any);
        assetId = newId;
        nameToId.set(name, assetId);
      }

      if (assetId) {
        characterPrompts.push({ name, assetId, prompt });
      }
    }
  }

  // ── 场景 ──
  if (xmlData.scenePrompts) {
    const names = xmlData.scenePrompts
      .map((s: any) => s.name || "")
      .filter(Boolean);
    const existing = names.length > 0
      ? await db("o_assets")
          .where("projectId", projectId)
          .whereIn("name", names)
          .where("type", "scene")
          .select("id", "name")
      : [];
    const nameToId = new Map(existing.map((a: any) => [a.name, a.id]));

    for (const item of xmlData.scenePrompts) {
      let name = item.name || "";
      const prompt = item.value || "";
      const itemType = item.type || "新增";
      let assetId = nameToId.get(name);

      if (assetId) {
        if (itemType === "变体") {
          // 变体：同名已存在 → 创建新条目，不覆盖原资产
          let variantName = name + "（变体）";
          let suffix = 2;
          while (nameToId.has(variantName)) {
            variantName = name + `（变体${suffix}）`;
            suffix++;
          }
          const [newId] = await db("o_assets").insert({
            projectId,
            name: variantName,
            type: "scene",
            describe: variantName,
            prompt,
            promptState: "已完成",
            startTime: now,
          } as any);
          assetId = newId;
          nameToId.set(variantName, assetId);
        } else if (prompt) {
          await db("o_assets").where("id", assetId).update({
            prompt,
            promptState: "已完成",
            describe: name,
          });
        }
      } else if (prompt) {
        const [newId] = await db("o_assets").insert({
          projectId,
          name,
          type: "scene",
          describe: name,
          prompt,
          promptState: "已完成",
          startTime: now,
        } as any);
        assetId = newId;
        nameToId.set(name, assetId);
      }

      if (assetId) {
        scenePrompts.push({ name, assetId, prompt });
      }
    }
  }

  return { characterPrompts, scenePrompts };
}
