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

/* ---------- 边界回归：加班日期 / 重叠班次 / 精确冻结 ---------- */

test("【回归】周期外加班被拦截（即使生产日期在周期内）", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  // 入表即拦：生产在 9 月内，加班却落在 10/01（周期外）
  expectThrow(() => P.addEntry(db, sh.id, {
    processKey: "weaving", date: "2026-09-30", start: "09:00", end: "11:00", qty: 10,
    overtimes: [{ date: "2026-10-01", start: "09:00", end: "10:00" }]
  }), "不在结算周期");
  assert.strictEqual(sh.entries.length, 0);

  // 兜底：直接构造的脏数据（如旧档/导入档）在试算与确认时同样被拦
  sh.entries = [{ processKey: "weaving", date: "2026-09-30", start: "09:00", end: "11:00",
    pieces: 1, qty: 10, reworkQty: 0, overtimes: [{ date: "2026-10-01", start: "09:00", end: "10:00" }] }];
  expectThrow(() => P.calcSheet(db, sh), "不在结算周期");
  expectThrow(() => P.confirmSheet(db, sh.id), "不在结算周期");
  // 确认失败不留半单
  assert.strictEqual(sh.status, "draft");
  assert.ok(!sh.frozen);

  // 同一段加班挪回周期内即可确认
  sh.entries[0].overtimes = [{ date: "2026-09-29", start: "19:00", end: "20:00" }];
  const res = P.confirmSheet(db, sh.id);
  assert.strictEqual(res.totals.overtimePay, P.r2(1 * 25 * 2)); // 日常加班 2 倍
});

test("【回归】新增/修改重叠班次被拦截（含跨夜与端点相接）", () => {
  const db = P.defaultData();
  db.shifts = [
    { id: "s1", name: "早班", start: "06:00", end: "12:00", allowance: 0 },
    { id: "s2", name: "夜班", start: "22:00", end: "06:00", allowance: 0 }
  ];
  // 与早班部分重叠
  expectThrow(() => P.setShift(db, { name: "插班", start: "11:00", end: "13:00", allowance: 0 }), "重叠");
  // 与跨夜夜班 22:00-06:00 重叠（05:00-07:00 压到夜班尾）
  expectThrow(() => P.setShift(db, { name: "深夜班", start: "05:00", end: "07:00", allowance: 0 }), "重叠");
  // 端点相接（半开区间）合法：12:00-22:00 两端分别贴早班、夜班
  const t = P.setShift(db, { name: "衔接班", start: "12:00", end: "22:00", allowance: 0 });
  assert.ok(t.id);
  // 改成重叠时段被拒绝
  expectThrow(() => P.setShift(db, { id: t.id, name: "衔接班", start: "11:30", end: "22:00", allowance: 0 }), "重叠");
  // 数据未被半改：仍是原时间
  const after = db.shifts.find(s => s.id === t.id);
  assert.strictEqual(after.start, "12:00");
  assert.strictEqual(after.end, "22:00");
});

test("【回归】合法班次修改后草稿实时重算、确认单不受影响且一致", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  P.addEntry(db, sh.id, { processKey: "weaving", date: "2026-09-14", start: "09:00", end: "11:00", qty: 100 });
  // 确认前：早班津贴 5
  assert.strictEqual(P.calcSheet(db, sh).totals.allowance, 5);
  // 确认
  const confirmed = P.confirmSheet(db, sh.id);
  assert.strictEqual(confirmed.totals.allowance, 5);
  // 已确认单引用的班次不能改
  expectThrow(() => P.setShift(db, { id: "s1", name: "早班", start: "06:00", end: "14:00", allowance: 99 }), "锁定");
  // 未引用的中班津贴可改，且不影响已确认单
  P.setShift(db, { id: "s2", name: "中班", start: "14:00", end: "22:00", allowance: 88 });
  const audit = P.auditData(db);
  assert.ok(audit.ok, JSON.stringify(audit.sheets, null, 2));
  assert.strictEqual(db.sheets[0].frozen.result.totals.allowance, 5);
});

