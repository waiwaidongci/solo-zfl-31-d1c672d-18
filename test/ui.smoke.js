/* jsdom UI 冒烟测试：node test/ui.smoke.js */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}
function loadWindow(storage) {
  let html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  // 外部脚本改为手动注入，保证 payroll 先于 settlement 执行
  html = html.replace('<script src="payroll.js"></script>', "")
             .replace('<script src="settlement.js"></script>', "");
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.confirm = () => true;
  if (storage) Object.keys(storage).forEach(k => window.localStorage.setItem(k, storage[k]));
  window.eval(fs.readFileSync(path.join(__dirname, "..", "payroll.js"), "utf8"));
  window.eval(fs.readFileSync(path.join(__dirname, "..", "settlement.js"), "utf8"));
  return dom;
}
function click(window, el) { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }
function byAct(root, act) { return root.querySelector('[data-act="' + act + '"]'); }
function clickAct(window, root, act) {
  const el = byAct(root, act);
  if (!el) throw new Error("找不到 data-act=" + act);
  click(window, el);
  return el;
}
function setVal(el, v) {
  el.value = v;
  const W = el.ownerDocument.defaultView;
  el.dispatchEvent(new W.Event("input", { bubbles: true }));
  el.dispatchEvent(new W.Event("change", { bubbles: true }));
}
function msg(dom) { return dom.window.document.querySelector("#sMsg").textContent; }
function dumpStorage(dom) {
  const s = {};
  for (let i = 0; i < dom.window.localStorage.length; i++) {
    const k = dom.window.localStorage.key(i); s[k] = dom.window.localStorage.getItem(k);
  }
  return s;
}

/* ---------- 场景 ---------- */
let dom = loadWindow();
let win = dom.window, doc = win.document;

// 1. 排版台功能仍在
ok(doc.querySelectorAll(".cell").length === 18 * 14, "排版台网格仍正常绘制（252 格）");
doc.querySelector("#undoBtn").dispatchEvent(new win.MouseEvent("click", { bubbles: true })); // 不报错即可

// 2. 切到结算台 → 工序计划，按当前纹样生成
click(win, doc.querySelector("#tabSettle"));
ok(!doc.querySelector("#settleView").classList.contains("s-hidden"), "切换到结算台");
clickAct(win, doc.querySelector("#settleRoot"), "tab"); // sheets 默认
const sub = doc.querySelector("#settleRoot");
[...sub.querySelectorAll("[data-act=tab]")].find(b => b.dataset.tab === "plan").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
clickAct(win, doc.querySelector("#settleRoot"), "genPlan");
ok(/✓/.test(msg(dom)), "按当前纹样生成工序计划：" + msg(dom));
const stored = JSON.parse(win.localStorage.getItem("zfl31Settlement"));
ok(stored.plan && stored.plan.items.length === 4, "计划含 4 道工序并已持久化");

// 3. 建草稿单（默认织工 w1、本月周期）
[...doc.querySelectorAll("[data-act=tab]")].find(b => b.dataset.tab === "sheets").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
clickAct(win, doc.querySelector("#settleRoot"), "addSheet");
ok(/新建工资单成功/.test(msg(dom)), "建立草稿单");
const shId = JSON.parse(win.localStorage.getItem("zfl31Settlement")).sheets[0].id;
ok(doc.querySelector('[data-act="edit"][data-id="' + shId + '"]'), "列表出现新单 " + shId);

