/* node 自测：node test/payroll.test.js */
const assert = require("assert");
const P = require("../payroll.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + e.message); process.exitCode = 1; }
}
function expectThrow(fn, fragment) {
  try { fn(); } catch (e) { if (!fragment || e.message.includes(fragment)) return; throw new Error("报错信息不含「" + fragment + "」：" + e.message); }
  throw new Error("应当抛错但未抛错（期望含「" + fragment + "」）");
}

/* ---------- 工序计划 ---------- */
test("按纹样生成工序计划工量", () => {
  // 3x3：角格 4 个非底色
  const pattern = { cols: 3, rows: 3, cells: [1,0,0, 0,1,0, 0,0,1] };
  const plan = P.generatePlan(pattern);
  const q = k => P.planQty(plan, k);
  assert.strictEqual(q("patternCards"), 3);
  assert.strictEqual(q("weaving"), 9);
  assert.strictEqual(q("finishing"), 3); // ceil(9/4)
  // 色列：col0 有非底, col1, col2 各一 => 3
  assert.strictEqual(q("warping"), 3);
});

test("同列多色只按颜色数计牵经工量", () => {
  const pattern = { cols: 2, rows: 2, cells: [1,0, 2,0] };
  const plan = P.generatePlan(pattern);
  assert.strictEqual(P.planQty(plan, "warping"), 2);
  assert.strictEqual(P.planQty(plan, "patternCards"), 2);
});

/* ---------- 单价按生效日期 ---------- */
test("单价按生效日期取最近一条", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 4, rows: 2, cells: [1,0,0,0, 0,0,0,0] });
  P.setRate(db, { processKey: "weaving", from: "2026-03-01", price: 1.5 });
  assert.strictEqual(P.rateAt(db, "weaving", "2026-02-28").price, 0.8);
  assert.strictEqual(P.rateAt(db, "weaving", "2026-03-01").price, 1.5);
});

/* ---------- 跨班次分段 ---------- */
test("跨班次按覆盖时长切段并给班次津贴", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  // 13:00-15:00 = 早班1h + 中班1h，单价0.8，100件 => 80 元，各 40
  const r = P.calcEntry(db, { processKey: "weaving", date: "2026-09-14", start: "13:00", end: "15:00", qty: 100, reworkQty: 0 });
  assert.strictEqual(r.piecePay, 80);
  assert.strictEqual(r.segments.length, 2);
  assert.strictEqual(r.segments[0].shift, "早班");
  assert.strictEqual(r.segments[1].shift, "中班");
  // 津贴：早班 5 * 0.5 + 中班 8 * 0.5 = 6.5
  assert.strictEqual(r.allowance, 6.5);
});

test("跨夜班段自动跨夜", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const r = P.calcEntry(db, { processKey: "weaving", date: "2026-09-14", start: "21:00", end: "23:00", qty: 10, reworkQty: 0 });
  assert.strictEqual(r.segments[0].shift, "中班");
  assert.strictEqual(r.segments[1].shift, "夜班");
});

test("节假日段计件乘补贴倍数、返工不乘", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  P.toggleHoliday(db, "2026-10-01"); // 国庆
  const r = P.calcEntry(db, { processKey: "weaving", date: "2026-10-01", start: "09:00", end: "11:00", qty: 10, reworkQty: 10 });
  assert.strictEqual(r.piecePay, 10 * 0.8 * 2); // 16
  assert.strictEqual(r.reworkPay, P.r2(10 * 0.8 * 0.6)); // 4.8，无倍数
  assert.strictEqual(r.gross, P.r2(16 + 4.8 + 5)); // 早班津贴5
});

test("跨节假日午夜的加班分段", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  P.toggleHoliday(db, "2026-10-01");
  // 9/30 20:00-22:00 正常中班，无加班
  const r = P.calcEntry(db, {
    processKey: "weaving", date: "2026-09-30", start: "20:00", end: "22:00", qty: 10, reworkQty: 0,
    overtimes: [{ date: "2026-10-01", start: "09:00", end: "12:00" }] // 3h 节假日 3 倍
  });
  assert.strictEqual(r.overtimePay, P.r2(3 * 25 * 3));
});

test("加班与正常班次重叠被拦截", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  expectThrow(() => P.calcEntry(db, {
    processKey: "weaving", date: "2026-09-14", start: "09:00", end: "12:00", qty: 10,
    overtimes: [{ date: "2026-09-14", start: "11:00", end: "13:00" }]
  }), "重叠");
});

/* ---------- 录入校验 ---------- */
test("负数/超计划/缺单价被拦截", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 4, rows: 2, cells: [1,0,0,0, 0,0,0,0] });
  expectThrow(() => P.calcEntry(db, { processKey: "weaving", date: "2026-09-14", qty: -1 }), "负");
  expectThrow(() => P.calcEntry(db, { processKey: "weaving", date: "2026-09-14", qty: 9999 }), "计划工量");
  db.rates = db.rates.filter(r => r.processKey !== "finishing");
  expectThrow(() => P.calcEntry(db, { processKey: "finishing", date: "2026-09-14", qty: 1 }), "没有生效单价");
});