test("【回归】确认后未引用的历史单价/班次仍可修改，引用的被锁定", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  // 给“整理整修”配一条价（本单不会录入该工序）
  P.setRate(db, { processKey: "finishing", from: "2026-01-01", price: 0.55 });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  P.addEntry(db, sh.id, { processKey: "weaving", date: "2026-09-14", start: "09:00", end: "11:00", qty: 100 });
  P.confirmSheet(db, sh.id);

  // 冻结快照只含实际引用的规则
  assert.deepStrictEqual(sh.frozen.rates.map(r => r.processKey).sort(), ["weaving"]);
  // 工作时间 09-11 只命中早班
  assert.deepStrictEqual(sh.frozen.shifts.map(s => s.name), ["早班"]);

  // 未被引用的 finishing 历史单价可以改
  const finRate = db.rates.find(r => r.processKey === "finishing");
  assert.strictEqual(P.rateIsFrozen(db, finRate.id), false);
  P.setRate(db, { processKey: "finishing", from: "2026-01-01", price: 0.7 });
  assert.strictEqual(P.rateAt(db, "finishing", "2026-09-14").price, 0.7);
  // 未被引用的夜班/中班也能改
  assert.strictEqual(P.shiftIsFrozen(db, "s2"), false);
  assert.strictEqual(P.shiftIsFrozen(db, "s3"), false);
  P.setShift(db, { id: "s3", name: "夜班", start: "22:30", end: "05:30", allowance: 20 });

  // 实际引用的 weaving 单价与早班仍被锁定
  const weaveRate = db.rates.find(r => r.processKey === "weaving" && r.from === "2026-01-01");
  assert.strictEqual(P.rateIsFrozen(db, weaveRate.id), true);
  expectThrow(() => P.setRate(db, { processKey: "weaving", from: "2026-01-01", price: 5 }), "锁定");
  assert.strictEqual(P.shiftIsFrozen(db, "s1"), true);
  expectThrow(() => P.setShift(db, { id: "s1", name: "早班", start: "06:00", end: "14:00", allowance: 9 }), "锁定");

  // 复核仍然一致
  assert.ok(P.auditData(db).ok);
});

test("【回归】只锁定实际引用的节假日，未引用日期可自由增删", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  P.toggleHoliday(db, "2026-10-01"); // 本单用到
  P.toggleHoliday(db, "2026-05-01"); // 本单不用
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-15", periodEnd: "2026-10-05" });
  P.addEntry(db, sh.id, { processKey: "weaving", date: "2026-10-01", start: "09:00", end: "11:00", qty: 10 });
  P.confirmSheet(db, sh.id);
  // 冻结节假日只含实际引用的一天
  assert.deepStrictEqual(sh.frozen.holidays, ["2026-10-01"]);
  // 引用日不能取消
  expectThrow(() => P.toggleHoliday(db, "2026-10-01"), "锁定");
  // 未引用日可自由删除，且不影响已确认单复核
  P.toggleHoliday(db, "2026-05-01");
  assert.ok(P.auditData(db).ok);
});

/* ---------- 时间边界回归：首日 / 末日 / 零时长 / 跨夜 ---------- */

function sepDb() {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  return db;
}
const baseEntry = (over) => Object.assign({
  processKey: "weaving", qty: 10, start: "09:00", end: "11:00"
}, over);

test("【时间回归】生产起止相同 → 拒绝，不当作 24 小时", () => {
  const db = sepDb();
  expectThrow(() => P.calcEntry(db, baseEntry({ date: "2026-09-15", start: "08:00", end: "08:00", qty: 10 })), "零时长");
  expectThrow(() => P.addEntry(db, P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" }).id,
    baseEntry({ date: "2026-09-15", start: "08:00", end: "08:00" })), "零时长");
});

test("【时间回归】加班起止相同 → 拒绝，不按一整天计费", () => {
  const db = sepDb();
  expectThrow(() => P.calcEntry(db, baseEntry({
    date: "2026-09-15",
    overtimes: [{ date: "2026-09-15", start: "19:00", end: "19:00" }]
  })), "零时长");
});

