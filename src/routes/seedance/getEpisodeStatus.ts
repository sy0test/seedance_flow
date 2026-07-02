import express from "express";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";

/** 从 AI 输出的 XML 标签中提取结构化数据 */
function extractXmlData(content: string): Record<string, any[]> {
  const result: Record<string, any[]> = {};

  // 解析自闭合子标签的属性
  function parseAttrs(str: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /(\w+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(str)) !== null) attrs[m[1]] = m[2];
    return attrs;
  }

  // 提取容器标签内的子项目（自闭合 <item ... /> 或 带内容 <tag>...</tag>）
  const containerRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let containerMatch;
  while ((containerMatch = containerRe.exec(content)) !== null) {
    const tagName = containerMatch[1];
    const inner = containerMatch[2];
    const items: any[] = [];

    // 自闭合子标签 <item ... />
    let itemRe = /<item\s+([^>]*?)\s*\/>/g;
    let itemMatch;
    while ((itemMatch = itemRe.exec(inner)) !== null) {
      items.push({ tag: "item", ...parseAttrs(itemMatch[1]) });
    }

    // 带内容子标签 <tag>content</tag>
    let contentRe = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>/g;
    let contentMatch;
    while ((contentMatch = contentRe.exec(inner)) !== null) {
      items.push({ tag: contentMatch[1], ...parseAttrs(contentMatch[2]), value: contentMatch[3].trim() });
    }

    if (items.length > 0) result[tagName] = items;
  }

  return result;
}

export default express.Router().get("/", async (req, res) => {
  try {
    const episodeId = req.query.episodeId;
    const episode = await u.db("seedance_episode").where("id", episodeId).first();
    const outputs = await u.db("seedance_output").where("episodeId", episodeId).select("*");

    // 为每个 output 提取结构化数据
    const outputsWithData = outputs.map((o: any) => ({
      ...o,
      structuredData: o.content ? extractXmlData(o.content) : {},
    }));

    res.json(success({ episode, outputs: outputsWithData }));
  } catch (e: any) {
    res.json(error(e.message));
  }
});
