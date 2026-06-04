import { describe, it, expect } from "vitest";

// 从 markdown 中提取角色名和提示词
//
// 当前线上版本 (saveArtDesignAssets 行 826) 的正则过于严格：
// 1. 括号只匹配全角，半角不匹配
// 2. 提示词标题只匹配 **提示词** 一种写法

const currentRegex = /(?:^|\n)##\s+(?!\#)(.+?)(?:（[^）]*）)?\s*\n[\s\S]*?\*\*提示词\*\*[：:]\s*\n([\s\S]*?)(?=\n(?:---|\n##\s(?!\#)|$))/g;

const fixedRegex = /(?:^|\n)##\s+(?!\#)(?!人物提示词|场景道具提示词|场景提示词|角色提示词)(.+?)(?:\s*[（(][^）)]*[）)])?\s*\n[\s\S]*?\*\*(?:角色提示词|人物提示词|人物造型|角色造型|提示词|character)\*\*[：:]\s*\n([\s\S]*?)(?=\n(?:---|\n##\s(?!\#)|$))/g;

function extractCharacters(content: string, regex: RegExp): Array<{ name: string; prompt: string }> {
  const items: Array<{ name: string; prompt: string }> = [];
  let m: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((m = regex.exec(content)) !== null) {
    items.push({ name: m[1].trim(), prompt: m[2].trim() });
  }
  return items;
}


describe("当前正则 — 能处理的格式", () => {
  it("全角括号 + 提示词 + 末尾有换行", () => {
    const md = "## 孙悟空（ep01 新增）\n\n**出图要求**：一张图\n\n**提示词**：\n齐天大圣孙悟空，身穿金色铠甲\n";
    const chars = extractCharacters(md, currentRegex);
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe("孙悟空");
    expect(chars[0].prompt).toContain("齐天大圣孙悟空");
  });
});

describe("当前正则 — 测试预期失败（证明 bug）", () => {
  it("半角括号 — 当前正则会匹配但名字错误（含括号原文）", () => {
    const md = "## 孙悟空(ep01)\n\n**提示词**：\n齐天大圣\n";
    const chars = extractCharacters(md, currentRegex);
    // 当前正则会匹配成功，但名字返回 "孙悟空(ep01)"（包含半角括号）
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe("孙悟空(ep01)");
    // 名字错误：应该是 "孙悟空"
    expect(chars[0].name).not.toBe("孙悟空");
  });

  it("角色提示词标题 — 当前正则应该失败", () => {
    const md = "## 孙悟空（ep01 新增）\n\n**角色提示词**：\n齐天大圣\n";
    const chars = extractCharacters(md, currentRegex);
    expect(chars).toHaveLength(0);
  });

  it("多角色混合格式 — 当前正则只能部分提取", () => {
    const md = "## 孙悟空（ep01 新增）\n\n**提示词**：\n齐天大圣\n\n---\n\n## 唐僧(ep01)\n\n**角色提示词**：\n金蝉子\n";
    const chars = extractCharacters(md, currentRegex);
    expect(chars.length).toBeLessThan(2);
    if (chars.length > 0) {
      expect(chars[0].name).toBe("孙悟空");
    }
  });
});

describe("修复后正则 — 验证各种格式", () => {
  it("全角括号 + 提示词", () => {
    const md = "## 孙悟空（ep01 新增）\n\n**提示词**：\n齐天大圣\n";
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe("孙悟空");
  });

  it("半角括号 + 提示词", () => {
    const md = "## 孙悟空(ep01)\n\n**提示词**：\n齐天大圣\n";
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe("孙悟空");
  });

  it("无括号 + 角色提示词", () => {
    const md = "## 孙悟空\n\n**角色提示词**：\n齐天大圣\n";
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe("孙悟空");
  });

  it("半角括号 + 人物提示词", () => {
    const md = "## 唐僧(ep01)\n\n**人物提示词**：\n金蝉子\n";
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe("唐僧");
  });

  it("全角括号 + 人物造型", () => {
    const md = "## 猪八戒（ep01）\n\n**人物造型**：\n天蓬元帅\n";
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe("猪八戒");
  });

  it("全角括号 + 角色造型", () => {
    const md = "## 沙僧（ep01）\n\n**角色造型**：\n卷帘大将\n";
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe("沙僧");
  });

  it("半角括号 + character", () => {
    const md = "## 白龙马(ep01)\n\n**character**：\n西海龙王三太子\n";
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe("白龙马");
  });

  it("多角色混合格式全部提取", () => {
    const md = [
      "## 孙悟空（ep01 新增）",
      "",
      "**提示词**：",
      "齐天大圣",
      "",
      "---",
      "",
      "## 唐僧(ep01)",
      "",
      "**角色提示词**：",
      "金蝉子",
      "",
      "---",
      "",
      "## 猪八戒（ep02）",
      "",
      "**人物造型**：",
      "天蓬元帅",
      "",
    ].join("\n");
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(3);
    expect(chars[0].name).toBe("孙悟空");
    expect(chars[1].name).toBe("唐僧");
    expect(chars[2].name).toBe("猪八戒");
  });

  it("不要错误匹配 ### 子标题", () => {
    const md = "## 孙悟空\n\n**提示词**：\n齐天大圣\n\n### 子标题内容\n";
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(1);
  });

});

describe("真实 AI 输出格式 — 代码块内角色提取", () => {
  it("代码块内的角色", () => {
    const md = [
      "好的，开始设计。",
      "",
      "### 人物提示词",
      "",
      '```markdown',
      "# 人物提示词",
      "",
      "## 林小雨（ep01 新增）",
      "",
      "**出图要求**：一张图",
      "",
      "**提示词**：",
      "角色设定图，白色干净背景。",
      "",
      "---",
      "",
      "## 张明（ep01 新增）",
      "",
      "**提示词**：",
      "角色设定图，男性。",
      "",
      "---",
      '```',
      "",
      "### 场景提示词",
      "",
      '```markdown',
      "## ep01 场景宫格",
      "",
      "请生成一张 3×3 九宫格布局的电影场景环境图像。",
      "格1——【咖啡店角落】",
      '```',
    ].join("\n");
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(2);
    expect(chars[0].name).toBe("林小雨");
    expect(chars[0].prompt).toContain("角色设定图");
    expect(chars[1].name).toBe("张明");
  });

});

describe("章节标题不应被误识别为角色（负向前瞻排除）", () => {
  it("人物提示词不应被捕获", () => {
    const md = [
      "## 人物提示词",
      "",
      "文件：assets/character-prompts.md",
      "",
      "## 林小雨（ep01 新增）",
      "",
      "**提示词**：",
      "角色设定图。",
      "---",
    ].join("\n");
    // 负向前瞻 (?!人物提示词) 跳过章节标题
    const chars = extractCharacters(md, fixedRegex);
    expect(chars).toHaveLength(1);
    expect(chars[0].name).toBe("林小雨");
  });

});
