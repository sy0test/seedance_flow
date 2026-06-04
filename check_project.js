const Database = require('better-sqlite3');
const db = new Database('d:/CODE2026/toonflow_new/Toonflow-app/data/db2.sqlite');

console.log('=== Project 1780435297706 ===');
const proj = db.prepare('SELECT * FROM seedance_project WHERE projectId = 1780435297706').get();
console.log('seedance_project:', JSON.stringify(proj, null, 2));

console.log('\n=== Project 1779822920961 ===');
const proj2 = db.prepare('SELECT * FROM seedance_project WHERE projectId = 1779822920961').get();
console.log('seedance_project:', JSON.stringify(proj2, null, 2));

// Check o_project table
console.log('\n=== o_project for 1780435297706 ===');
try {
  const op = db.prepare('SELECT id, name FROM o_project WHERE id = ?').get(1780435297706);
  console.log(JSON.stringify(op));
} catch { console.log('not found'); }

console.log('\n=== o_project for 1779822920961 ===');
try {
  const op2 = db.prepare('SELECT id, name FROM o_project WHERE id = ?').get(1779822920961);
  console.log(JSON.stringify(op2));
} catch { console.log('not found'); }

// Check what the last clicked project might be
console.log('\n=== All seedance projects ===');
const all = db.prepare('SELECT projectId, visualStyle, targetMedium, aspectRatio FROM seedance_project').all();
all.forEach(p => console.log(JSON.stringify(p)));

db.close();