// 4. 打开编辑器，录入跨班次完成量 13:00-15:00，100 件（上机织造，计划 252）
clickAct(win, doc.querySelector("#settleRoot"), "edit");
setVal(doc.querySelector('[data-box="entry"] [name=processKey]'), "weaving");
setVal(doc.querySelector('[data-box="entry"] [name=qty]'), "100");
setVal(doc.querySelector('[data-box="entry"] [name=start]'), "13:00");
setVal(doc.querySelector('[data-box="entry"] [name=end]'), "15:00");
clickAct(win, doc.querySelector("#settleRoot"), "addEntry");
ok(/加入明细成功/.test(msg(dom)), "录入完成量 100（早班1h+中班1h）");
ok(/早班/.test(doc.querySelector("#editorBody").innerHTML) && /中班/.test(doc.querySelector("#editorBody").innerHTML), "跨班次分段显示");
// 计件 100*0.8=80；津贴 5*0.5+8*0.5=6.5；实发 86.5
ok(doc.querySelector("#editorBody").innerHTML.includes("86.50"), "试算实发 86.50 元");

// 5. 拦截：负数不入表
setVal(doc.querySelector('[data-box="entry"] [name=processKey]'), "weaving");
setVal(doc.querySelector('[data-box="entry"] [name=qty]'), "-5");
clickAct(win, doc.querySelector("#settleRoot"), "addEntry");
ok(/负/.test(msg(dom)) && JSON.parse(win.localStorage.getItem("zfl31Settlement")).sheets[0].entries.length === 1,
  "负数完成量被拦截，且未留下明细");
setVal(doc.querySelector('[data-box="entry"] [name=qty]'), "0");

// 6. 预支超发拦截（预支 5000）
setVal(doc.querySelector('[data-box="head"] [name=advance]'), "5000");
clickAct(win, doc.querySelector("#settleRoot"), "saveHead");
clickAct(win, doc.querySelector("#settleRoot"), "confirm");
ok(/应发净额为负/.test(msg(dom)), "预支超发在确认时被拦截");
ok(JSON.parse(win.localStorage.getItem("zfl31Settlement")).sheets[0].status === "draft", "确认失败仍是草稿，无半张单");

// 7. 改回合理预支 10，确认
setVal(doc.querySelector('[data-box="head"] [name=advance]'), "10");
clickAct(win, doc.querySelector("#settleRoot"), "saveHead");
clickAct(win, doc.querySelector("#settleRoot"), "confirm");
ok(/已确认并冻结/.test(msg(dom)), "工资单确认锁定（实发 76.50）");
ok(doc.querySelector("#settleRoot").innerHTML.includes("🔒"), "显示锁定说明");
ok(doc.querySelector('[data-box="head"] [name=weaverId]').disabled, "确认后织工字段锁定");

// 8. 确认后不能改表头/加明细，只能开调整单
setVal(doc.querySelector('[data-box="adj"] [name=amount]'), "-6.5");
clickAct(win, doc.querySelector("#settleRoot"), "addAdjustment"); // 原因空
ok(/原因必填/.test(msg(dom)), "无原因调整单被拦截");
setVal(doc.querySelector('[data-box="adj"] [name=reason]'), "餐费扣款");
clickAct(win, doc.querySelector("#settleRoot"), "addAdjustment");
ok(/调整单已开立/.test(msg(dom)), "调整单 -6.50 开立");
ok(doc.querySelector("#editorBody").innerHTML.includes("70.00"), "含调整单实发 70.00 元");
setVal(doc.querySelector('[data-box="adj"] [name=amount]'), "-99999");
setVal(doc.querySelector('[data-box="adj"] [name=reason]'), "恶意扣");
clickAct(win, doc.querySelector("#settleRoot"), "addAdjustment");
ok(/不能为负/.test(msg(dom)), "调整后为负被拦截");

// 9. 刷新后数据保留
const storage1 = dumpStorage(dom);
dom.window.close();
dom = loadWindow(storage1);
win = dom.window; doc = win.document;
click(win, doc.querySelector("#tabSettle"));
const refreshed = JSON.parse(win.localStorage.getItem("zfl31Settlement"));
ok(refreshed.sheets[0].status === "confirmed" && refreshed.adjustments.length === 1, "刷新后工资单与调整单保留");
ok(refreshed.sheets[0].frozen.result.totals.net === 76.5, "刷新后冻结实发仍为 76.50");
clickAct(win, doc.querySelector("#settleRoot"), "edit");
ok(doc.querySelector("#editorBody").innerHTML.includes("70.00"), "刷新后含调整单实发仍 70.00");
clickAct(win, doc.querySelector("#settleRoot"), "back");