test("多件生产按 计划工量×件数 校验上限", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 4, rows: 2, cells: [1,0,0,0, 0,0,0,0] }); // weaving 计划 8
  // 2 件，可录到 16
  const r = P.calcEntry(db, { processKey: "weaving", date: "2026-09-14", qty: 16, pieces: 2 });
  assert.strictEqual(r.pieces, 2);
  assert.strictEqual(r.piecePay, P.r2(16 * 0.8));
  expectThrow(() => P.calcEntry(db, { processKey: "weaving", date: "2026-09-14", qty: 17, pieces: 2 }), "计划工量");
});

/* ---------- 确认/锁定/调整 ---------- */
function draftSheet() {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30", title: "9月" });
  P.addEntry(db, sh.id, { processKey: "weaving", date: "2026-09-14", start: "09:00", end: "11:00", qty: 100, reworkQty: 0 });
  P.updateDraft(db, sh.id, { advance: 10 });
  return { db, sh };
}

test("确认工资单并冻结", () => {
  const { db, sh } = draftSheet();
  const res = P.confirmSheet(db, sh.id);
  // 100*0.8=80 + 早班津贴5 - 预支10 = 75
  assert.strictEqual(res.totals.net, 75);
  assert.strictEqual(sh.status, "confirmed");
  assert.ok(sh.frozen);
});

test("重复确认被拦截", () => {
  const { db, sh } = draftSheet();
  P.confirmSheet(db, sh.id);
  expectThrow(() => P.confirmSheet(db, sh.id), "不能重复确认");
});

test("历史单价变化不影响已锁定工资", () => {
  const { db, sh } = draftSheet();
  P.confirmSheet(db, sh.id);
  const frozenNet = sh.frozen.result.totals.net;
  // 新增更晚生效价（此前无 9/14 之后的价，加 9/20 的价不影响；再加 1/1 同日改价应被锁拦截）
  P.setRate(db, { processKey: "weaving", from: "2026-09-20", price: 9 });
  assert.strictEqual(sh.frozen.result.totals.net, frozenNet);
  expectThrow(() => P.setRate(db, { processKey: "weaving", from: "2026-01-01", price: 3 }), "锁定");
  const audit = P.auditData(db);
  assert.ok(audit.ok, JSON.stringify(audit.sheets, null, 2));
});

test("确认后只能开调整单，调整单可正可负但不能发负", () => {
  const { db, sh } = draftSheet();
  P.confirmSheet(db, sh.id);
  expectThrow(() => P.updateDraft(db, sh.id, { advance: 20 }), "调整单");
  expectThrow(() => P.addEntry(db, sh.id, { processKey: "weaving", date: "2026-09-15", qty: 1 }), "调整单");
  expectThrow(() => P.addAdjustment(db, sh.id, { amount: 5, reason: "" }), "原因必填");
  const adj = P.addAdjustment(db, sh.id, { amount: -20, reason: "预支补录", date: "2026-09-30" });
  assert.strictEqual(P.currentNet(db, sh), 55);
  expectThrow(() => P.addAdjustment(db, sh.id, { amount: -1000, reason: "x" }), "不能为负");
  assert.ok(adj.id);
});

test("预支超发在确认时拦截且不留半单", () => {
  const { db, sh } = draftSheet();
  P.updateDraft(db, sh.id, { advance: 5000 });
  const before = db.sheets.length;
  expectThrow(() => P.confirmSheet(db, sh.id), "应发净额为负");
  assert.strictEqual(sh.status, "draft"); // 仍是草稿
  assert.ok(!sh.frozen);
  assert.strictEqual(db.sheets.length, before);
  assert.strictEqual(db.adjustments.length, 0);
});

test("缺少织工被拦截", () => {
  const { db, sh } = draftSheet();
  sh.weaverId = "ghost";
  expectThrow(() => P.confirmSheet(db, sh.id), "织工");
  expectThrow(() => P.addSheet(db, { weaverId: "ghost", periodStart: "2026-10-01", periodEnd: "2026-10-31" }), "织工");
});

test("空明细不能确认", () => {
  const db = P.defaultData();
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  expectThrow(() => P.confirmSheet(db, sh.id), "没有任何");
});

/* ---------- 导出/导入复核 ---------- */
test("导出再导入复核同一结果", () => {
  const { db, sh } = draftSheet();
  P.confirmSheet(db, sh.id);
  P.addAdjustment(db, sh.id, { amount: -5, reason: "餐费", date: "2026-09-28" });
  const bundle = P.exportBundle(db, { cols: 10, rows: 10, cells: Array(100).fill(0) });
  const imp = P.importBundle(bundle.file);
  assert.ok(imp.report.ok, JSON.stringify(imp.report, null, 2));
  const importedSheet = imp.data.sheets[0];
  assert.strictEqual(P.currentNet(imp.data, importedSheet), 70); // 75-5
});

test("文件被改动后校验和不通过", () => {
  const { db } = draftSheet();
  const bundle = P.exportBundle(db);
  const tampered = bundle.file.replace('"price": 0.8', '"price": 9.9');
  expectThrow(() => P.importBundle(tampered), "校验和");
});

test("checksum 浏览器/node 稳定（确定性）", () => {
  const a = P.checksum({ b: 1, a: [2, { z: 1, y: 2 }] });
  const b = P.checksum({ a: [2, { y: 2, z: 1 }], b: 1 });
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
});

console.log("\n" + passed + " 项通过" + (process.exitCode ? "，存在失败" : ""));