test("【时间回归】末日深夜跨入次月（生产/加班）→ 拒绝，提示拆单", () => {
  const db = sepDb();
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  // 9/30 22:00 → 10/01 06:00（夜班全段，含 6h 周期外），拒绝
  expectThrow(() => P.addEntry(db, sh.id, baseEntry({
    date: "2026-09-30", start: "22:00", end: "06:00", qty: 10
  })), "拆成两笔");
  // 9/30 生产正常，但 9/30 23:00→10/01 01:00 加班跨出周期，拒绝
  expectThrow(() => P.addEntry(db, sh.id, baseEntry({
    date: "2026-09-30", start: "20:00", end: "22:00", qty: 10,
    overtimes: [{ date: "2026-09-30", start: "23:00", end: "01:00" }]
  })), "拆成两笔");
  assert.strictEqual(sh.entries.length, 0);
});

test("【时间回归】首日前跨入时段 → 拒绝", () => {
  const db = sepDb();
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  // 8/31 23:00 上班、跨夜到 9/1 05:00 下班：起点在首日前，整笔拒绝（应拆到 8 月周期）
  expectThrow(() => P.addEntry(db, sh.id, baseEntry({
    date: "2026-08-31", start: "23:00", end: "05:00"
  })), "不在结算周期");
  // 首日凌晨的工时只能从 00:00 起：9/1 00:00-05:00 合法
  P.addEntry(db, sh.id, baseEntry({ date: "2026-09-01", start: "00:00", end: "05:00", qty: 10 }));
  assert.strictEqual(P.calcSheet(db, sh).lines[0].totalMinutes, 300);
});

test("【时间回归】末日做到 24:00 整、首日从 00:00 起 → 合法且不多算", () => {
  const db = sepDb();
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  // 末日 22:00 → 24:00（= 10/1 00:00，正好贴周期边界），只含夜班 2h
  P.addEntry(db, sh.id, baseEntry({ date: "2026-09-30", start: "22:00", end: "00:00", qty: 10 }));
  const r = P.calcSheet(db, sh);
  assert.strictEqual(r.lines[0].totalMinutes, 120);
  assert.strictEqual(r.lines[0].segments.length, 1);
  assert.strictEqual(r.lines[0].segments[0].shift, "夜班");
  // 夜班津贴：只跨一个班次，覆盖满，给满 15
  assert.strictEqual(r.totals.allowance, 15);
  // 计件 10*0.8=8.0，无节假日
  assert.strictEqual(r.totals.piecePay, 8);
});

test("【时间回归】周期中段跨夜班照常分段（非边界跨夜不被误伤）", () => {
  const db = sepDb();
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  P.addEntry(db, sh.id, baseEntry({ date: "2026-09-14", start: "22:00", end: "06:00", qty: 80 }));
  const r = P.calcSheet(db, sh);
  assert.strictEqual(r.lines[0].totalMinutes, 480);
  assert.strictEqual(r.lines[0].segments[0].shift, "夜班");
  assert.strictEqual(r.lines[0].segments[0].minutes, 480);
  assert.strictEqual(r.totals.piecePay, P.r2(80 * 0.8));
});

test("【时间回归】首日前跨加班 → 拒绝", () => {
  const db = sepDb();
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  expectThrow(() => P.addEntry(db, sh.id, baseEntry({
    date: "2026-09-01", start: "09:00", end: "11:00",
    overtimes: [{ date: "2026-08-31", start: "23:00", end: "00:30" }]
  })), "不在结算周期");
});

test("【时间回归】边界修复后确认/冻结/导入复核保持不变", () => {
  const db = sepDb();
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  // 一笔跨中班/夜班边界的正常单（21:00-23:00）
  P.addEntry(db, sh.id, baseEntry({ date: "2026-09-14", start: "21:00", end: "23:00", qty: 100 }));
  P.updateDraft(db, sh.id, { advance: 10 });
  const res = P.confirmSheet(db, sh.id);
  // 100*0.8=80；津贴 中班 8*0.5 + 夜班 15*0.5 = 11.5；实发 81.5
  assert.strictEqual(res.totals.gross, P.r2(80 + 11.5));
  assert.strictEqual(res.totals.net, P.r2(80 + 11.5 - 10));
  // 冻结精确到引用的两个班次
  assert.deepStrictEqual(sh.frozen.shifts.map(s => s.name).sort(), ["中班", "夜班"]);
  // 导出再导入复核逐分一致
  const imp = P.importBundle(P.exportBundle(db).file);
  assert.ok(imp.report.ok, JSON.stringify(imp.report.sheets, null, 2));
  assert.strictEqual(imp.report.sheets[0].net, res.totals.net);
});

