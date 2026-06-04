const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "chatPipeline.ts");
let content = fs.readFileSync(filePath, "utf8");

// Target: find and replace the OLD regex line
// Strategy: search for the comment line, then replace the next regex line
const oldComment = '    // 角色提取（排除 ### 子标题干扰，标签括号和冒号格式放宽）\n';
const newComment = '    // 角色提取（排除 ### 子标题干扰，支持半角括号和多种提示词标题）\n';

const idx = content.indexOf(oldComment);
if (idx === -1) {
  console.error("Could not find the target comment!");
  process.exit(1);
}

// The regex line starts right after the comment line
const lineAfterComment = content.indexOf("\n", idx + oldComment.length) + 1;
if (lineAfterComment === 0) {
  console.error("No line after comment!");
  process.exit(1);
}

// Find the end of the regex line (next newline)
const endOfRegexLine = content.indexOf("\n", lineAfterComment);
if (endOfRegexLine === -1) {
  console.error("Could not find end of regex line!");
  process.exit(1);
}

const oldRegexLine = content.slice(lineAfterComment, endOfRegexLine);
console.log("Found old regex line:", JSON.stringify(oldRegexLine));

// The new regex line
const newRegexLine = '    const charRe = /(?:^|\\n)##\\s+(?!\\#)(.+?)(?:\\s*[（(][^）)]*[）)])?\\s*\\n[\\s\\S]*?\\*\\*(?:角色提示词|人物提示词|人物造型|角色造型|提示词|character)\\*\\*[：:]\\s*\\n([\\s\\S]*?)(?=\\n(?:---|\\n##\\s(?!\\#)|$))/g;';

// Build new content
const newContent =
  content.slice(0, lineAfterComment) +
  newRegexLine +
  content.slice(endOfRegexLine);

fs.writeFileSync(filePath, newContent, "utf8");
console.log("Replacement done!");

// Verify
const verify = fs.readFileSync(filePath, "utf8");
const verifyIdx = verify.indexOf("const charRe");
const verifyLine = verify.slice(verifyIdx, verify.indexOf("\n", verifyIdx));
console.log("New line:", JSON.stringify(verifyLine));
