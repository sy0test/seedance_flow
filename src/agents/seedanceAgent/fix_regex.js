const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "chatPipeline.ts");
let content = fs.readFileSync(filePath, "utf8");
const lines = content.split("\n");

// Find all lines with charRe and remove them
const filteredLines = [];
let inBrokenBlock = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  if (line.includes("const charRe") && !inBrokenBlock) {
    // This is the start of a broken section
    inBrokenBlock = true;
    // Don't add this line, we'll replace the whole block
    continue;
  }

  if (inBrokenBlock) {
    // Skip lines that are part of the broken regex block
    // The broken block contains these patterns
    if (
      line.includes("let m;") ||
      line.includes("while ((m = charRe")
    ) {
      inBrokenBlock = false;
      // "let m;" goes into filtered output
      filteredLines.push(line);
    }
    // else: skip this line (part of the broken regex)
    continue;
  }

  filteredLines.push(line);
}

// Build the correct single-line regex
const regexLine =
  '    const charRe = /(?:^|\\n)##\\s+(?!\\#)(.+?)(?:（[^）]*）)?\\s*\\n[\\s\\S]*?\\*\\*提示词\\*\\*[：:]\\s*\\n([\\s\\S]*?)(?=\\n(?:---|\\n##\\s(?!\\#)|$))/g;';

// Find the position to insert (before "    let m;")
const insertIdx = filteredLines.findIndex((l) => l.trim() === "let m;");
if (insertIdx >= 0) {
  filteredLines.splice(insertIdx, 0, regexLine);
} else {
  console.error("Could not find 'let m;' marker!");
  process.exit(1);
}

fs.writeFileSync(filePath, filteredLines.join("\n"), "utf8");
console.log("File restored successfully. Total lines:", filteredLines.length);
