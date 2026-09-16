/*
 * 织造计件结算台 —— 纯计薪引擎（无 DOM 依赖，可在 node 中自测）
 *
 * 数据均为普通对象，localStorage 仅在 settlement.js 中读写；
 * 所有金额以“元”为单位，内部保留两位小数（四舍五入）。
 */
(function (root) {
  "use strict";

  var ROUND = 2;
  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  /* ---------- 日期/时间工具 ---------- */

  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
    if (!m) throw new Error("日期格式应为 YYYY-MM-DD：" + s);
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) {
      throw new Error("无效日期：" + s);
    }
    return d;
  }
  function dateStr(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function addDays(s, n) {
    var d = parseDate(s);
    d.setDate(d.getDate() + n);
    return dateStr(d);
  }
  function todayStr() { return dateStr(new Date()); }
  // 日期串 -> 自纪元起的天数（与 UTC 偏移无关，只用于求间隔/比较）
  function dayOrd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  }
  function daysBetween(a, b) { return dayOrd(b) - dayOrd(a); }
  // 自纪元 UTC 天数 -> YYYY-MM-DD
  function ordToDateStr(ord) {
    var d = new Date(ord * 86400000);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }
  function minDate(a, b) { return (a == null || (b != null && dayOrd(b) < dayOrd(a))) ? b : a; }
  function isHoliday(db, date) { return db.holidays.indexOf(date) >= 0; }
  // "HH:MM" -> 分钟数
  function hm(t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
    if (!m) throw new Error("时间格式应为 HH:MM：" + t);
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) throw new Error("无效时间：" + t);
    return h * 60 + mi;
  }
  // 绝对分钟（基准日 00:00 起），允许跨夜（end < start 时加一天）
  function absMinutes(date, t) { return dayOrd(date) * 1440 + hm(t); }
  // 半开工作区间 [起, 止)：
  // 严格模式：仅当止“严格小于”起才跨夜加一天；起止相同 = 零时长，拒绝；
  // legacy 模式（复核旧版已确认单）：保持旧语义 end<=start 即加一天，相同时刻按 24 小时。
  function workInterval(date, start, end, label, strict) {
    var s = absMinutes(date, start), e = absMinutes(date, end);
    if (strict === false) {
      if (e <= s) e += 1440;
      return { start: s, end: e };
    }
    if (e < s) e += 1440;
    if (e === s) throw new Error((label || "工作时段") + "的起止时刻相同（" + start + "–" + end + "），零时长不能计薪");
    return { start: s, end: e };
  }
  // 结算周期的绝对半开区间：[首日 00:00, 末日次日 00:00)
  function periodBounds(periodStart, periodEnd) {
    return { start: dayOrd(periodStart) * 1440, end: (dayOrd(periodEnd) + 1) * 1440 };
  }
  function assertIntervalInPeriod(iv, sheet, label) {
    var b = periodBounds(sheet.periodStart, sheet.periodEnd);
    if (iv.start < b.start || iv.end > b.end) {
      throw new Error(label + "超出结算周期 " + sheet.periodStart + "~" + sheet.periodEnd +
        "：跨周期的时段请拆成两笔，周期外部分录到下一周期");
    }
  }
  // 一条明细（生产时段 + 每段加班）必须整体落在结算周期内
  function assertEntryWithinPeriod(en, sheet) {
    if (dayOrd(en.date) < dayOrd(sheet.periodStart) || dayOrd(en.date) > dayOrd(sheet.periodEnd)) {
      throw new Error("生产日期 " + en.date + " 不在结算周期 " + sheet.periodStart + "~" + sheet.periodEnd + " 内");
    }
    if (en.start) {
      assertIntervalInPeriod(workInterval(en.date, en.start, en.end, "生产时段"),
        sheet, en.date + " " + en.start + "–" + en.end + " 的生产时段");
    }
    (en.overtimes || []).forEach(function (o) {
      if (dayOrd(o.date) < dayOrd(sheet.periodStart) || dayOrd(o.date) > dayOrd(sheet.periodEnd)) {
        throw new Error("加班日期 " + o.date + " 不在结算周期 " + sheet.periodStart + "~" + sheet.periodEnd + " 内");
      }
      assertIntervalInPeriod(workInterval(o.date, o.start, o.end, "加班时段"),
        sheet, "加班 " + o.date + " " + o.start + "–" + o.end);
    });
  }

  /* ---------- 基础数据 ---------- */

  var CORE_PROCESSES = [
    { key: "warping", name: "牵经", reworkFactor: 0.5, basis: "colorColumns",
      note: "按用色经列计（每色每列 1 单位），底组织色不计。" },
    { key: "patternCards", name: "挑花结本", reworkFactor: 0.4, basis: "colorCells",
      note: "按花纹色格计（非底色格数）。" },
    { key: "weaving", name: "上机织造", reworkFactor: 0.6, basis: "gridCells",
      note: "按纹格总数计（列×行）。" },
    { key: "finishing", name: "整理整修", reworkFactor: 0.5, basis: "gridCells",
      note: "按纹格总数的 1/4 计。" }
  ];
  var CORE_KEYS = CORE_PROCESSES.map(function (p) { return p.key; });

  function defaultData() {
    return {
      version: 1,
      plan: null,
      weavers: [
        { id: "w1", name: "杨秀英", code: "ZG-001", active: true },
        { id: "w2", name: "龙阿妹", code: "ZG-002", active: true }
      ],
      processes: CORE_PROCESSES.map(function (p) { return { key: p.key, name: p.name, active: true }; }),
      rates: [
        { id: "r1", processKey: "warping",      from: "2026-01-01", price: 2.0 },
        { id: "r2", processKey: "patternCards", from: "2026-01-01", price: 1.2 },
        { id: "r3", processKey: "weaving",      from: "2026-01-01", price: 0.8 },
        { id: "r4", processKey: "finishing",    from: "2026-01-01", price: 0.5 }
      ],
      shifts: [
        { id: "s1", name: "早班", start: "06:00", end: "14:00", allowance: 5 },
        { id: "s2", name: "中班", start: "14:00", end: "22:00", allowance: 8 },
        { id: "s3", name: "夜班", start: "22:00", end: "06:00", allowance: 15 }
      ],
      holidays: [],
      holidayMultiplier: 2.0,
      overtimeRate: 25,
      sheets: [],
      adjustments: []
    };
  }

  function meta(key) {
    for (var i = 0; i < CORE_PROCESSES.length; i++) if (CORE_PROCESSES[i].key === key) return CORE_PROCESSES[i];
    return null;
  }

  /* ---------- 工序计划工量（按当前纹样） ---------- */

  function generatePlan(pattern) {
    if (!pattern || !Array.isArray(pattern.cells) || !pattern.cols || !pattern.rows) {
      throw new Error("当前没有可用的纹样，请先在排版台绘制并保存。");
    }
    var cols = pattern.cols, rows = pattern.rows, cells = pattern.cells;
    var baseColor = 0; // 底色（色线0）视为底组织，不计花纹工量
    var colorCells = 0;
    for (var i = 0; i < cells.length; i++) if (cells[i] !== baseColor) colorCells++;

    var colorColumns = 0;
    for (var x = 0; x < cols; x++) {
      var used = {};
      for (var y = 0; y < rows; y++) {
        var c = cells[y * cols + x];
        if (c !== baseColor) used[c] = true;
      }
      colorColumns += Object.keys(used).length;
    }
    var gridCells = cols * rows;
    var items = [
      { processKey: "warping",      qty: colorColumns },
      { processKey: "patternCards", qty: colorCells },
      { processKey: "weaving",      qty: gridCells },
      { processKey: "finishing",    qty: Math.ceil(gridCells / 4) }
    ];
    return {
      generatedAt: todayStr(),
      patternName: pattern.name || "",
      cols: cols, rows: rows,
      colorCells: colorCells, colorColumns: colorColumns, gridCells: gridCells,
      items: items
    };
  }

  function planQty(plan, key) {
    if (!plan) return null;
    for (var i = 0; i < plan.items.length; i++) if (plan.items[i].processKey === key) return plan.items[i].qty;
    return null;
  }

  /* ---------- 单价（按生效日期取值） ---------- */

  // 返回 date 当天对工序生效的单价记录；未配置返回 null
  function rateAt(db, processKey, date) {
    var best = null;
    for (var i = 0; i < db.rates.length; i++) {
      var r = db.rates[i];
      if (r.processKey !== processKey) continue;
      if (dayOrd(r.from) <= dayOrd(date) && (!best || dayOrd(r.from) > dayOrd(best.from))) best = r;
    }
    return best;
  }

  /* ---------- 班次 / 时间段切分（跨班次分段计薪） ---------- */

  // 返回班次覆盖 [absStart, absEnd) 的分钟区间数组（自动跨夜）
  function shiftIntervals(sh, date) {
    var start = absMinutes(date, sh.start);
    var end = absMinutes(date, sh.end);
    if (end <= start) end += 1440;
    return [{ start: start, end: end }];
  }
  function overlap(a, b) { return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)); }
  // 班次在时钟上的半开区间（跨夜则 end 加一天）
  function shiftRange(start, end) {
    var s = hm(start), e = hm(end);
    if (e <= s) e += 1440;
    return { start: s, end: e };
  }
  // 两个班次（允许跨夜）是否有正时长重叠；端点相接不算重叠
  function shiftsOverlap(a, b) {
    var ra = shiftRange(a.start, a.end);
    var rb = shiftRange(b.start, b.end);
    for (var k = -1; k <= 1; k++) {
      if (overlap(ra, { start: rb.start + k * 1440, end: rb.end + k * 1440 }) > 0) return true;
    }
    return false;
  }

  // 把一段工作时间按“班次 × 是否节假日”切成计薪段
  // 输入：date + start/end（end<start 视为跨夜，end=start 视为零时长拒绝）
  // 输出每段：{minutes, shiftId|null, shiftName, allowance, holiday}
  function splitSegments(db, date, start, end, strict) {
    var iv = workInterval(date, start, end, "工作时段", strict);
    var s = iv.start, e = iv.end;

    // 以班次边界为切点；未落入任何班次的部分归为“班外”段
    var cuts = {};
    cuts[s] = true; cuts[e] = true;
    var shiftIvls = db.shifts.map(function (sh) {
      return { sh: sh, ivls: shiftIntervals(sh, date) };
    });
    shiftIvls.forEach(function (si) {
      si.ivls.forEach(function (iv) {
        if (iv.start > s && iv.start < e) cuts[iv.start] = true;
        if (iv.end > s && iv.end < e) cuts[iv.end] = true;
      });
    });
    var points = Object.keys(cuts).map(Number).sort(function (a, b) { return a - b; });

    var segs = [];
    for (var k = 0; k < points.length - 1; k++) {
      var a = points[k], b = points[k + 1], mid = (a + b) / 2;
      if (b <= s || a >= e) continue;
      var found = null;
      for (var j = 0; j < shiftIvls.length; j++) {
        var hit = shiftIvls[j].ivls.some(function (iv) { return mid >= iv.start && mid < iv.end; });
        if (hit) { found = shiftIvls[j].sh; break; }
      }
      var segDateOrd = Math.floor(mid / 1440);
      var segDate = ordToDateStr(segDateOrd);
      segs.push({
        start: Math.max(a, s), end: Math.min(b, e),
        minutes: Math.min(b, e) - Math.max(a, s),
        shiftId: found ? found.id : null,
        shiftName: found ? found.name : "班外",
        allowance: found ? Number(found.allowance) || 0 : 0,
        holiday: isHoliday(db, segDate),
        date: segDate
      });
    }
    return segs;
  }

  /* ---------- 单条完成量计薪 ---------- */

  // entry: { processKey, qty, reworkQty, date, start, end, advance, otherDeduction }
  // opts.strict === false 时为 legacy 复核模式：零时长按旧版 24 小时语义，不套用新录入规则
  // 返回 { segments:[{…}], piecePay, reworkPay, overtimePay, allowance, gross, ... }
  function calcEntry(db, entry, opts) {
    var strict = !opts || opts.strict !== false;
    if (!entry.processKey) throw new Error("缺少工序");
    if (!entry.date) throw new Error("缺少生产日期");
    var qty = Number(entry.qty) || 0;
    var reworkQty = Number(entry.reworkQty) || 0;
    var pieces = Number(entry.pieces) || 1;
    if (qty < 0 || reworkQty < 0) throw new Error("完成量/返工量不能为负");
    if (!(pieces >= 1)) throw new Error("件数至少为 1");
    var planQ = planQty(db.plan, entry.processKey);
    if (planQ != null && qty > planQ * pieces) {
      throw new Error("完成量 " + qty + " 超过工序计划工量 " + planQ + " × " + pieces + " 件 = " + (planQ * pieces));
    }
    var rate = rateAt(db, entry.processKey, entry.date);
    if (!rate) throw new Error(processName(db, entry.processKey) + " 在 " + entry.date + " 没有生效单价");
    var price = Number(rate.price);
    if (!(price > 0)) throw new Error(processName(db, entry.processKey) + " 单价必须大于 0");

    var m = meta(entry.processKey);
    var factor = m ? m.reworkFactor : 0.5;

    // 分段（跨班次 / 跨节假日）
    var segs;
    if (entry.start && entry.end) {
      segs = splitSegments(db, entry.date, entry.start, entry.end, strict);
    } else {
      segs = [{
        start: 0, end: 0, minutes: 0,
        shiftId: null, shiftName: "未排班", allowance: 0,
        holiday: isHoliday(db, entry.date), date: entry.date
      }];
    }
    var totalMin = segs.reduce(function (a, s2) { return a + s2.minutes; }, 0);

    // 计件与返工：正产按段分摊（节假日段乘补贴倍数）；返工按返工系数，不享节假日倍数
    var holMult = Number(db.holidayMultiplier) > 0 ? Number(db.holidayMultiplier) : 1;
    var basePiece = r2(qty * price);
    var weighted = segs.map(function (sg) {
      var w = totalMin ? sg.minutes / totalMin : (sg.holiday ? 0 : 1);
      return { sg: sg, w: w, mult: sg.holiday ? holMult : 1 };
    });
    // 无工时记录时，若当天是节假日整体按节假日倍数
    if (!totalMin && segs.length === 1 && segs[0].holiday) weighted[0].mult = holMult;
    var weightSum = weighted.reduce(function (a, x) { return a + x.w * x.mult; }, 0) || 1;

    var pieceSegs = weighted.map(function (x) {
      var amount = r2(basePiece * (x.w * x.mult) / weightSum);
      return {
        shift: x.sg.shiftName,
        shiftId: x.sg.shiftId,
        date: x.sg.date, minutes: x.sg.minutes,
        holiday: x.sg.holiday, mult: x.mult, amount: amount
      };
    });
    // 修正分摊舍入残差到最后一段，保证合计 == 节假日加权总额
    var pieceTotal = r2(qty * price * (totalMin
      ? (weighted.reduce(function (a, x) { return a + x.w * x.mult; }, 0))
      : (segs[0].holiday ? holMult : 1)));
    var segSum = r2(pieceSegs.reduce(function (a, p) { return a + p.amount; }, 0));
    if (pieceSegs.length) pieceSegs[pieceSegs.length - 1].amount = r2(pieceSegs[pieceSegs.length - 1].amount + pieceTotal - segSum);

    var reworkPay = r2(reworkQty * price * factor);

    // 加班时段（与正常班次重叠要拦截）
    var overtimePay = 0;
    var overtimes = (entry.overtimes || []).map(function (o) {
      var oiv = workInterval(o.date, o.start, o.end, "加班时段", strict);
      var os = oiv.start, oe = oiv.end, mins = oe - os;
      // 与该条生产时间重叠检测（legacy 旧单同样有此校验，保持一致）
      if (entry.start && entry.end) {
        var eiv = workInterval(entry.date, entry.start, entry.end, "生产时段", strict);
        if (overlap(oiv, eiv) > 0) {
          throw new Error("加班时段 " + o.date + " " + o.start + "-" + o.end + " 与正常班次重叠");
        }
      }
      var hol = isHoliday(db, o.date);
      var mult = hol ? 3.0 : 2.0; // 法定节假 3 倍、日常加班 2 倍小时单价
      var amount = r2((mins / 60) * Number(db.overtimeRate) * mult);
      overtimePay += amount;
      return { date: o.date, start: o.start, end: o.end, minutes: mins, holiday: hol, multiplier: mult, amount: amount };
    });
    overtimePay = r2(overtimePay);

    // 班次津贴：工作时间跨过的每个班次计一次（按覆盖分钟占比分摊，落在班外不给）
    var allowance = 0;
    if (totalMin) {
      db.shifts.forEach(function (sh) {
        var cov = 0;
        shiftIntervals(sh, entry.date).forEach(function (iv) {
          cov += overlap(iv, { start: s_value(segs), end: e_value(segs) });
        });
        if (cov > 0) allowance += (Number(sh.allowance) || 0) * Math.min(1, cov / totalMin);
      });
    }
    allowance = r2(allowance);

    return {
      rateId: rate.id, price: price, reworkFactor: factor,
      planQty: planQ, pieces: pieces, qty: qty, reworkQty: reworkQty,
      segments: pieceSegs, totalMinutes: totalMin,
      piecePay: pieceTotal, reworkPay: reworkPay,
      overtimes: overtimes, overtimePay: overtimePay,
      allowance: allowance,
      gross: r2(pieceTotal + reworkPay + overtimePay + allowance)
    };
  }
  function s_value(segs) { return segs.reduce(function (m, x) { return Math.min(m, x.start); }, Infinity); }
  function e_value(segs) { return segs.reduce(function (m, x) { return Math.max(m, x.end); }, -Infinity); }
  function processName(db, key) {
    for (var i = 0; i < db.processes.length; i++) if (db.processes[i].key === key) return db.processes[i].name;
    return key;
  }

  /* ---------- 工资单整单计算 ---------- */

  // opts.strict === false：复核旧版已确认单的 legacy 模式，
  // 不套用“周期区间/零时长”等新录入校验，只按冻结规则重算金额。
  function calcSheet(db, sheet, opts) {
    var strict = !opts || opts.strict !== false;
    var weaver = findWeaver(db, sheet.weaverId);
    if (!weaver) throw new Error("缺少织工或织工已被删除");
    if (!sheet.periodStart || !sheet.periodEnd) throw new Error("结算周期不完整");
    if (dayOrd(sheet.periodEnd) < dayOrd(sheet.periodStart)) throw new Error("结算周期起止颠倒");
    if (!sheet.entries.length) throw new Error("没有任何完成量明细");

    var lines = sheet.entries.map(function (en) {
      // 严格模式（录入/草稿/确认）：日期与区间必须完全落在周期内；
      // legacy 模式（复核旧已确认单）：跳过这些新规则，仅按当时冻结规则重算
      if (strict) assertEntryWithinPeriod(en, sheet);
      return calcEntry(db, en, { strict: strict });
    });

    var piecePay = r2(lines.reduce(function (a, l) { return a + l.piecePay; }, 0));
    var reworkPay = r2(lines.reduce(function (a, l) { return a + l.reworkPay; }, 0));
    var overtimePay = r2(lines.reduce(function (a, l) { return a + l.overtimePay; }, 0));
    var allowance = r2(lines.reduce(function (a, l) { return a + l.allowance; }, 0));
    var gross = r2(piecePay + reworkPay + overtimePay + allowance);
    var advance = r2(sheet.advance || 0);
    var otherDeduction = r2(sheet.otherDeduction || 0);
    if (advance < 0 || otherDeduction < 0) throw new Error("预支/扣款不能为负");
    var net = r2(gross - advance - otherDeduction);
    if (net < 0) throw new Error("应发净额为负（" + net + " 元）：预支 " + advance + "、扣款 " + otherDeduction + " 超过应付 " + gross);

    // 收集本单实际引用的计价规则，供确认时精确冻结（未引用的规则不锁）
    var rateIds = {}, shiftIds = {}, refDates = {};
    lines.forEach(function (l) {
      if (l.rateId) rateIds[l.rateId] = true;
      l.segments.forEach(function (sg) {
        if (sg.shiftId) shiftIds[sg.shiftId] = true;
        if (sg.date) refDates[sg.date] = true;
      });
    });
    sheet.entries.forEach(function (en) {
      refDates[en.date] = true;
      (en.overtimes || []).forEach(function (o) { refDates[o.date] = true; });
    });

    return {
      weaverId: sheet.weaverId, weaverName: weaver.name,
      periodStart: sheet.periodStart, periodEnd: sheet.periodEnd,
      lines: lines,
      referenced: {
        rateIds: Object.keys(rateIds),
        shiftIds: Object.keys(shiftIds),
        dates: Object.keys(refDates)
      },
      totals: {
        piecePay: piecePay, reworkPay: reworkPay, overtimePay: overtimePay,
        allowance: allowance, gross: gross, advance: advance,
        otherDeduction: otherDeduction, net: net
      }
    };
  }

  function findWeaver(db, id) {
    for (var i = 0; i < db.weavers.length; i++) if (db.weavers[i].id === id) return db.weavers[i];
    return null;
  }
  function findSheet(db, id) {
    for (var i = 0; i < db.sheets.length; i++) if (db.sheets[i].id === id) return db.sheets[i];
    return null;
  }

  /* ---------- 确认 / 调整（确认后只能开调整单） ---------- */

  function confirmSheet(db, sheetId) {
    var sheet = findSheet(db, sheetId);
    if (!sheet) throw new Error("工资单不存在");
    if (sheet.status !== "draft") throw new Error("工资单已确认，不能重复确认");

    // 全部校验通过后才落库 —— 失败不留半张工资单
    var result = calcSheet(db, sheet);

    // 冻结：仅快照本单实际引用的单价、班次，以及相关日期上的节假日；
    // 未被本单使用的规则保持可维护，其他确认单各按自己的引用冻结。
    var ref = result.referenced;
    var refRateIds = {}; ref.rateIds.forEach(function (id) { refRateIds[id] = true; });
    var refShiftIds = {}; ref.shiftIds.forEach(function (id) { refShiftIds[id] = true; });
    var refDates = {}; ref.dates.forEach(function (d) { refDates[d] = true; });
    sheet.status = "confirmed";
    sheet.confirmedAt = newISO();
    sheet.frozen = {
      result: result,
      rates: db.rates.filter(function (r) { return refRateIds[r.id]; }).map(clone),
      shifts: db.shifts.filter(function (s) { return refShiftIds[s.id]; }).map(clone),
      holidays: db.holidays.filter(function (d) { return refDates[d]; }).slice(),
      holidayMultiplier: db.holidayMultiplier,
      overtimeRate: db.overtimeRate,
      plan: db.plan ? clone(db.plan) : null
    };
    return result;
  }

  // 调整单：确认后的唯一修改通道；confirmed 单向，金额校验后追加，不动原单
  function addAdjustment(db, sheetId, input) {
    var sheet = findSheet(db, sheetId);
    if (!sheet) throw new Error("工资单不存在");
    if (sheet.status !== "confirmed") throw new Error("只有已确认工资单可以开调整单，草稿请直接修改");
    var amount = Number(input.amount);
    if (!isFinite(amount) || amount === 0) throw new Error("调整金额不能为 0 或非数字");
    var reason = (input.reason || "").trim();
    if (!reason) throw new Error("调整原因必填");

    var frozenNet = sheet.frozen.result.totals.net;
    var adjusted = currentNet(db, sheet);
    var after = r2(adjusted + amount);
    if (after < 0) throw new Error("调整后实发不能为负（当前 " + adjusted + "，调整 " + amount + "）");

    var adj = {
      id: "a" + (db.adjustments.reduce(function (mx, a) {
        var n = parseInt(String(a.id).replace(/^a/, ""), 10);
        return isNaN(n) ? mx : Math.max(mx, n);
      }, 0) + 1),
      sheetId: sheetId,
      date: input.date || todayStr(),
      amount: r2(amount),
      reason: reason,
      createdAt: newISO()
    };
    db.adjustments.push(adj);
    return adj;
  }

  function currentNet(db, sheet) {
    var net = sheet.frozen.result.totals.net;
    db.adjustments.forEach(function (a) {
      if (a.sheetId === sheet.id) net = r2(net + a.amount);
    });
    return net;
  }
  function sheetAdjustments(db, sheetId) {
    return db.adjustments.filter(function (a) { return a.sheetId === sheetId; });
  }

  /* ---------- 草稿编辑的安全包装 ---------- */

  function addSheet(db, input) {
    if (!findWeaver(db, input.weaverId)) throw new Error("请选择织工");
    if (!input.periodStart || !input.periodEnd) throw new Error("请填写结算周期");
    if (dayOrd(input.periodEnd) < dayOrd(input.periodStart)) throw new Error("结算周期起止颠倒");
    parseDate(input.periodStart); parseDate(input.periodEnd);
    var n = db.sheets.length + 1;
    var id;
    do {
      id = "sh" + pad3(n++);
    } while (findSheet(db, id));
    var sheet = {
      id: id,
      weaverId: input.weaverId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      title: input.title || "",
      advance: 0,
      otherDeduction: 0,
      entries: [],
      status: "draft",
      createdAt: newISO()
    };
    // 试算一次（空单允许保存，但织工/周期必须成立）
    db.sheets.push(sheet);
    return sheet;
  }
  function pad3(n) { return n < 10 ? "00" + n : n < 100 ? "0" + n : "" + n; }

  function updateDraft(db, sheetId, patch) {
    var sheet = findSheet(db, sheetId);
    if (!sheet) throw new Error("工资单不存在");
    if (sheet.status !== "draft") throw new Error("已确认工资单不能直接修改，请开调整单");
    if (patch.weaverId != null) {
      if (!findWeaver(db, patch.weaverId)) throw new Error("织工不存在，不能保存");
      sheet.weaverId = patch.weaverId;
    }
    if (patch.periodStart != null) sheet.periodStart = patch.periodStart;
    if (patch.periodEnd != null) sheet.periodEnd = patch.periodEnd;
    if (patch.title != null) sheet.title = patch.title;
    ["advance", "otherDeduction"].forEach(function (f) {
      if (patch[f] != null) {
        var v = Number(patch[f]);
        if (!(v >= 0)) throw new Error((f === "advance" ? "预支" : "其他扣款") + "不能为负");
        sheet[f] = r2(v);
      }
    });
    if (sheet.periodEnd && sheet.periodStart && dayOrd(sheet.periodEnd) < dayOrd(sheet.periodStart)) {
      throw new Error("结算周期起止颠倒");
    }
    return sheet;
  }

  function addEntry(db, sheetId, entry) {
    var sheet = findSheet(db, sheetId);
    if (!sheet) throw new Error("工资单不存在");
    if (sheet.status !== "draft") throw new Error("已确认工资单不能补录明细，请开调整单");
    var clean = sanitizeEntry(entry);
    // 入表即校验结算周期：生产日期、生产区间、每段加班日期与区间都必须完全落在周期内
    assertEntryWithinPeriod(clean, sheet);
    calcEntry(db, Object.assign({ advance: 0, otherDeduction: 0 }, clean)); // 先试算，非法不入表
    clean.id = "e" + (sheet.entries.length + 1) + "_" + (sheet.entries.reduce(function (mx, e) {
      var mm = /^e\d+_(\d+)$/.exec(e.id);
      return mm ? Math.max(mx, +mm[1]) : mx;
    }, 0) + 1);
    sheet.entries.push(clean);
    return clean;
  }
  function sanitizeEntry(entry) {
    if (!entry.processKey) throw new Error("请选择工序");
    if (!entry.date) throw new Error("请填写生产日期");
    parseDate(entry.date);
    ["qty", "reworkQty"].forEach(function (f) {
      var raw = entry[f] === undefined || entry[f] === "" ? 0 : Number(entry[f]);
      if (!isFinite(raw) || raw < 0) throw new Error((f === "qty" ? "完成量" : "返工量") + "不能为负");
      entry[f] = raw;
    });
    if (entry.pieces != null && (Number(entry.pieces) < 1 || !isFinite(Number(entry.pieces)))) {
      throw new Error("件数至少为 1");
    }
    if ((Number(entry.qty) || 0) === 0 && (Number(entry.reworkQty) || 0) === 0 && !(entry.overtimes || []).length) {
      throw new Error("完成量、返工量与加班不能同时为空");
    }
    if (entry.start && !entry.end) throw new Error("请补全下班时间");
    if (!entry.start && entry.end) throw new Error("请补全上班时间");
    if (entry.start) { hm(entry.start); hm(entry.end); }
    var overtimes = (entry.overtimes || []).map(function (o) {
      if (!o.date || !o.start || !o.end) throw new Error("加班时段不完整");
      parseDate(o.date); hm(o.start); hm(o.end);
      workInterval(o.date, o.start, o.end, "加班时段"); // 起止相同直接拒绝
      return { date: o.date, start: o.start, end: o.end };
    });
    return {
      processKey: entry.processKey,
      date: entry.date,
      start: entry.start || "",
      end: entry.end || "",
      pieces: Number(entry.pieces) || 1,
      qty: Number(entry.qty) || 0,
      reworkQty: Number(entry.reworkQty) || 0,
      overtimes: overtimes
    };
  }
  function removeEntry(db, sheetId, entryId) {
    var sheet = findSheet(db, sheetId);
    if (!sheet) throw new Error("工资单不存在");
    if (sheet.status !== "draft") throw new Error("已确认工资单不能删除明细");
    var before = sheet.entries.length;
    sheet.entries = sheet.entries.filter(function (e) { return e.id !== entryId; });
    if (sheet.entries.length === before) throw new Error("明细不存在");
  }
  function removeSheet(db, sheetId) {
    var sheet = findSheet(db, sheetId);
    if (!sheet) throw new Error("工资单不存在");
    if (sheet.status === "confirmed") throw new Error("已确认工资单不能删除，如需冲销请开负数以外的调整单");
    var i = db.sheets.indexOf(sheet);
    db.sheets.splice(i, 1);
    db.adjustments = db.adjustments.filter(function (a) { return a.sheetId !== sheetId; });
  }

  /* ---------- 主数据维护 ---------- */

  function addWeaver(db, input) {
    var name = (input.name || "").trim();
    if (!name) throw new Error("织工姓名必填");
    var code = (input.code || "").trim();
    if (db.weavers.some(function (w) { return w.code && w.code === code; })) throw new Error("工号重复：" + code);
    var id = "w" + (db.weavers.length + 1) + "_" + idTail();
    if (db.weavers.some(function (w) { return w.id === id; })) id = "w_" + idTail();
    var w = { id: id, name: name, code: code, active: true };
    db.weavers.push(w);
    return w;
  }
  function idTail() { return Date.now().toString(36).slice(-5); }

  function setRate(db, input) {
    if (!input.processKey) throw new Error("请选择工序");
    var price = Number(input.price);
    if (!(price > 0)) throw new Error("单价必须大于 0");
    parseDate(input.from);
    // 同工序 + 同一生效日只保留一条（覆盖），避免取值歧义
    var existing = null;
    for (var i = 0; i < db.rates.length; i++) {
      if (db.rates[i].processKey === input.processKey && db.rates[i].from === input.from) { existing = db.rates[i]; break; }
    }
    if (existing) {
      // 已被确认单冻结引用的历史价不允许改：历史单价变化不能影响已锁定工资
      if (rateIsFrozen(db, existing.id)) throw new Error("该生效日单价已被确认工资单锁定，只能新增一条更晚生效的单价");
      existing.price = r2(price);
      return existing;
    }
    var id = "r" + (db.rates.length + 1) + "_" + idTail();
    var rec = { id: id, processKey: input.processKey, from: input.from, price: r2(price) };
    db.rates.push(rec);
    return rec;
  }
  function rateIsFrozen(db, rateId) {
    return db.sheets.some(function (s) {
      return s.status === "confirmed" && s.frozen && s.frozen.rates.some(function (r) { return r.id === rateId; });
    });
  }

  function setShift(db, input) {
    var name = (input.name || "").trim();
    if (!name) throw new Error("班次名称必填");
    hm(input.start); hm(input.end);
    var allowance = Number(input.allowance) || 0;
    if (allowance < 0) throw new Error("班次津贴不能为负");
    var candidate = { name: name, start: input.start, end: input.end };
    var clash = db.shifts.find(function (x) {
      return x.id !== input.id && shiftsOverlap(candidate, x);
    });
    if (clash) {
      throw new Error("班次「" + name + "」与已有班次「" + clash.name + "」时段重叠，保存会导致同一工时重复命中，请先调整边界");
    }
    if (input.id) {
      var sh = db.shifts.filter(function (x) { return x.id === input.id; })[0];
      if (!sh) throw new Error("班次不存在");
      if (shiftIsFrozen(db, sh.id)) throw new Error("该班次已被确认工资单引用并锁定，不能修改；请新增一个班次");
      sh.name = name; sh.start = input.start; sh.end = input.end; sh.allowance = r2(allowance);
      return sh;
    }
    var id = "s" + (db.shifts.length + 1) + "_" + idTail();
    var rec = { id: id, name: name, start: input.start, end: input.end, allowance: r2(allowance) };
    db.shifts.push(rec);
    return rec;
  }
  function shiftIsFrozen(db, id) {
    return db.sheets.some(function (s) {
      return s.status === "confirmed" && s.frozen && s.frozen.shifts.some(function (x) { return x.id === id; });
    });
  }

  function toggleHoliday(db, date) {
    parseDate(date);
    var i = db.holidays.indexOf(date);
    if (i >= 0) {
      if (holidayIsFrozen(db, date)) {
        throw new Error(date + " 已被确认工资单引用并锁定，不能取消；如需更正请在该单上开调整单");
      }
      db.holidays.splice(i, 1);
    } else db.holidays.push(date);
    db.holidays.sort();
  }
  // 是否有已确认单在其计薪日期上实际用到该节假日
  function holidayIsFrozen(db, date) {
    return db.sheets.some(function (s) {
      return s.status === "confirmed" && s.frozen && s.frozen.holidays.indexOf(date) >= 0;
    });
  }

  /* ---------- 导出 / 导入复核 ---------- */

  // 32 位 FNV-1a，纯字符串实现，浏览器与 node 结果一致
  function checksum(obj) {
    var str = typeof obj === "string" ? obj : stableStringify(obj);
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return ("0000000" + hash.toString(16)).slice(-8);
  }
  function stableStringify(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    var keys = Object.keys(v).sort();
    return "{" + keys.map(function (k) { return JSON.stringify(k) + ":" + stableStringify(v[k]); }).join(",") + "}";
  }

  function exportBundle(db, pattern) {
    var payload = {
      app: "brocade-settlement",
      exportedAt: newISO(),
      data: db,
      pattern: pattern || null
    };
    var c = checksum(payload);
    return { payload: payload, checksum: c, file: JSON.stringify({ v: 1, payload: payload, checksum: c }, null, 2) };
  }

  // 导入：校验结构与校验和；对每张单重算并与冻结值逐分核对
  function importBundle(text) {
    var bundle;
    try { bundle = JSON.parse(text); } catch (e) { throw new Error("文件不是有效的 JSON"); }
    if (!bundle || bundle.v !== 1 || !bundle.payload || bundle.payload.app !== "brocade-settlement") {
      throw new Error("文件不是本结算台导出的台账");
    }
    var data = bundle.payload.data;
    if (!data || !Array.isArray(data.sheets) || !Array.isArray(data.rates)) throw new Error("台账内容不完整");
    var expectC = checksum(bundle.payload);
    if (expectC !== bundle.checksum) throw new Error("校验和不一致：文件可能被改动或损坏");

    var report = auditData(data);
    return { data: data, pattern: bundle.payload.pattern || null, report: report, checksum: bundle.checksum };
  }

  // 对整库做复核；draft 用当前规则严格重算；
  // confirmed 始终按其冻结规则以 legacy 模式重算（不套用升级后的新录入规则）并逐分比对。
  function auditData(db) {
    var lines = [];
    db.sheets.forEach(function (sheet) {
      var row = { id: sheet.id, status: sheet.status, ok: true, errors: [], warnings: [] };
      try {
        if (sheet.status === "confirmed" && sheet.frozen) {
          // 先检查冻结结果自身的算术一致性（与重算规则无关）
          var ft = sheet.frozen.result.totals;
          var expectGross = r2(r2(ft.piecePay) + r2(ft.reworkPay) + r2(ft.overtimePay) + r2(ft.allowance));
          var expectNet = r2(r2(ft.gross) - r2(ft.advance) - r2(ft.otherDeduction));
          if (expectGross !== r2(ft.gross)) { row.ok = false; row.errors.push("冻结应发合计内部不平：" + ft.gross + " ≠ 分项合计 " + expectGross); }
          if (expectNet !== r2(ft.net)) { row.ok = false; row.errors.push("冻结实发内部不平：" + ft.net + " ≠ 应发-预支-扣款 " + expectNet); }

          // 用冻结的规则在一份临时库上、以 legacy 语义重算（旧版跨月加班/相同时刻单按当时规则复算）
          var tmp = clone(db);
          tmp.rates = clone(sheet.frozen.rates);
          tmp.shifts = clone(sheet.frozen.shifts);
          tmp.holidays = sheet.frozen.holidays.slice();
          tmp.holidayMultiplier = sheet.frozen.holidayMultiplier;
          tmp.overtimeRate = sheet.frozen.overtimeRate;
          tmp.plan = sheet.frozen.plan ? clone(sheet.frozen.plan) : null;
          var recalced = calcSheet(tmp, sheet, { strict: false });
          var frozen = sheet.frozen.result.totals;
          var now = recalced.totals;
          ["piecePay", "reworkPay", "overtimePay", "allowance", "gross", "advance", "otherDeduction", "net"].forEach(function (f) {
            if (r2(frozen[f]) !== r2(now[f])) {
              row.ok = false;
              row.errors.push("冻结 " + f + "=" + frozen[f] + " 与重算 " + now[f] + " 不一致");
            }
          });
          var netWithAdj = currentNet(db, sheet);
          row.net = netWithAdj;
          row.frozenNet = frozen.net;
          if (netWithAdj < 0) { row.ok = false; row.errors.push("含调整单后实发为负"); }
        } else if (sheet.status === "draft") {
          // 草稿（含旧版遗留草稿）仍按当前严格规则重算，引导用户修正后再确认
          var live = calcSheet(db, sheet);
          row.net = live.totals.net;
          row.errors.push("（草稿）当前重算净额 " + live.totals.net);
        }
      } catch (e) {
        row.ok = false;
        row.errors.push(e.message);
      }
      lines.push(row);
    });
    return {
      ok: lines.every(function (l) { return l.ok; }),
      sheets: lines,
      adjustments: db.adjustments.length
    };
  }

  /* ---------- 杂项 ---------- */

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function newISO() { return new Date().toISOString(); }

  var api = {
    r2: r2, pad: pad,
    parseDate: parseDate, dateStr: dateStr, addDays: addDays, todayStr: todayStr,
    daysBetween: daysBetween, minDate: minDate, dayOrd: dayOrd,
    CORE_PROCESSES: CORE_PROCESSES, CORE_KEYS: CORE_KEYS, meta: meta,
    defaultData: defaultData, generatePlan: generatePlan, planQty: planQty,
    rateAt: rateAt, splitSegments: splitSegments, calcEntry: calcEntry,
    calcSheet: calcSheet, confirmSheet: confirmSheet,
    addAdjustment: addAdjustment, currentNet: currentNet, sheetAdjustments: sheetAdjustments,
    addSheet: addSheet, updateDraft: updateDraft, addEntry: addEntry,
    removeEntry: removeEntry, removeSheet: removeSheet,
    addWeaver: addWeaver, setRate: setRate, setShift: setShift,
    toggleHoliday: toggleHoliday, holidayIsFrozen: holidayIsFrozen,
    rateIsFrozen: rateIsFrozen, shiftIsFrozen: shiftIsFrozen,
    checksum: checksum, exportBundle: exportBundle, importBundle: importBundle,
    auditData: auditData, clone: clone
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Payroll = api;
})(typeof window !== "undefined" ? window : globalThis);