/* ---------- 旧档迁移回归：升级后旧已确认单始终按冻结结果复核 ---------- */

// 模拟“升级前版本”确认一张单：用 legacy 语义计算，并按旧版格式做全量冻结快照
  // （旧版冻结整库 rates/shifts/holidays，且没有区间周期校验）
  function confirmLikeOldVersion(db, sheet) {
    var result = P.calcSheet(db, sheet, { strict: false });
    sheet.status = "confirmed";
    sheet.confirmedAt = "2026-08-31T10:00:00.000Z";
    sheet.frozen = {
      result: result,
      rates: db.rates.map(P.clone),
      shifts: db.shifts.map(P.clone),
      holidays: db.holidays.slice(),
      holidayMultiplier: db.holidayMultiplier,
      overtimeRate: db.overtimeRate,
      plan: db.plan ? P.clone(db.plan) : null
    };
    return result;
  }

test("【旧档迁移】跨月加班的旧已确认单：升级后复核不再判越界，金额逐分一致", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  // 旧版允许：8/31 晚正常工 + 8/31 23:00→9/1 01:00 跨月加班，旧版按旧规则算出并冻结了金额
  sh.entries = [{
    processKey: "weaving", date: "2026-08-31", start: "20:00", end: "22:00",
    pieces: 1, qty: 20, reworkQty: 0,
    overtimes: [{ date: "2026-08-31", start: "23:00", end: "01:00" }]
  }];
  const oldResult = confirmLikeOldVersion(db, sh);
  // 旧版实际发了：计件 20*0.8=16 + 加班 2h*25*2=100 + 中班津贴 8
  assert.strictEqual(oldResult.totals.gross, P.r2(16 + 100 + 8));
  assert.strictEqual(oldResult.totals.overtimePay, 100);

  // 升级后严格规则下这笔是“不允许新建”的
  expectThrow(() => P.calcSheet(db, sh), "拆成两笔");
  // 但复核旧已确认单：按冻结规则 legacy 重算，逐分一致，通过
  const audit = P.auditData(db);
  assert.ok(audit.ok, JSON.stringify(audit.sheets, null, 2));
  assert.strictEqual(audit.sheets[0].net, oldResult.totals.net);

  // 导出再导入同样复核同一结果
  const imp = P.importBundle(P.exportBundle(db).file);
  assert.ok(imp.report.ok, JSON.stringify(imp.report.sheets, null, 2));
  assert.strictEqual(imp.report.sheets[0].frozenNet, oldResult.totals.net);

  // 旧单仍只能走调整单，调整后复核通过且不重放新规则
  P.addAdjustment(db, sh.id, { amount: -5, reason: "旧档补扣款", date: "2026-09-02" });
  assert.ok(P.auditData(db).ok);
  assert.strictEqual(P.currentNet(db, sh), P.r2(oldResult.totals.net - 5));
});

test("【旧档迁移】相同时刻按 24h 计薪的旧已确认单：复核按冻结结果通过", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  // 旧版 bug：start=end 按 24 小时，拿满三班津贴；金额已冻结
  sh.entries = [{
    processKey: "weaving", date: "2026-08-15", start: "08:00", end: "08:00",
    pieces: 1, qty: 10, reworkQty: 0, overtimes: []
  }];
  const oldResult = confirmLikeOldVersion(db, sh);
  // legacy 复核必须复现旧金额（含满全天 5+8+15=28 津贴）
  assert.ok(P.auditData(db).ok, JSON.stringify(P.auditData(db).sheets, null, 2));
  // 而新建/草稿严格模式仍拒绝零时长
  expectThrow(() => P.calcEntry(db, sh.entries[0]), "零时长");
  assert.strictEqual(P.auditData(db).sheets[0].frozenNet, oldResult.totals.net);
});