// 10. 复核台账
clickAct(win, doc.querySelector("#settleRoot"), "audit");
ok(/完全一致/.test(msg(dom)), "复核：冻结结果与重算一致");

// 10b. 【回归】确认后的单不冻结未引用规则：未使用的单价可改，重叠班次被拦截
[...doc.querySelectorAll("[data-act=tab]")].find(b => b.dataset.tab === "rules").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
// 给未使用的“整理整修”改 2026-01-01 历史价（0.5 → 0.6），应成功
{
  const card = [...doc.querySelectorAll("[data-box=rate]")].find(b => b.querySelector("[data-key=finishing]"));
  setVal(card.querySelector("[name=from]"), "2026-01-01");
  setVal(card.querySelector("[name=price]"), "0.6");
  card.querySelector("[data-act=setRate]").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  ok(/单价成功/.test(msg(dom)), "确认后仍可修改未被引用的历史单价");
  //  weaving 同日历史价（已被确认单引用）改价应被锁定拦截
  const wcard = [...doc.querySelectorAll("[data-box=rate]")].find(b => b.querySelector("[data-key=weaving]"));
  setVal(wcard.querySelector("[name=from]"), "2026-01-01");
  setVal(wcard.querySelector("[name=price]"), "5");
  wcard.querySelector("[data-act=setRate]").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  ok(/锁定/.test(msg(dom)), "已被确认单引用的单价不能改");
  // 但新增更晚生效价是允许的，且不影响已确认单
  setVal(wcard.querySelector("[name=from]"), "2026-12-01");
  setVal(wcard.querySelector("[name=price]"), "5");
  wcard.querySelector("[data-act=setRate]").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  ok(/单价成功/.test(msg(dom)), "新增更晚生效价允许（不影响锁定单）");
}
// 保存一个与早班重叠的新班次 → 拦截
{
  const box = doc.querySelector('[data-box="shift"]');
  setVal(box.querySelector("[name=name]"), "插班");
  setVal(box.querySelector("[name=start]"), "13:00");
  setVal(box.querySelector("[name=end]"), "15:00");
  setVal(box.querySelector("[name=allowance]"), "0");
  clickAct(win, doc.querySelector("#settleRoot"), "setShift");
  ok(/重叠/.test(msg(dom)), "重叠班次保存被拦截");
  const live = JSON.parse(win.localStorage.getItem("zfl31Settlement"));
  ok(!live.shifts.some(s => s.name === "插班"), "被拦截的重叠班次未入库");
}

// 10c. 【回归】新建草稿：周期外加班（生产在本月、加班在下月）不能确认
[...doc.querySelectorAll("[data-act=tab]")].find(b => b.dataset.tab === "sheets").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
clickAct(win, doc.querySelector("#settleRoot"), "addSheet");
const sh2Id = JSON.parse(win.localStorage.getItem("zfl31Settlement")).sheets.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-1)[0].id;
[...doc.querySelectorAll('[data-act="edit"]')].find(b => b.dataset.id === sh2Id).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
// 显式设为 9 月周期，避免依赖运行机当天日期
setVal(doc.querySelector('[data-box="head"] [name=periodStart]'), "2026-09-01");
setVal(doc.querySelector('[data-box="head"] [name=periodEnd]'), "2026-09-30");
clickAct(win, doc.querySelector("#settleRoot"), "saveHead");
setVal(doc.querySelector('[data-box="entry"] [name=processKey]'), "weaving");
setVal(doc.querySelector('[data-box="entry"] [name=date]'), "2026-09-15");
setVal(doc.querySelector('[data-box="entry"] [name=qty]'), "10");
setVal(doc.querySelector('[data-box="entry"] [name=start]'), "09:00");
setVal(doc.querySelector('[data-box="entry"] [name=end]'), "11:00");
setVal(doc.querySelector('[data-box="entry"] [name=ot1date]'), "2026-10-01"); // 周期（9月）外
setVal(doc.querySelector('[data-box="entry"] [name=ot1start]'), "09:00");
setVal(doc.querySelector('[data-box="entry"] [name=ot1end]'), "10:00");
clickAct(win, doc.querySelector("#settleRoot"), "addEntry");
ok(/不在结算周期/.test(msg(dom)), "周期外加班明细被拦截（生产日期在周期内也不行）");
ok(JSON.parse(win.localStorage.getItem("zfl31Settlement")).sheets.find(s=>s.id===sh2Id).entries.length === 0, "非法加班明细未入表");

