import fs from "fs";
import path from "path";
import u from "@/utils";

const SKILL_BASE = "seedance";

export interface LoadedSkill {
  systemPrompt: string;
  templates: Record<string, string>;
  examples: Record<string, string>;
  references: Record<string, string>;
}

function readDirFiles(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(dir)) return result;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      result[entry.name.replace(".md", "")] = fs.readFileSync(fullPath, "utf-8");
    }
  }
  return result;
}

function readReferenceFiles(dir: string): Record<string, string> {
  const all = readDirFiles(dir);
  const result: Record<string, string> = {};
  for (const [name, content] of Object.entries(all)) {
    if (name !== "SKILL") {
      result[name] = content;
    }
  }
  return result;
}

export function loadSkill(skillName: string): LoadedSkill {
  const skillDir = u.getPath(`skills/${SKILL_BASE}/${skillName}`);
  const systemPrompt = fs.existsSync(path.join(skillDir, "SKILL.md"))
    ? fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8")
    : "";

  return {
    systemPrompt,
    templates: readDirFiles(path.join(skillDir, "templates")),
    examples: readDirFiles(path.join(skillDir, "examples")),
    references: readReferenceFiles(skillDir),
  };
}