test("【旧档迁移】旧版遗留草稿仍按严格规则提示修正，不影响已确认单", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  // 一张旧确认单（合法）+ 一张旧草稿（含跨月加班）
  const good = P.addSheet(db, { weaverId: "w1", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  P.addEntry(db, good.id, { processKey: "weaving", date: "2026-08-20", start: "09:00", end: "11:00", qty: 10 });
  confirmLikeOldVersion(db, good);

  const draft = P.addSheet(db, { weaverId: "w2", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  draft.entries = [{
    processKey: "weaving", date: "2026-08-31", start: "20:00", end: "22:00",
    pieces: 1, qty: 10, reworkQty: 0,
    overtimes: [{ date: "2026-08-31", start: "23:00", end: "01:00" }]
  }];
  const audit = P.auditData(db);
  // 整库复核不整体判坏：已确认单通过；草稿被严格规则标出（异常落在草稿行，不阻断确认单）
  const goodRow = audit.sheets.find(r => r.id === good.id);
  const draftRow = audit.sheets.find(r => r.id === draft.id);
  assert.ok(goodRow.ok, "旧已确认单通过");
  assert.ok(!draftRow.ok && /拆成两笔/.test(draftRow.errors.join()), "旧草稿按新规则提示拆分");
  // 草稿修正后可正常确认
  draft.entries[0].overtimes = [{ date: "2026-08-31", start: "22:00", end: "23:00" }];
  assert.ok(P.confirmSheet(db, draft.id).totals.overtimePay > 0);
  assert.ok(P.auditData(db).ok);
});

test("【旧档迁移】导入旧版台账文件即复核通过，无需手工迁移", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  sh.entries = [{
    processKey: "weaving", date: "2026-08-31", start: "20:00", end: "22:00",
    pieces: 1, qty: 20, reworkQty: 0,
    overtimes: [{ date: "2026-08-31", start: "23:00", end: "01:00" }]
  }];
  const frozen = confirmLikeOldVersion(db, sh);
  const file = P.exportBundle(db).file; // 模拟升级前导出的旧档
  const imp = P.importBundle(file);     // 升级后导入
  assert.ok(imp.report.ok, JSON.stringify(imp.report.sheets, null, 2));
  assert.strictEqual(imp.report.sheets[0].net, P.r2(frozen.totals.net - 0));
});

/* ---------- 损坏档回归：已确认单结构/算术校验，导入前拒绝 ---------- */

// 产出一张结构完整的已确认台账（含调整单），各破坏用例在其副本上动手脚
function goodConfirmedLedger() {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30", title: "9月" });
  P.addEntry(db, sh.id, { processKey: "weaving", date: "2026-09-14", start: "09:00", end: "11:00", qty: 100 });
  P.confirmSheet(db, sh.id);
  P.addAdjustment(db, sh.id, { amount: -5, reason: "餐费", date: "2026-09-28" });
  return db;
}
function tamperedFile(db, mutate) {
  const b = P.exportBundle(db);
  mutate(b.payload.data);
  // 结构改动后重新算校验和（专门绕开“篡改检测”，验证结构校验本身）
  return JSON.stringify({ v: 1, payload: b.payload, checksum: P.checksum(b.payload) });
}

test("【损坏档】完整确认单（含调整单）正常导入复核", () => {
  const imp = P.importBundle(P.exportBundle(goodConfirmedLedger()).file);
  assert.ok(imp.report.ok, JSON.stringify(imp.report.sheets, null, 2));
  assert.strictEqual(imp.report.sheets[0].net, 80); // 冻结 85 - 调整 5
});

test("【损坏档】已确认但没有冻结快照 → 导入前拒绝，审计也判坏", () => {
  const db = goodConfirmedLedger();
  delete db.sheets[0].frozen;
  // 直接审计（本地存储损坏路径）
  const audit = P.auditData(db);
  assert.ok(!audit.ok && /冻结快照/.test(audit.sheets[0].errors.join()));
  // 导入路径（重算校验和以隔离结构校验）
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => delete d.sheets[0].frozen)), "结构损坏");
});

test("【损坏档】冻结结果缺金额明细/合计/类型错误 → 拒绝", () => {
  const cases = [
    d => { d.sheets[0].frozen.result.lines = []; },
    d => { d.sheets[0].frozen.result.lines = null; },
    d => { delete d.sheets[0].frozen.result.totals; },
    d => { d.sheets[0].frozen.result.totals.net = "70.00"; },       // 类型错误（字符串）
    d => { d.sheets[0].frozen.result.totals.net = NaN; },
    d => { d.sheets[0].frozen.result.lines[0].gross = "abc"; },
    d => { d.sheets[0].frozen.rates = null; },                       // 冻结规则缺失
    d => { d.sheets[0].frozen.shifts = []; },                        // 实际命中早班却无班次记录
  ];
  cases.forEach((mutate, i) => {
    expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), mutate)), "结构损坏");
  });
});