// 零时长：起止时刻相同 → 拒绝（不能当 24 小时）
setVal(doc.querySelector('[data-box="entry"] [name=ot1date]'), "");
setVal(doc.querySelector('[data-box="entry"] [name=ot1start]'), "");
setVal(doc.querySelector('[data-box="entry"] [name=ot1end]'), "");
setVal(doc.querySelector('[data-box="entry"] [name=start]'), "20:00");
setVal(doc.querySelector('[data-box="entry"] [name=end]'), "20:00");
clickAct(win, doc.querySelector("#settleRoot"), "addEntry");
ok(/零时长/.test(msg(dom)), "生产起止相同时刻被拒绝（不按 24 小时计）");
// 末日 22:00→次日06:00 跨入 10 月 → 拒绝
setVal(doc.querySelector('[data-box="entry"] [name=date]'), "2026-09-30");
setVal(doc.querySelector('[data-box="entry"] [name=start]'), "22:00");
setVal(doc.querySelector('[data-box="entry"] [name=end]'), "06:00");
clickAct(win, doc.querySelector("#settleRoot"), "addEntry");
ok(/拆成两笔/.test(msg(dom)), "末日深夜跨入次月被拒绝并提示拆单");
// 末日做到 24:00 整合法
setVal(doc.querySelector('[data-box="entry"] [name=start]'), "22:00");
setVal(doc.querySelector('[data-box="entry"] [name=end]'), "00:00");
clickAct(win, doc.querySelector("#settleRoot"), "addEntry");
ok(/加入明细成功/.test(msg(dom)), "末日 22:00–24:00 贴边界合法计入");
clickAct(win, doc.querySelector("#settleRoot"), "back");
// 删除这张空草稿，避免污染后续导出复核
doc.querySelector('[data-act="deleteSheet"][data-id="' + sh2Id + '"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
ok(JSON.parse(win.localStorage.getItem("zfl31Settlement")).sheets.length === 1, "空草稿已删除");

// 11. 导出 → 全新环境导入，复核同一结果
let exported = "";
{
  const realClick = win.HTMLElement.prototype.click;
  win.HTMLElement.prototype.click = function () {
    if (this.tagName === "A" && this.href && this.href.startsWith("blob:")) return; // jsdom 不支持下载
    return realClick.call(this);
  };
  clickAct(win, doc.querySelector("#settleRoot"), "export");
}
exported = win.Payroll.exportBundle(JSON.parse(win.localStorage.getItem("zfl31Settlement"))).file;
ok(/"checksum"\s*:/.test(exported), "导出台账含校验和");

const dom2 = loadWindow();
const imp = dom2.window.Payroll.importBundle(exported);
ok(imp.report.ok, "导入全新环境并复核通过：" + JSON.stringify(imp.report.sheets.map(s => s.errors)));
ok(imp.report.sheets[0].net === 70, "导入后含调整单实发仍为 70.00");
// 落库后界面复核
{
  const file = new dom2.window.File([exported], "ledger.json", { type: "application/json" });
  // 先进入结算台以渲染容器，再取文件输入框
  dom2.window.document.querySelector("#tabSettle").dispatchEvent(new dom2.window.MouseEvent("click", { bubbles: true }));
  const input = dom2.window.document.querySelector("#importFile");
  ok(!!input, "导入文件框已渲染");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new dom2.window.Event("change", { bubbles: true }));
  setTimeout(() => {
    ok(/逐分一致/.test(dom2.window.document.querySelector("#sMsg").textContent), "界面导入提示逐分一致");
    runOldLedgerMigration();
  }, 200);
}

