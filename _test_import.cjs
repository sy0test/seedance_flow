const axios = require("axios");
const mammoth = require("mammoth");
const fs = require("fs");

async function main() {
  const filePath = "D:/WeChat/xwechat_files/wxid_4563105658612_3171/msg/file/2026-05/Light and Shadow_ The Twins’ Sacrifice.docx";

  let text;
  try {
    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } catch (e) {
    // Try with regular quote
    const filePath2 = "D:/WeChat/xwechat_files/wxid_4563105658612_3171/msg/file/2026-05/Light and Shadow_ The Twins' Sacrifice.docx";
    const buffer = fs.readFileSync(filePath2);
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  }

  console.log("Extracted", text.length, "chars");
  console.log("First 300:", text.slice(0, 300));
  console.log("---");

  const login = await axios.post("http://localhost:10588/api/login/login", {
    username: "admin", password: "admin123"
  });
  const token = login.data.data.token;

  const importResult = await axios.post("http://localhost:10588/api/script/batchAddScript", {
    projectId: 1,
    scripts: [
      { scriptName: "Light and Shadow - The Twins Sacrifice", scriptData: text }
    ]
  }, {
    headers: { Authorization: token }
  });
  console.log("Import response:", JSON.stringify(importResult.data, null, 2).slice(0, 1000));

  // Clean up test file
  fs.unlinkSync(__dirname + "/../_test_import.mjs");
}

main().catch(e => { console.error(e.message); process.exit(1); });