test("【损坏档】冻结金额算不平（明细/合计/实发）→ 拒绝", () => {
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => {
    d.sheets[0].frozen.result.totals.net = 999; // 与 gross-advance-deduction 不平
  })), "算不平");
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => {
    d.sheets[0].frozen.result.lines[0].gross += 50; // 明细分项和 ≠ 小计
  })), "算不平");
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => {
    d.sheets[0].frozen.result.totals.gross += 50; // 应发 ≠ 四分项
  })), "算不平");
  // auditData 对本地同样判坏
  const db = goodConfirmedLedger();
  db.sheets[0].frozen.result.totals.net = 1;
  assert.ok(!P.auditData(db).ok);
});

test("【损坏档】冻结预支/扣款与单据不一致 → 拒绝", () => {
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => {
    d.sheets[0].advance = 50; // 单据预支改了，冻结合计还是旧值
  })), "不一致");
});

test("【损坏档】单据本体结构错误 → 拒绝", () => {
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => { d.sheets[0].weaverId = ""; })), "缺少织工");
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => { d.sheets[0].status = "weird"; })), "状态非法");
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => { d.sheets[0].entries[0].qty = -3; })), "完成量非法");
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => { d.sheets[0].periodEnd = "bad-date"; })), "日期非法");
});

test("【损坏档】孤儿调整单 / 调整单字段错误 → 拒绝", () => {
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => { d.adjustments[0].sheetId = "nope"; })), "不存在的工资单");
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => { d.adjustments[0].amount = 0; })), "金额非法");
  expectThrow(() => P.importBundle(tamperedFile(goodConfirmedLedger(), d => { d.adjustments[0].reason = "  "; })), "缺少原因");
});

test("【损坏档】草稿结构宽松：无冻结也能导入，按严格规则审计", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  P.addEntry(db, sh.id, { processKey: "weaving", date: "2026-09-14", start: "09:00", end: "11:00", qty: 10 });
  // 草稿无 frozen，结构校验应通过（草稿不要求冻结快照）
  assert.deepStrictEqual(P.validateLedger(db).filter(e => /冻结/.test(e)), []);
  const imp = P.importBundle(P.exportBundle(db).file);
  assert.strictEqual(imp.data.sheets[0].status, "draft");
});

test("【损坏档】校验和失败仍优先报篡改（结构校验不掩盖完整性校验）", () => {
  const file = P.exportBundle(goodConfirmedLedger()).file.replace('"net": 85', '"net": 850');
  expectThrow(() => P.importBundle(file), "校验和");
});

/* ---------- 明细篡改回归：总额不变也必须逐项一致 ---------- */

// 跨班次确认单：21:00-23:00（中班1h+夜班1h）+ 一段加班，便于验证分段/加班逐项核对
function segmentedConfirmedLedger() {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  P.addEntry(db, sh.id, {
    processKey: "weaving", date: "2026-09-14", start: "21:00", end: "23:00", qty: 100,
    overtimes: [{ date: "2026-09-15", start: "01:00", end: "03:00" }]
  });
  const res = P.confirmSheet(db, sh.id);
  return { db: db, sh: sh, res: res };
}

test("【明细篡改】正常跨班次确认单复核逐分一致", () => {
  const { db, res } = segmentedConfirmedLedger();
  const audit = P.auditData(db);
  assert.ok(audit.ok, JSON.stringify(audit.sheets, null, 2));
  assert.strictEqual(res.lines[0].segments.length, 2); // 中班 + 夜班
  assert.strictEqual(res.lines[0].overtimes.length, 1);
  // 正常导出导入
  const imp = P.importBundle(P.exportBundle(db).file);
  assert.ok(imp.report.ok);
});

test("【明细篡改】改分段班次名称（总额不变）→ 复核/导入拒绝", () => {
  const { db } = segmentedConfirmedLedger();
  const line = () => db.sheets[0].frozen.result.lines[0];
  const orig = line().segments[0].shift;
  line().segments[0].shift = "伪造班次";
  // 合计完全没动
  assert.strictEqual(P.auditData(db).ok, false);
  expectThrow(() => P.importBundle(tamperedFile(db, d => {
    d.sheets[0].frozen.result.lines[0].segments[0].shift = "伪造班次";
  })), "复核不通过");
  assert.ok(/班次/.test(P.auditData(db).sheets[0].errors.join()));
  line().segments[0].shift = orig;
  assert.ok(P.auditData(db).ok);
});