// 真实旧档迁移：升级前确认的“跨月加班单”，旧版全量冻结格式，升级后复核/导入不得判坏
function runOldLedgerMigration() {
  const P1 = win.Payroll;
  const oldDb = P1.defaultData();
  oldDb.plan = P1.generatePlan({ cols: 10, rows: 10, cells: new Array(100).fill(0) });
  const sh = P1.addSheet(oldDb, { weaverId: "w1", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  sh.entries = [{
    processKey: "weaving", date: "2026-08-31", start: "20:00", end: "22:00",
    pieces: 1, qty: 20, reworkQty: 0,
    overtimes: [{ date: "2026-08-31", start: "23:00", end: "01:00" }]
  }];
  // 旧版确认：legacy 语义重算 + 全量冻结快照
  const frozen = P1.calcSheet(oldDb, sh, { strict: false });
  sh.status = "confirmed";
  sh.confirmedAt = "2026-08-31T10:00:00.000Z";
  sh.frozen = {
    result: frozen,
    rates: oldDb.rates.map(P1.clone), shifts: oldDb.shifts.map(P1.clone),
    holidays: oldDb.holidays.slice(), holidayMultiplier: oldDb.holidayMultiplier,
    overtimeRate: oldDb.overtimeRate, plan: P1.clone(oldDb.plan)
  };
  const oldFile = P1.exportBundle(oldDb).file;

  // 场景 A：模拟升级后首次刷新（旧档已在 localStorage），点“复核台账”
  const domA = loadWindow({ zfl31Settlement: JSON.stringify(oldDb) });
  const wA = domA.window, dA = wA.document;
  dA.querySelector("#tabSettle").dispatchEvent(new wA.MouseEvent("click", { bubbles: true }));
  byAct(dA.querySelector("#settleRoot"), "audit").dispatchEvent(new wA.MouseEvent("click", { bubbles: true }));
  ok(/完全一致/.test(dA.querySelector("#sMsg").textContent), "【旧档】升级后复核旧跨月加班单：完全一致，不判越界");

  // 场景 B：升级后通过文件导入旧版导出的台账
  const domB = loadWindow();
  const wB = domB.window, dB = wB.document;
  dB.querySelector("#tabSettle").dispatchEvent(new wB.MouseEvent("click", { bubbles: true }));
  const f = new wB.File([oldFile], "old-ledger.json", { type: "application/json" });
  const inp = dB.querySelector("#importFile");
  Object.defineProperty(inp, "files", { value: [f], configurable: true });
  inp.dispatchEvent(new wB.Event("change", { bubbles: true }));
  setTimeout(() => {
    const msgText = dB.querySelector("#sMsg").textContent;
    ok(/逐分一致/.test(msgText), "【旧档】导入旧版跨月加班台账：复核逐分一致");
    const stored = JSON.parse(wB.localStorage.getItem("zfl31Settlement"));
    const importedSheet = stored.sheets[0];
    ok(importedSheet.status === "confirmed" && Math.abs(importedSheet.frozen.result.totals.overtimePay - 100) < 1e-9,
      "【旧档】旧单冻结加班工资 100.00 保留");
    ok(wB.Payroll.auditData(stored).ok, "【旧档】落库后再次复核仍通过");
    finish();
  }, 200);
}

function finish() {
  console.log(failures ? "\n存在 " + failures + " 个失败" : "\nUI 冒烟全部通过");
  process.exitCode = failures ? 1 : 0;
}
