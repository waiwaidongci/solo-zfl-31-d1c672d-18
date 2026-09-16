/* 织造计件结算台 UI（依赖 payroll.js 与排版台暴露的 window.getPatternData） */
(function () {
  "use strict";
  const P = window.Payroll;
  const STORE = "zfl31Settlement";
  const root = document.querySelector("#settleRoot");
  const msgBox = document.querySelector("#sMsg");

  let db = load();
  let tab = "sheets";        // sheets | rules | plan
  let editingId = null;      // 正在编辑的工资单
  let lastAudit = null;      // 最近一次复核结果

  /* ---------- 持久化（原子写：序列化成功后一次性覆盖） ---------- */
  function load() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { stored = null; }
    const base = P.defaultData();
    if (!stored) return base;
    // 以默认结构兜底，避免旧档缺字段
    ["weavers", "processes", "rates", "shifts", "holidays", "sheets", "adjustments"].forEach(k => {
      if (Array.isArray(stored[k])) base[k] = stored[k];
    });
    if (stored.plan) base.plan = stored.plan;
    if (typeof stored.holidayMultiplier === "number") base.holidayMultiplier = stored.holidayMultiplier;
    if (typeof stored.overtimeRate === "number") base.overtimeRate = stored.overtimeRate;
    return base;
  }
  function persist() {
    const text = JSON.stringify(db);
    JSON.parse(text); // 确保可序列化再覆盖，避免写坏台账
    localStorage.setItem(STORE, text);
  }
  // 所有写操作统一入口：失败回滚本次修改、提示错误，不产生半截数据；
  // 失败时不重渲染，保留用户已填表单（db 已整体回滚到操作前快照）。
  function action(desc, fn) {
    const snapshot = P.clone(db);
    try {
      const r = fn();
      persist();
      flash(okText(desc), true);
      render();
      return r;
    } catch (e) {
      db = snapshot; // 回滚
      try { persist(); } catch (e2) { /* 回滚快照理论上必可序列化 */ }
      flash(e.message, false);
      return null;
    }
  }
  function okText(d) { return typeof d === "string" ? d + "成功" : d.ok; }
  function flash(text, ok) {
    msgBox.textContent = (ok ? "✓ " : "✗ ") + text;
    msgBox.className = ok ? "ok" : "err";
  }

  /* ---------- 小工具 ---------- */
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = n => (Number(n) || 0).toFixed(2);
  const vals = box => {
    const o = {};
    (box || document).querySelectorAll("[name]").forEach(el => { o[el.name] = el.value; });
    return o;
  };
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  const weaverName = id => { const w = db.weavers.find(x => x.id === id); return w ? w.name : "（缺失织工）"; };
  const procName = key => { const m = P.meta(key); return m ? m.name : key; };
  const priceToday = key => { const r = P.rateAt(db, key, P.todayStr()); return r ? r.price : null; };

  /* ---------- 总渲染 ---------- */
  function render() {
    if (editingId) { renderEditor(); return; }
    root.innerHTML =
      '<div class="s-subtabs">' +
        subBtn("sheets", "工资单") + subBtn("plan", "工序计划") + subBtn("rules", "计价规则") +
        '<span class="spacer"></span>' +
        '<button class="tiny ghost" data-act="audit">复核台账</button>' +
        '<button class="tiny ghost" data-act="export">导出台账</button>' +
        '<button class="tiny ghost" data-act="clickImport">导入台账</button>' +
        '<input type="file" id="importFile" accept="application/json,.json" class="s-hidden">' +
      '</div>' +
      '<div id="tabBody"></div>' +
      (lastAudit ? auditPanelHtml() : "");
    document.querySelector("#tabBody").innerHTML =
      tab === "sheets" ? sheetsHtml() : tab === "plan" ? planHtml() : rulesHtml();
    bind();
  }
  function subBtn(key, label) {
    return '<button class="' + (tab === key ? "active" : "") + '" data-act="tab" data-tab="' + key + '">' + label + "</button>";
  }

  /* ---------- 工资单列表 ---------- */
  function sheetsHtml() {
    const today = P.todayStr();
    const monthStart = today.slice(0, 8) + "01";
    const opts = db.weavers
      .filter(w => w.active)
      .map(w => '<option value="' + w.id + '">' + esc(w.code ? w.code + " " : "") + esc(w.name) + "</option>").join("");
    const rows = db.sheets.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).map(sh => {
      let net = "—", gross = "—", adv = "—", piece = "—", ot = "—";
      let err = "";
      if (sh.status === "confirmed") {
        const t = sh.frozen.result.totals;
        gross = money(t.gross); adv = money(t.advance); piece = money(t.piecePay); ot = money(t.overtimePay);
        net = money(P.currentNet(db, sh));
      } else if (!sh.entries.length) {
        net = "—";
      } else {
        try {
          const r = P.calcSheet(db, sh);
          gross = money(r.totals.gross); adv = money(r.totals.advance); piece = money(r.totals.piecePay); ot = money(r.totals.overtimePay);
          net = money(r.totals.net);
        } catch (e) { err = esc(e.message); net = '<span class="warning">待修正</span>'; }
      }
      const adjCount = P.sheetAdjustments(db, sh.id).length;
      return "<tr>" +
        '<td><a href="#" data-act="edit" data-id="' + sh.id + '">' + sh.id + "</a></td>" +
        "<td>" + esc(weaverName(sh.weaverId)) + "</td>" +
        "<td>" + esc(sh.title || "（未命名）") + "<br><span class='muted'>" + sh.periodStart + " ~ " + sh.periodEnd + "</span></td>" +
        '<td><span class="badge ' + sh.status + '">' + (sh.status === "draft" ? "草稿" : "已确认") + "</span>" +
          (adjCount ? ' <span class="muted">调整×' + adjCount + "</span>" : "") + "</td>" +
        '<td class="money">' + piece + "</td>" +
        '<td class="money">' + ot + "</td>" +
        '<td class="money">' + gross + "</td>" +
        '<td class="money">' + adv + "</td>" +
        '<td class="money"><b>' + net + "</b></td>" +
        "<td>" + (err ? '<span class="warning" title="' + err + '">⚠</span>' : "") +
          '<button class="tiny" data-act="edit" data-id="' + sh.id + '">打开</button> ' +
          (sh.status === "draft"
            ? '<button class="tiny danger" data-act="deleteSheet" data-id="' + sh.id + '">删除</button>'
            : '<span class="muted">已锁定</span>') + "</td>" +
      "</tr>";
    }).join("");

    return '<div class="s-card"><h3>新建工资单</h3>' +
      '<div class="s-row" data-box="newSheet">' +
        "<label>织工<select name='weaverId'>" + (db.weavers.length ? opts : "<option value=''>（请先在计价规则中维护织工）</option>") + "</select></label>" +
        "<label>标题<input name='title' placeholder='如：9月织造工资' value=''></label>" +
        "<label>周期起<input name='periodStart' type='date' value='" + monthStart + "'></label>" +
        "<label>周期止<input name='periodEnd' type='date' value='" + today + "'></label>" +
        '<p style="grid-column:1/-1;margin:4px 0"><button data-act="addSheet">建草稿单</button> ' +
        '<span class="muted">草稿可反复修改；确认后锁定，只能开调整单。</span></p>' +
      "</div></div>" +
      '<div class="s-card" style="margin-top:14px"><h3>工资单（' + db.sheets.length + "）</h3>" +
      (db.sheets.length ? '<table class="s-table"><thead><tr><th>单号</th><th>织工</th><th>周期</th><th>状态</th><th>计件</th><th>加班</th><th>应发</th><th>预支</th><th>实发</th><th>操作</th></tr></thead><tbody>' + rows + "</tbody></table>"
        : "<p class='muted'>还没有工资单。</p>") +
      "</div>";
  }

  /* ---------- 工序计划 ---------- */
  function patternInfo() {
    try { return window.getPatternData(); } catch (e) { return null; }
  }
  function planHtml() {
    const pat = patternInfo();
    const patSummary = pat && pat.cells && pat.cells.length
      ? pat.cols + " 列 × " + pat.rows + " 行，共 " + (pat.cols * pat.rows) + " 格"
      : "排版台当前没有纹样";
    const plan = db.plan;
    const planRows = plan ? plan.items.map(it => {
      const m = P.meta(it.processKey);
      const price = priceToday(it.processKey);
      return "<tr><td><b>" + esc(m ? m.name : it.processKey) + "</b><br><span class='muted'>" + esc(m ? m.note : "") + "</span></td>" +
        '<td class="money">' + it.qty + "</td>" +
        '<td class="money">' + (price != null ? money(price) : "未定价") + "</td>" +
        '<td class="money">' + (price != null ? money(it.qty * price) : "—") + "</td></tr>";
    }).join("") : "";
    return '<div class="s-card"><h3>当前纹样（排版台）</h3>' +
      "<p>" + esc(patSummary) + "</p>" +
      '<button data-act="genPlan">按当前纹样生成 / 刷新工序计划工量</button> ' +
      '<button class="ghost" data-act="goPattern">去排版台绘制</button>' +
      (plan ? "<p class='muted' style='margin-top:8px'>当前计划生成于 " + esc(plan.generatedAt) +
        "（花纹色格 " + plan.colorCells + "、用色经列 " + plan.colorColumns + "、纹格 " + plan.gridCells + "）</p>" : "") +
      '<p class="locked-note">重新生成只影响草稿单的校验；已确认工资单冻结了当时的计划工量，不会被追溯改变。</p>' +
      "</div>" +
      (plan ? '<div class="s-card" style="margin-top:14px"><h3>工序计划工量（今日单价估算）</h3>' +
        '<table class="s-table"><thead><tr><th>工序</th><th>计划工量</th><th>今日单价(元)</th><th>估算金额(元)</th></tr></thead><tbody>' +
        planRows + "</tbody></table></div>"
        : '<div class="s-card" style="margin-top:14px"><p class="muted">尚未生成计划。</p></div>');
  }

  /* ---------- 计价规则（织工/单价/班次/节假日） ---------- */
  function rulesHtml() {
    // 织工
    const wRows = db.weavers.map(w => "<tr><td>" + esc(w.code || "—") + "</td><td>" + esc(w.name) + "</td>" +
      '<td><span class="badge ' + (w.active ? "confirmed" : "draft") + '">' + (w.active ? "在岗" : "停用") + "</span></td>" +
      '<td><button class="tiny ghost" data-act="toggleWeaver" data-id="' + w.id + '">' + (w.active ? "停用" : "启用") + "</button></td></tr>").join("");
    // 单价：按工序分组
    const rateCards = db.processes.map(pc => {
      const m = P.meta(pc.key);
      const rows = db.rates.filter(r => r.processKey === pc.key)
        .sort((a, b) => a.from.localeCompare(b.from))
        .map(r => {
          const frozen = P.rateIsFrozen(db, r.id);
          return "<tr><td>" + r.from + "</td><td class='money'>" + money(r.price) + "</td>" +
            "<td>" + (frozen ? '<span class="badge confirmed">已锁定</span>' : '<span class="muted">可改</span>') + "</td></tr>";
        }).join("");
      const today = priceToday(pc.key);
      return '<div class="s-card"><h3>' + esc(pc.name) + ' <span class="muted">' + esc(m ? m.note : "") + "</span></h3>" +
        "<p class='muted'>今日生效单价：" + (today != null ? money(today) + " 元" : "未配置") + "</p>" +
        '<table class="s-table"><thead><tr><th>生效日期</th><th>单价(元)</th><th>状态</th></tr></thead><tbody>' + rows + "</tbody></table>" +
        '<div class="s-row" data-box="rate" style="margin-top:8px">' +
          "<label>生效日期<input type='date' name='from' value='" + P.todayStr() + "'></label>" +
          "<label>单价(元)<input type='number' step='0.01' min='0.01' name='price'></label>" +
          '<p style="grid-column:1/-1;margin:4px 0"><button class="tiny" data-act="setRate" data-key="' + pc.key + '">保存/新增单价</button></p>' +
        "</div></div>";
    }).join("");
    // 班次
    const shRows = db.shifts.map(s => {
      const frozen = P.shiftIsFrozen(db, s.id);
      return "<tr><td>" + esc(s.name) + "</td><td>" + s.start + "–" + s.end + "</td>" +
        '<td class="money">' + money(s.allowance) + "</td><td>" +
        (frozen ? '<span class="badge confirmed">已锁定</span>'
          : '<button class="tiny ghost" data-act="editShift" data-id="' + s.id + '">编辑</button>') + "</td></tr>";
    }).join("");
    const holRows = db.holidays.map(d => "<tr><td>" + d + "</td>" +
      "<td>" + (P.holidayIsFrozen && P.holidayIsFrozen(db, d)
        ? '<span class="badge confirmed">已锁定</span>'
        : '<button class="tiny danger" data-act="delHoliday" data-date="' + d + '">取消节假日</button>') + "</td></tr>").join("");

    return '<div class="s-grid">' +
      '<div class="s-card"><h3>织工</h3>' +
      '<table class="s-table"><thead><tr><th>工号</th><th>姓名</th><th>状态</th><th></th></tr></thead><tbody>' + wRows + "</tbody></table>" +
      '<div class="s-row" style="margin-top:8px" data-box="weaver">' +
        "<label>工号<input name='code' placeholder='ZG-003'></label>" +
        "<label>姓名<input name='name'></label>" +
        '<p style="grid-column:1/-1;margin:4px 0"><button class="tiny" data-act="addWeaver">新增织工</button></p>' +
      "</div></div>" +

      '<div class="s-card"><h3>班次</h3>' +
      '<table class="s-table"><thead><tr><th>班次</th><th>时间</th><th>津贴(元/班)</th><th></th></tr></thead><tbody>' + shRows + "</tbody></table>" +
      '<div class="s-row" style="margin-top:8px" data-box="shift">' +
        "<input type='hidden' name='id'><label>名称<input name='name' placeholder='早班'></label>" +
        "<label>上班<input type='time' name='start'></label><label>下班<input type='time' name='end'></label>" +
        "<label>津贴<input type='number' step='0.01' min='0' name='allowance' value='0'></label>" +
        '<p style="grid-column:1/-1;margin:4px 0"><button class="tiny" data-act="setShift">保存班次</button></p>' +
      "</div><p class='muted'>跨班次/跨夜按实际覆盖时长自动分段；工作时间跨越的班次按占比计津贴。</p></div>" +

      '<div class="s-card"><h3>节假日与加班参数</h3>' +
      '<table class="s-table"><thead><tr><th>日期</th><th></th></tr></thead><tbody>' + holRows + "</tbody></table>" +
      '<div class="s-row" style="margin-top:8px" data-box="holiday">' +
        "<label>节假日日期<input type='date' name='date' value='" + P.todayStr() + "'></label>" +
        '<p style="grid-column:1/-1;margin:4px 0"><button class="tiny" data-act="addHoliday">标记为节假日</button></p>' +
      "</div><hr style='border:0;border-top:1px solid #e1d5c5;margin:12px 0'>" +
      '<div class="s-row" data-box="params">' +
        "<label>节假日计件倍数<input type='number' step='0.1' min='1' name='holidayMultiplier' value='" + db.holidayMultiplier + "'></label>" +
        "<label>加班时基(元/小时)<input type='number' step='0.5' min='0' name='overtimeRate' value='" + db.overtimeRate + "'></label>" +
        '<p style="grid-column:1/-1;margin:4px 0"><button class="tiny" data-act="saveParams">保存参数</button> ' +
        "<span class='muted'>日常加班 2 倍、节假日加班 3 倍时基。</span></p>" +
      "</div>" +
      '<p class="locked-note">这些参数只影响草稿单与未来的单；已确认工资单按确认时的规则冻结。</p></div>' +
      "</div>" +
      '<div class="s-grid" style="margin-top:14px">' + rateCards + "</div>";
  }

  /* ---------- 工资单编辑器 ---------- */
  function renderEditor() {
    const sh = db.sheets.find(s => s.id === editingId);
    if (!sh) { editingId = null; render(); return; }
    const confirmed = sh.status === "confirmed";
    let result = null, liveError = "";
    if (confirmed) result = sh.frozen.result;
    else { try { result = P.calcSheet(db, sh); } catch (e) { liveError = e.message; } }

    // 已停用但仍是本单织工的，保留在选项里，避免“被消失”
    const wOpts = db.weavers
      .filter(w => w.active || w.id === sh.weaverId)
      .map(w => '<option value="' + w.id + '"' + (w.id === sh.weaverId ? " selected" : "") + ">" +
      esc(w.code ? w.code + " " : "") + esc(w.name) + (w.active ? "" : "（已停用）") + "</option>").join("");
    const head = confirmed
      ? '<div class="locked-note">🔒 本单于 ' + esc(sh.confirmedAt.replace("T", " ").slice(0, 16)) +
        " 确认锁定。当时的单价、班次、节假日与计划工量已随单冻结，之后改价不影响本单；如需更正只能开调整单。</div>"
      : "";

    root.innerHTML =
      '<div class="s-subtabs"><button class="ghost" data-act="back">← 返回列表</button>' +
      '<span class="spacer"></span><span class="badge ' + sh.status + '">' + (confirmed ? "已确认" : "草稿") + "</span> " +
      '<b>' + sh.id + " " + esc(sh.title || "") + "</b></div>" + head +
      '<div id="editorBody" class="s-grid" style="grid-template-columns:1fr 1fr"></div>' +
      '<div id="editorBottom" style="margin-top:14px"></div>';

    // 左栏：表头 + 明细
    const left = document.createElement("div");
    left.className = "s-card";
    left.innerHTML =
      "<h3>工资单信息</h3>" +
      '<div class="s-row" data-box="head">' +
        "<label>织工<select name='weaverId'" + (confirmed ? " disabled" : "") + ">" + wOpts + "</select></label>" +
        "<label>标题<input name='title' value='" + esc(sh.title || "") + "'" + (confirmed ? " disabled" : "") + "></label>" +
        "<label>周期起<input type='date' name='periodStart' value='" + sh.periodStart + "'" + (confirmed ? " disabled" : "") + "></label>" +
        "<label>周期止<input type='date' name='periodEnd' value='" + sh.periodEnd + "'" + (confirmed ? " disabled" : "") + "></label>" +
        "<label>预支(元)<input type='number' step='0.01' min='0' name='advance' value='" + sh.advance + "'" + (confirmed ? " disabled" : "") + "></label>" +
        "<label>其他扣款(元)<input type='number' step='0.01' min='0' name='otherDeduction' value='" + sh.otherDeduction + "'" + (confirmed ? " disabled" : "") + "></label>" +
        (confirmed ? "" : '<p style="grid-column:1/-1;margin:4px 0"><button class="tiny" data-act="saveHead">保存表头</button></p>') +
      "</div>" +
      "<h3 style='margin-top:14px'>完成量明细（" + sh.entries.length + "）</h3>" +
      entriesTableHtml(sh, result, confirmed) +
      (confirmed ? "" : entryFormHtml(sh));

    // 右栏：计薪结果 + 调整单
    const right = document.createElement("div");
    right.className = "s-card";
    right.innerHTML = totalsHtml(sh, result, liveError, confirmed) +
      (confirmed ? adjustmentsHtml(sh) : confirmBlockHtml(sh, liveError));

    document.querySelector("#editorBody").appendChild(left);
    document.querySelector("#editorBody").appendChild(right);
    bind();
  }

  function entriesTableHtml(sh, result, confirmed) {
    if (!sh.entries.length) return "<p class='muted'>暂无明细。</p>";
    const rows = sh.entries.map((en, i) => {
      const line = result && result.lines[i];
      const segChips = line ? line.segments.map(sg =>
        '<span class="seg-chip' + (sg.holiday ? " hol" : "") + '" title="' + sg.date + '">' +
        esc(sg.shift) + (sg.holiday ? "·节" + sg.mult + "倍" : "") + " " + money(sg.amount) + "</span>").join("") : "";
      const ot = line && line.overtimes.length
        ? line.overtimes.map(o => '<div class="seg-chip' + (o.holiday ? " hol" : "") + '">加班 ' + o.date + " " + o.start + "-" + o.end +
            "（" + (o.minutes / 60).toFixed(1) + "h×" + o.multiplier + "）" + money(o.amount) + "</div>").join("")
        : "";
      return "<tr><td>" + en.date + "<br><span class='muted'>" + (en.start ? esc(en.start + "-" + en.end) : "未排班") + "</span></td>" +
        "<td>" + esc(procName(en.processKey)) + "</td>" +
        '<td class="money">' + en.qty + (en.pieces > 1 ? " <span class='muted'>×" + en.pieces + "件</span>" : "") +
          (line ? "<br><span class='muted'>返工 " + en.reworkQty + "</span>" : "") + "</td>" +
        "<td>" + segChips + ot + (line && en.reworkQty ? '<div class="muted">返工工资 ' + money(line.reworkPay) + "</div>" : "") + "</td>" +
        '<td class="money">' + (line ? money(line.gross) : "—") + "</td>" +
        "<td>" + (confirmed ? "—" : '<button class="tiny danger" data-act="delEntry" data-eid="' + en.id + '">删</button>') + "</td></tr>";
    }).join("");
    return '<table class="s-table"><thead><tr><th>日期/时段</th><th>工序</th><th>完成量</th><th>分段计薪</th><th>小计</th><th></th></tr></thead><tbody>' +
      rows + "</tbody></table>";
  }

  function entryFormHtml(sh) {
    if (!db.plan) return '<p class="warning" style="margin-top:10px">请先到「工序计划」按当前纹样生成计划工量，再录入完成量。</p>';
    const pOpts = db.plan.items.map(it => {
      const used = sh.entries.filter(e => e.processKey === it.processKey).reduce((a, e) => a + (num(e.qty)), 0);
      const m = P.meta(it.processKey);
      return '<option value="' + it.processKey + '">' + esc(m.name) + "（计划 " + it.qty + "，已录 " + used + "）</option>";
    }).join("");
    return '<h3 style="margin-top:14px">录入完成量 / 返工 / 加班</h3>' +
      '<div class="s-row" data-box="entry">' +
        "<label>工序<select name='processKey'>" + pOpts + "</select></label>" +
        "<label>生产日期<input type='date' name='date' value='" + P.todayStr() + "' min='" + sh.periodStart + "' max='" + sh.periodEnd + "'></label>" +
        "<label>上班时间<input type='time' name='start'></label>" +
        "<label>下班时间<input type='time' name='end'></label>" +
        "<label>完成量<input type='number' min='0' step='1' name='qty' value='0'></label>" +
        "<label>返工量<input type='number' min='0' step='1' name='reworkQty' value='0'></label>" +
        "<label>件数(完成几件)<input type='number' min='1' step='1' name='pieces' value='1'></label>" +
        "<label>加班1日期<input type='date' name='ot1date' min='" + sh.periodStart + "' max='" + sh.periodEnd + "'></label>" +
        "<label>起<input type='time' name='ot1start'></label><label>止<input type='time' name='ot1end'></label>" +
        "<label>加班2日期<input type='date' name='ot2date' min='" + sh.periodStart + "' max='" + sh.periodEnd + "'></label>" +
        "<label>起<input type='time' name='ot2start'></label><label>止<input type='time' name='ot2end'></label>" +
        '<p style="grid-column:1/-1;margin:4px 0"><button class="tiny" data-act="addEntry">加入明细（先试算再入表）</button> ' +
        "<span class='muted'>返工按工序返工系数计，不享节假日倍数；加班不得与正常班次重叠。</span></p>" +
      "</div>";
  }

  function totalsHtml(sh, result, liveError, confirmed) {
    if (!result) return "<h3>计薪结果</h3><p class='warning'>当前无法计算：" + esc(liveError) + "</p><p class='muted'>请修正左侧数据。</p>";
    const t = result.totals;
    return "<h3>计薪结果（" + esc(result.weaverName) + "）</h3>" +
      line("计件工资", t.piecePay) + line("返工工资", t.reworkPay) +
      line("加班工资", t.overtimePay) + line("班次津贴", t.allowance) +
      line("应发合计", t.gross) + line("预支", -t.advance) + line("其他扣款", -t.otherDeduction) +
      '<div class="total-line net"><span>' + (confirmed ? "冻结实发" : "实发（试算）") + "</span><span>¥" +
      money(confirmed ? sh.frozen.result.totals.net : t.net) + "</span></div>" +
      (confirmed && P.sheetAdjustments(db, sh.id).length
        ? '<div class="total-line net" style="color:#713d7b"><span>含调整单实发</span><span>¥' + money(P.currentNet(db, sh)) + "</span></div>"
        : "") +
      (liveError ? '<p class="warning">' + esc(liveError) + "</p>" : "");
  }
  const line = (label, v) => '<div class="total-line"><span>' + label + '</span><span class="money">¥' + money(v) + "</span></div>";

  function confirmBlockHtml(sh, liveError) {
    return '<hr style="border:0;border-top:1px solid #e1d5c5;margin:12px 0">' +
      "<h3>确认</h3>" +
      '<button data-act="confirm" ' + (liveError || !sh.entries.length ? "disabled" : "") +
      ' style="width:100%">确认工资单（锁定单价与规则）</button>' +
      '<button class="danger" data-act="deleteSheetFromEditor" style="width:100%;margin-top:8px">删除草稿</button>' +
      '<p class="muted" style="margin-top:8px">确认前会整体试算：织工缺失、负数、预支超发、重复确认、明细越界等都会被拦截，失败不会留下半张单。</p>';
  }

  function adjustmentsHtml(sh) {
    const adjs = P.sheetAdjustments(db, sh.id).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const rows = adjs.map(a => "<tr><td>" + esc(a.date) + "</td><td>" + esc(a.reason) + "</td>" +
      '<td class="money" style="color:' + (a.amount < 0 ? "#a03a2e" : "#2c6632") + '">' + (a.amount > 0 ? "+" : "") + money(a.amount) + "</td></tr>").join("");
    return '<hr style="border:0;border-top:1px solid #e1d5c5;margin:12px 0">' +
      "<h3>调整单（确认后唯一更正通道）</h3>" +
      (adjs.length ? '<table class="s-table"><thead><tr><th>日期</th><th>原因</th><th>金额</th></tr></thead><tbody>' + rows + "</tbody></table>"
        : "<p class='muted'>暂无调整单。</p>") +
      '<div class="s-row" data-box="adj" style="margin-top:8px">' +
        "<label>日期<input type='date' name='date' value='" + P.todayStr() + "'></label>" +
        "<label>金额(元，正补负扣)<input type='number' step='0.01' name='amount'></label>" +
        "<label style='grid-column:1/-1'>原因（必填）<input name='reason' placeholder='如：补录餐费 / 质量扣款'></label>" +
        '<p style="grid-column:1/-1;margin:4px 0"><button class="tiny" data-act="addAdjustment">开调整单</button></p>' +
      "</div>";
  }

  /* ---------- 复核面板 ---------- */
  function auditPanelHtml() {
    const a = lastAudit;
    const rows = a.sheets.map(r => "<tr><td>" + r.id + "</td>" +
      '<td><span class="badge ' + r.status + '">' + (r.status === "draft" ? "草稿" : "已确认") + "</span></td>" +
      '<td class="money">' + (r.net != null ? money(r.net) : "—") + "</td>" +
      "<td>" + (r.ok ? '<span style="color:#2c6632;font-weight:700">✔ 一致</span>'
        : r.errors.map(esc).join("<br>")) + "</td></tr>").join("");
    return '<div class="s-card" style="margin-top:14px;border-color:#b9a0c9"><h3>台账复核结果 ' +
      (a.ok ? '<span style="color:#2c6632">全部通过</span>' : '<span class="warning">存在不一致</span>') + "</h3>" +
      '<table class="s-table"><thead><tr><th>单号</th><th>状态</th><th>实发</th><th>冻结值 vs 重算值</th></tr></thead><tbody>' +
      rows + "</tbody></table><p class='muted'>调整单 " + a.adjustments + " 张。已确认单用其冻结规则重算并逐分核对；草稿按当前规则试算。</p></div>";
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    root.querySelectorAll("[data-act]").forEach(el => {
      el.onclick = onAct;
    });
  }
  function onAct(ev) {
    const el = ev.currentTarget;
    const act = el.dataset.act;
    const id = el.dataset.id;

    switch (act) {
      case "tab": tab = el.dataset.tab; lastAudit = null; render(); break;
      case "goPattern": switchToPattern(); break;
      case "edit": editingId = id; render(); break;
      case "back": editingId = null; render(); break;

      case "addSheet": action("新建工资单", () => {
        const v = vals(document.querySelector('[data-box="newSheet"]'));
        P.addSheet(db, v);
      }); break;

      case "deleteSheet":
        if (!confirm("删除该草稿单？此操作不可恢复。")) break;
        action({ ok: "草稿已删除" }, () => P.removeSheet(db, id));
        break;
      case "deleteSheetFromEditor":
        if (!confirm("删除当前草稿单？此操作不可恢复。")) break;
        action({ ok: "草稿已删除" }, () => { P.removeSheet(db, editingId); editingId = null; });
        break;

      case "saveHead": action("保存表头", () => {
        const v = vals(document.querySelector('[data-box="head"]'));
        P.updateDraft(db, editingId, v);
      }); break;

      case "addEntry": action("加入明细", () => {
        const v = vals(document.querySelector('[data-box="entry"]'));
        const overtimes = [];
        [["ot1date", "ot1start", "ot1end"], ["ot2date", "ot2start", "ot2end"]].forEach(([d, s, e]) => {
          if (v[d] || v[s] || v[e]) overtimes.push({ date: v[d], start: v[s], end: v[e] });
        });
        P.addEntry(db, editingId, {
          processKey: v.processKey, date: v.date, start: v.start, end: v.end,
          qty: num(v.qty), reworkQty: num(v.reworkQty), pieces: num(v.pieces) || 1,
          overtimes: overtimes
        });
      }); break;
      case "delEntry":
        action("删除明细", () => P.removeEntry(db, editingId, el.dataset.eid));
        break;

      case "confirm": {
        const sh = db.sheets.find(s => s.id === editingId);
        let preview;
        try { preview = P.calcSheet(db, sh); }
        catch (e) { flash(e.message, false); return; }
        if (!confirm("确认 " + sh.id + "（" + preview.weaverName + "）实发 ¥" + preview.totals.net.toFixed(2) +
          "？\n确认后单价与规则冻结，只能开调整单。")) break;
        action({ ok: "工资单已确认并冻结" }, () => P.confirmSheet(db, editingId));
        break;
      }
      case "addAdjustment": action({ ok: "调整单已开立" }, () => {
        const v = vals(document.querySelector('[data-box="adj"]'));
        P.addAdjustment(db, editingId, { amount: num(v.amount), reason: v.reason, date: v.date });
      }); break;

      /* 工序计划 */
      case "genPlan": action({ ok: "工序计划已按当前纹样生成（草稿单将按新计划校验）" }, () => {
        const pat = patternInfo();
        db.plan = P.generatePlan(pat);
      }); break;

      /* 规则 */
      case "addWeaver": action("新增织工", () => {
        const v = vals(document.querySelector('[data-box="weaver"]'));
        P.addWeaver(db, v);
      }); break;
      case "toggleWeaver": action("切换织工状态", () => {
        const w = db.weavers.find(x => x.id === id);
        w.active = !w.active;
      }); break;
      case "setRate": action("单价", () => {
        const box = el.closest("[data-box]");
        const v = vals(box);
        P.setRate(db, { processKey: el.dataset.key, from: v.from, price: num(v.price) });
      }); break;      case "editShift": {
        const s = db.shifts.find(x => x.id === id);
        const box = document.querySelector('[data-box="shift"]');
        box.querySelector('[name=id]').value = s.id;
        box.querySelector('[name=name]').value = s.name;
        box.querySelector('[name=start]').value = s.start;
        box.querySelector('[name=end]').value = s.end;
        box.querySelector('[name=allowance]').value = s.allowance;
        break;
      }
      case "setShift": action("班次", () => {
        const v = vals(document.querySelector('[data-box="shift"]'));
        P.setShift(db, v);
      }); break;
      case "addHoliday": action("节假日标记", () => {
        const v = vals(document.querySelector('[data-box="holiday"]'));
        if (db.holidays.indexOf(v.date) >= 0) throw new Error(v.date + " 已是节假日");
        P.toggleHoliday(db, v.date);
      }); break;
      case "delHoliday": action("取消节假日", () => P.toggleHoliday(db, el.dataset.date)); break;
      case "saveParams": action("参数", () => {
        const v = vals(document.querySelector('[data-box="params"]'));
        const hm2 = num(v.holidayMultiplier), ot = num(v.overtimeRate);
        if (!(hm2 >= 1)) throw new Error("节假日倍数不能小于 1");
        if (ot < 0) throw new Error("加班时基不能为负");
        db.holidayMultiplier = hm2; db.overtimeRate = ot;
      }); break;

      /* 导入导出 / 复核 */
      case "audit":
        lastAudit = P.auditData(db); persist(); render();
        flash(lastAudit.ok ? "复核完成：已确认单冻结结果与重算完全一致" : "复核发现问题，见下方明细", lastAudit.ok);
        break;
      case "export": doExport(); break;
      case "clickImport": document.querySelector("#importFile").click(); break;
      default: break;
    }
  }
  function doExport() {
    const pat = patternInfo();
    const b = P.exportBundle(db, pat);
    try {
      const blob = new Blob([b.file], { type: "application/json" });
      const a = document.createElement("a");
      if (URL.createObjectURL) {
        a.href = URL.createObjectURL(blob);
        a.download = "brocade-settlement-" + P.todayStr() + ".json";
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
      }
    } catch (e) { /* 非浏览器环境忽略下载动作 */ }
    flash("台账已导出（校验和 " + b.checksum + "）", true);
    return b.file;
  }

  document.addEventListener("change", e => {
    if (e.target && e.target.id === "importFile") {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imp = P.importBundle(String(reader.result)); // 校验和 + 重算复核
          const snapshot = db;
          db = imp.data; persist();
          editingId = null; tab = "sheets"; lastAudit = imp.report;
          render();
          const pat = imp.pattern;
          if (pat && pat.cells) {
            root.insertAdjacentHTML("afterbegin",
              '<div class="s-card locked-note">导入文件附带纹样（' + pat.cols + "×" + pat.rows +
              '）。<button class="tiny" data-act="loadPattern">载入到排版台</button></div>');
            root.querySelector("[data-act=loadPattern]").onclick = () => {
              localStorage.setItem("zfl31Pattern", JSON.stringify(pat));
              if (typeof window.initPattern === "function") window.initPattern();
              switchToPattern();
            };
          }
          flash(imp.report.ok
            ? "导入并复核成功：校验和 " + imp.checksum + "，已确认单结果逐分一致"
            : "已导入，但复核发现不一致，请查看下方明细", imp.report.ok);
        } catch (err) {
          flash("导入被拒绝：" + err.message, false);
        }
        e.target.value = "";
      };
      reader.readAsText(file);
    }
  });

  /* ---------- 视图切换 ---------- */
  const patternView = document.querySelector("#patternView");
  const settleView = document.querySelector("#settleView");
  function switchToSettle() {
    patternView.classList.add("s-hidden");
    settleView.classList.remove("s-hidden");
    document.querySelector("#tabPattern").classList.remove("active");
    document.querySelector("#tabSettle").classList.add("active");
    editingId = null; lastAudit = null;
    render();
  }
  function switchToPattern() {
    settleView.classList.add("s-hidden");
    patternView.classList.remove("s-hidden");
    document.querySelector("#tabSettle").classList.remove("active");
    document.querySelector("#tabPattern").classList.add("active");
  }
  document.querySelector("#tabSettle").onclick = switchToSettle;
  document.querySelector("#tabPattern").onclick = switchToPattern;
})();