test("【明细篡改】改分段分钟数/金额并找平总额 → 拒绝", () => {
  // 分钟数：两段各 60 分钟，改成 30/90
  expectThrow(() => P.importBundle(tamperedFile(segmentedConfirmedLedger().db, d => {
    d.sheets[0].frozen.result.lines[0].segments[0].minutes = 30;
    d.sheets[0].frozen.result.lines[0].segments[1].minutes = 90;
  })), "minutes");
  // 段金额：把第一段金额挪给第二段（总额不变）
  expectThrow(() => P.importBundle(tamperedFile(segmentedConfirmedLedger().db, d => {
    const segs = d.sheets[0].frozen.result.lines[0].segments;
    segs[0].amount = P.r2(segs[0].amount - 10);
    segs[1].amount = P.r2(segs[1].amount + 10);
  })), "amount");
  // 分段日期伪造
  expectThrow(() => P.importBundle(tamperedFile(segmentedConfirmedLedger().db, d => {
    d.sheets[0].frozen.result.lines[0].segments[1].date = "2026-09-20";
  })), "date");
});

test("【明细篡改】插入伪造加班记录但保持加班总额 → 拒绝", () => {
  const { db } = segmentedConfirmedLedger();
  // 把原加班 2h 拆成两条 1h（总额同为 100），段数不一致必须暴露
  const file = tamperedFile(db, d => {
    const line = d.sheets[0].frozen.result.lines[0];
    line.overtimes = [
      { date: "2026-09-15", start: "01:00", end: "02:00", minutes: 60, holiday: false, multiplier: 2, amount: 50 },
      { date: "2026-09-15", start: "02:00", end: "03:00", minutes: 60, holiday: false, multiplier: 2, amount: 50 }
    ];
  });
  expectThrow(() => P.importBundle(file), "加班段数不一致");

  // 同段数但改加班日期/金额找平 → 逐项比对拒绝
  expectThrow(() => P.importBundle(tamperedFile(segmentedConfirmedLedger().db, d => {
    d.sheets[0].frozen.result.lines[0].overtimes[0].date = "2026-09-20";
  })), "加班#1 的 date");
});

test("【明细篡改】行间挪账：每行内部找平、整单总额不变 → 拒绝", () => {
  const db = P.defaultData();
  db.plan = P.generatePlan({ cols: 10, rows: 10, cells: Array(100).fill(0) });
  const sh = P.addSheet(db, { weaverId: "w1", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
  P.addEntry(db, sh.id, { processKey: "weaving", date: "2026-09-14", start: "09:00", end: "11:00", qty: 10 });
  P.addEntry(db, sh.id, { processKey: "weaving", date: "2026-09-15", start: "09:00", end: "11:00", qty: 20 });
  P.confirmSheet(db, sh.id);
  const file = tamperedFile(db, d => {
    const lines = d.sheets[0].frozen.result.lines;
    // 每行分项与小计一起挪 8 元：行内仍平、整单总额仍平，但行间分配是伪造的
    lines[0].piecePay = P.r2(lines[0].piecePay + 8);
    lines[0].gross = P.r2(lines[0].gross + 8);
    lines[1].piecePay = P.r2(lines[1].piecePay - 8);
    lines[1].gross = P.r2(lines[1].gross - 8);
  });
  expectThrow(() => P.importBundle(file), "piecePay");
});

test("【明细篡改】篡改单据录入但冻结金额不变 → 拒绝", () => {
  // entries 日期被改，重算结果日期与冻结行不符
  expectThrow(() => P.importBundle(tamperedFile(segmentedConfirmedLedger().db, d => {
    d.sheets[0].entries[0].date = "2026-09-20";
  })), "日期不一致");
  // entries 数量被改，重算金额自然不等
  expectThrow(() => P.importBundle(tamperedFile(segmentedConfirmedLedger().db, d => {
    d.sheets[0].entries[0].qty = 50;
  })), "qty");
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
