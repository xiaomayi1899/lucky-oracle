/* 数理投票 · 前端应用 */
(function () {
  "use strict";

  var C = window.OracleCore;
  var S = window.OracleSchools;
  if (!C || !S) { document.getElementById("hero").innerHTML = '<div class="hero-skeleton">引擎加载失败</div>'; return; }

  var DATA_URL = "data/lottery.json";
  var REFRESH_MS = 60 * 1000;
  var LS_DATA = "oracle.data.v2";
  var LS_GAME = "oracle.game.v2";
  var WINDOW = 100;

  var state = {
    game: "ssq",
    data: null,
    ctx: null,
    rec: null,
    voteTarget: "main",
    trendTarget: "main",
    backtest: null,
    backtestBusy: false,
    showAllVotes: false,
    weights: null,
    track: null,
    optimizing: false,
    optResult: null,
    fetching: false,
    updated: "",
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function two(n) { return C.pad(n); }

  function fmtVote(x) {
    var n = Number(x) || 0;
    return Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(1);
  }

  /* ---------- 存储 ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  /* ---------- 数据 ---------- */
  function loadData() {
    if (state.fetching) return;
    state.fetching = true;
    fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (json) {
        applyData(json);
        var cached = JSON.stringify(json);
        if (cached.length < 4 * 1024 * 1024) lsSet(LS_DATA, cached);
      })
      .catch(function (err) {
        var cached = lsGet(LS_DATA);
        if (cached && !state.data) {
          try { applyData(JSON.parse(cached)); } catch (e) { /* ignore */ }
        }
        setStatus("数据获取失败：" + err.message + "（正在用缓存/稍后重试）");
      })
      .then(function () { state.fetching = false; });
  }

  function applyData(json) {
    var first = !state.data;
    var changed = !state.data || state.data.updated !== json.updated;
    state.data = json;
    state.updated = json.updated || "";
    if (changed) {
      compute();
      renderAll();
    } else if (first) {
      renderAll();
    }
    setStatus(json.updated ? "数据更新时间：" + fmtDateTime(json.updated) : "数据已加载");
  }

  function compute() {
    var g = C.GAMES[state.game];
    var gameData = state.data && state.data.games && state.data.games[state.game];
    if (!gameData || !gameData.draws || gameData.draws.length < 25) {
      state.ctx = null; state.rec = null;
      return;
    }
    try {
      state.ctx = C.buildContext(g, gameData.draws, WINDOW);
      state.rec = S.recommend(state.ctx, { weights: state.weights });
      state.backtest = null;
    } catch (e) {
      state.ctx = null; state.rec = null;
      setStatus("计算失败：" + e.message);
    }
  }

  /* ---------- 时间 ---------- */
  function fmtDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
      " " + two(d.getHours()) + ":" + two(d.getMinutes());
  }

  function bjOf(ms) { return new Date(ms + 8 * 3600 * 1000); }

  function nextDrawTime(schedule, nowMs) {
    for (var add = 0; add <= 8; add++) {
      var base = bjOf(nowMs);
      var candBj = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + add,
        schedule.hour, schedule.minute, 0);
      var dow = new Date(candBj).getUTCDay();
      if (schedule.days.indexOf(dow) < 0) continue;
      var candUtc = candBj - 8 * 3600 * 1000;
      if (candUtc > nowMs + 30 * 1000) return candUtc;
    }
    return null;
  }

  function fmtLeft(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    return (d > 0 ? d + " 天 " : "") + two(h) + ":" + two(m) + ":" + two(s);
  }

  /* ---------- 格式化 ---------- */
  function fmtMoney(n) {
    if (!n) return "—";
    if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
    if (n >= 1e4) return (n / 1e4).toFixed(0) + " 万";
    return n + " 元";
  }

  function fmtIssue(g, issue) {
    return issue || "—";
  }

  function dowName(days) {
    var names = ["日", "一", "二", "三", "四", "五", "六"];
    return "周" + days.map(function (d) { return names[d]; }).join("、");
  }

  function setStatus(text) {
    var s = $("status");
    if (s) s.textContent = text;
  }

  function toast(text) {
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("show"); });
    setTimeout(function () {
      t.classList.remove("show");
      setTimeout(function () { t.remove(); }, 300);
    }, 1600);
  }

  /* ---------- 渲染：顶栏 ---------- */
  function renderTabs() {
    var box = $("gameTabs");
    box.innerHTML = C.GAME_ORDER.map(function (gid) {
      var g = C.GAMES[gid];
      return '<button role="tab" data-game="' + gid + '" aria-selected="' + (gid === state.game) + '">' + esc(g.name) + "</button>";
    }).join("");
    box.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        var gid = b.getAttribute("data-game");
        if (gid === state.game) return;
        state.game = gid;
        state.voteTarget = "main";
        state.trendTarget = "main";
        lsSet(LS_GAME, gid);
        document.body.setAttribute("data-game", gid);
        state.weights = loadWeights(gid);
        state.optResult = null;
        try { state.ctx = null; state.rec = null; state.backtest = null; compute(); } catch (e) { /* ignore */ }
        renderAll();
      });
    });
  }

  /* ---------- 渲染：最新开奖 ---------- */
  function renderHero() {
    var box = $("hero");
    var g = C.GAMES[state.game];
    var gameData = state.data && state.data.games && state.data.games[state.game];
    if (!gameData || !gameData.draws || !gameData.draws.length) {
      box.innerHTML = '<div class="hero-skeleton">暂无开奖数据</div>';
      return;
    }
    var d = gameData.draws[0];
    var main = (d[g.keyMain] || []).slice().sort(function (a, b) { return a - b; });
    var spec = g.specialCount > 0 ? (d[g.keySpecial] || []).slice().sort(function (a, b) { return a - b; }) : [];

    var balls = main.map(function (n) { return '<span class="ball">' + n + "</span>"; }).join("");
    if (spec.length) {
      balls += '<span class="ball-split"></span>' +
        spec.map(function (n) { return '<span class="ball special">' + n + "</span>"; }).join("");
    }

    state.nextDraw = nextDrawTime(g.schedule, Date.now());
    var left = state.nextDraw ? fmtLeft(state.nextDraw - Date.now()) : "—";

    box.innerHTML =
      '<div class="hero-top">' +
        '<div class="issue">' +
          '<span class="no">' + esc(fmtIssue(g, d.issue)) + '</span>' +
          '<span class="date">' + esc(d.date || "") + " " + esc(dowName([new Date(d.date + "T00:00:00Z").getUTCDay()])) + '</span>' +
        "</div>" +
        '<div class="pool">' +
          '<span class="num">' + esc(fmtMoney(d.pool)) + "</span>" +
          "<small>奖池滚存</small>" +
        "</div>" +
      "</div>" +
      '<div class="balls">' + balls + "</div>" +
      '<div class="vote-legend"><span>' + esc(g.mainLabel) + " " + main.length + " 个 · " +
        esc(g.specialLabel) + " " + spec.length + " 个</span>" +
        "<span>距下期开奖 <b id=\"countdown\">" + esc(left) + "</b>（" + esc(dowName(g.schedule.days)) + " 21:" + two(g.schedule.minute) + "）</span></div>";
  }

  /* 基于真实销量与一等奖注数的拥挤度估算 */
  function crowdInfo(gid, nums) {
    var M = window.OracleCrowd && window.OracleCrowd[gid];
    if (!M || !nums || !nums.length) return null;
    var small = 0;
    for (var i = 0; i < nums.length; i++) if (nums[i] <= M.smallCut) small++;
    var row = M.bySmall[String(small)] || null;
    var base = M.avgSales / 2 / M.combo;
    return {
      small: small, cut: M.smallCut,
      crowd: row ? row.crowd : 1,
      n: row ? row.n : 0,
      avgN: row ? row.avgN : 0,
      avgMoney: row ? row.avgMoney : M.avgMoney,
      expected: row ? base * row.crowd : base,
      base: base,
      median: M.overall.median,
      worst: M.worstCase,
    };
  }

  /* ---------- 渲染：推荐 ---------- */
  function ballHtml(n, votes, special, small) {
    return '<span class="ball' + (special ? " special" : "") + (small ? " small" : "") + '">' + n +
      (votes !== undefined ? '<span class="vt">' + fmtVote(votes) + "</span>" : "") + "</span>";
  }

  function renderPick() {
    var box = $("pickBody");
    var meta = $("pickMeta");
    var g = C.GAMES[state.game];
    var rec = state.rec;
    if (!rec) {
      box.innerHTML = '<div class="muted">数据不足，暂时无法计算。</div>';
      meta.textContent = "—";
      return;
    }

    var mainVotes = rec.main.votes;
    var specVotes = rec.special ? rec.special.votes : null;

    function row(label, alt, mainNums, specNums, votes, tagClass) {
      var html = '<div class="pick-row' + (alt ? " alt-row" : "") + '">' +
        '<div class="pick-label">' +
          '<span class="tag' + (alt ? " alt" : "") + '">' + label + "</span>" +
          '<span class="sumline">合计 ' + fmtVote(votes) + " 票 · " +
            mainNums.length + (g.specialCount > 0 ? "+" + specNums.length : "") + "</span>" +
        "</div>" +
        '<div class="balls">' +
          mainNums.map(function (n) { return ballHtml(n, mainVotes[n]); }).join("") +
          (specNums.length ? '<span class="ball-split"></span>' +
            specNums.map(function (n) { return ballHtml(n, specVotes ? specVotes[n] : undefined, true); }).join("") : "") +
        "</div></div>";
      return html;
    }

    var html = "";
    html += row("最终一注", false, rec.main.primary, rec.special ? rec.special.primary : [],
      rec.main.primaryVotes + (rec.special ? rec.special.primaryVotes : 0));
    if (rec.main.alt && rec.main.alt.length) {
      html += row("备选一注", true, rec.main.alt, rec.special ? rec.special.alt : [],
        rec.main.altVotes + (rec.special ? rec.special.altVotes : 0));
    }

    var maxV = rec.main.maxVotes || 1;
    html += '<div class="pick-note">' +
      esc(g.mainLabel) + "最高 " + fmtVote(maxV) + " 票 · " + rec.main.modelCount + " 个公式归并成 " +
      rec.main.clusterCount + " 个独立观点" + (state.weights ? "并按优化权重计票" : "、每组一票") +
      "，共 " + fmtVote(rec.main.totalVotes) + " 票" +
      (rec.special ? "；" + esc(g.specialLabel) + " " + rec.special.clusterCount + " 个观点共 " +
        fmtVote(rec.special.totalVotes) + " 票" : "") +
      "。票数相同按归一化总分排序。</div>";

    var ci = crowdInfo(state.game, rec.main.primary);
    if (ci) {
      var cls = ci.crowd < 0.95 ? "ok" : (ci.crowd > 1.05 ? "warnc" : "");
      html += '<div class="riskline">' +
        "本注含 <b>" + ci.small + "</b> 个小号（≤" + ci.cut + "）。历史同形态 " + ci.n + " 期：平均 <b class=\"" +
        cls + "\">" + ci.avgN + "</b> 注同时中奖，单注约 <b>" + (ci.avgMoney / 1e4).toFixed(0) +
        " 万</b>（均匀基准 " + ci.base.toFixed(1) + " 注）" +
        '<small>撞号只影响奖金分摊，不改变中奖率。极端案例：' + esc(ci.worst.issue) + " 期开出 " +
        ci.worst.nums.map(function (n) { return two(n); }).join(" ") + "，" +
        ci.worst.n + " 注同中（" + ci.worst.crowd + "×）。</small></div>";
    }

    html += '<div class="pick-actions">' +
      '<button class="btn primary" id="copyBtn">复制号码</button>' +
      '<button class="btn" id="recalcBtn">按最新数据重算</button>' +
      "</div>";

    box.innerHTML = html;
    meta.textContent = rec.totalModels + " 个公式 · " + fmtVote(rec.totalVotes) + " 票";

    $("copyBtn").addEventListener("click", function () {
      var text = formatCopy(rec, g);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast("已复制：" + text); },
          function () { fallbackCopy(text); });
      } else {
        fallbackCopy(text);
      }
    });
    $("recalcBtn").addEventListener("click", function () {
      compute();
      renderAll();
      toast("已按最新开奖数据重新投票");
    });
  }

  function formatCopy(rec, g) {
    var m = rec.main.primary.map(function (n) { return two(n); }).join(" ");
    var s = rec.special ? rec.special.primary.map(function (n) { return two(n); }).join(" ") : "";
    return g.name + "：" + m + (s ? " | " + s : "");
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("已复制：" + text); }
    catch (e) { toast("复制失败，请长按选择"); }
    ta.remove();
  }

  /* ---------- 渲染：投票分布 ---------- */
  function renderVotes() {
    var box = $("voteBody");
    var seg = $("voteSeg");
    var rec = state.rec;
    var g = C.GAMES[state.game];
    if (!rec) { box.innerHTML = '<div class="muted">—</div>'; seg.innerHTML = ""; return; }

    var hasSpecial = !!rec.special;
    seg.innerHTML = '<button data-t="main" aria-selected="' + (state.voteTarget === "main") + '">' + esc(g.mainLabel) + "</button>" +
      (hasSpecial ? '<button data-t="special" aria-selected="' + (state.voteTarget === "special") + '">' + esc(g.specialLabel) + "</button>" : "");
    seg.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        state.voteTarget = b.getAttribute("data-t");
        renderVotes();
      });
    });

    var target = state.voteTarget === "special" && rec.special ? rec.special : rec.main;
    var isSpecial = target === rec.special;
    var picked = target.primary;
    var max = 1;
    target.sorted.forEach(function (x) { if (x.votes > max) max = x.votes; });

    var list = state.showAllVotes ? target.sorted : target.sorted.slice(0, 15);
    var rows = list.map(function (x, i) {
      var pct = Math.max(2, (x.votes / max) * 100);
      var cls = "vote-item" + (picked.indexOf(x.n) >= 0 ? " picked" : "") + (i === 0 ? " top1" : "");
      return '<div class="' + cls + '">' +
        '<span class="vote-no">' + two(x.n) + "</span>" +
        '<span class="vote-bar"><span class="vote-fill' + (isSpecial ? " special" : "") + '" style="width:' + pct.toFixed(1) + '%"></span></span>' +
        '<span class="vote-count">' + fmtVote(x.votes) + " 票</span>" +
        "</div>";
    }).join("");

    var more = "";
    if (target.sorted.length > 15) {
      more = '<button class="btn" id="voteMore" style="width:100%;margin-top:10px">' +
        (state.showAllVotes ? "收起，只看前 15 名" : "显示全部 " + target.sorted.length + " 个号码") + "</button>";
    }
    box.innerHTML = '<div class="vote-list">' + rows + "</div>" + more +
      '<div class="vote-legend"><span>★ = 该区票数第一</span><span>高亮 = 已入选推荐</span></div>';
    var mb = $("voteMore");
    if (mb) mb.addEventListener("click", function () {
      state.showAllVotes = !state.showAllVotes;
      renderVotes();
    });
  }

  /* ---------- 渲染：学科明细 ---------- */
  function renderSchools() {
    var box = $("schoolBody");
    var meta = $("schoolMeta");
    var rec = state.rec;
    if (!rec) { box.innerHTML = '<div class="muted">—</div>'; meta.textContent = "—"; return; }

    var pickedMain = rec.main.primary;
    var pickedSpec = rec.special ? rec.special.primary : [];

    var bySchool = {};
    S.SCHOOL_ORDER.forEach(function (sid) { bySchool[sid] = { main: [], special: [] }; });
    rec.main.models.forEach(function (m) { bySchool[m.school].main.push(m); });
    if (rec.special) rec.special.models.forEach(function (m) { bySchool[m.school].special.push(m); });

    var html = '<div class="school-list">';
    S.SCHOOL_ORDER.forEach(function (sid) {
      var sch = S.SCHOOLS[sid];
      var bucket = bySchool[sid];
      var models = bucket.main.concat(bucket.special);
      var stat = rec.schoolStats[sid] || { main: 0, special: 0 };
      var votesIn = stat.main + stat.special;
      html += '<details class="school" data-school="' + sid + '">' +
        '<summary class="school-head">' +
          '<span class="school-dot" style="background:' + sch.color + '"></span>' +
          '<span class="school-name">' + esc(sch.name) + "</span>" +
          '<span class="school-desc">' + esc(sch.desc) + "</span>" +
          '<span class="school-count">' + models.length + " 式 · " + votesIn + " 票</span>" +
          '<span class="school-arrow">▶</span>' +
        "</summary>" +
        '<div class="school-body">' +
          '<div class="school-desc-full">' + esc(sch.desc) + "</div>" +
          models.map(function (m) { return modelRow(m, pickedMain, pickedSpec); }).join("") +
        "</div></details>";
    });
    html += "</div>";

    box.innerHTML = html;
    meta.textContent = rec.main.clusterCount + " + " + (rec.special ? rec.special.clusterCount : 0) + " 个独立观点";
  }

  function modelRow(m, pickedMain, pickedSpec) {
    var isSpecial = m.id.indexOf("_sp_") >= 0;
    var picked = isSpecial ? pickedSpec : pickedMain;
    var chips = m.top.map(function (n) {
      var on = picked.indexOf(n) >= 0;
      return '<span class="chip' + (on ? " on" : "") + (isSpecial ? " special" : "") + '">' + two(n) + "</span>";
    }).join("");
    return '<div class="model-row">' +
      '<div class="model-top">' +
        '<span class="model-name">' + esc(m.name) +
          '<span class="wtag" style="display:' + (Math.abs(m.weight - 1) > 1e-9 ? "inline-block" : "none") + '">×' +
          (Math.round(m.weight * 100) / 100) + "</span>" +
          '<span class="gtag" style="display:' + (m.cluster > 1 ? "inline-block" : "none") + '">同组 ' + m.cluster + "</span></span>" +
        '<span class="model-hits">' + chips + "</span>" +
      "</div>" +
      '<div class="model-formula">' + esc(m.formula) + "</div>" +
      "</div>";
  }

  /* ---------- 渲染：走势矩阵 ---------- */
  function renderTrend() {
    var box = $("trendBody");
    var seg = $("trendSeg");
    var g = C.GAMES[state.game];
    var gameData = state.data && state.data.games && state.data.games[state.game];
    if (!gameData || !gameData.draws) { box.innerHTML = '<div class="muted">—</div>'; return; }

    seg.innerHTML = '<button data-t="main" aria-selected="' + (state.trendTarget === "main") + '">' + esc(g.mainLabel) + "</button>" +
      '<button data-t="special" aria-selected="' + (state.trendTarget === "special") + '">' + esc(g.specialLabel) + "</button>";
    seg.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { state.trendTarget = b.getAttribute("data-t"); renderTrend(); });
    });

    var isSpecial = state.trendTarget === "special";
    var min = isSpecial ? g.specialMin : g.mainMin;
    var max = isSpecial ? g.specialMax : g.mainMax;
    var key = isSpecial ? g.keySpecial : g.keyMain;
    var draws = gameData.draws.slice(0, 30);

    var head = "<tr><th></th>";
    for (var n = min; n <= max; n++) head += "<th>" + (n % 5 === 0 || n === min ? n : "") + "</th>";
    head += "</tr>";

    var rows = draws.map(function (d, idx) {
      var set = {};
      var arr = d[key] || [];
      for (var i = 0; i < arr.length; i++) set[arr[i]] = 1;
      var tds = "";
      for (var v = min; v <= max; v++) {
        tds += '<td class="' + (set[v] ? (isSpecial ? "sp" : "on") : "") + '"></td>';
      }
      return '<tr class="' + (idx < 5 ? "recent" : "old") + '"><td class="lbl">' + esc(String(d.issue).slice(-3)) + "</td>" + tds + "</tr>";
    }).join("");

    box.innerHTML = '<div class="matrix-wrap"><table class="matrix">' + head + rows + "</table></div>" +
      '<div class="matrix-legend">' +
        '<span><i style="background:' + (isSpecial ? "var(--special)" : "var(--accent)") + '"></i>开出</span>' +
        '<span><i style="background:var(--bg2);border:1px solid var(--line)"></i>未开</span>' +
        "<span>上半部分较新（最近 5 期）</span>" +
      "</div>";
  }

  /* ---------- 回测 ---------- */
  function runBacktest() {
    if (state.backtestBusy) return;
    if (!state.ctx || !state.data) return;
    var g = C.GAMES[state.game];
    var gameData = state.data.games[state.game];
    var periods = 100;
    if (gameData.draws.length < WINDOW + periods + 2) periods = Math.max(5, gameData.draws.length - WINDOW - 2);

    state.backtestBusy = true;
    var btn = $("backtestBtn");
    btn.disabled = true;
    var body = $("backtestBody");
    body.innerHTML = '<div class="muted">正在回放 ' + periods + " 期…</div>";

    var rows = [];
    var i = 0;

    function step() {
      var t0 = performance.now();
      while (i < periods && performance.now() - t0 < 60) {
        var history = gameData.draws.slice(i + 1);
        var ctx = C.buildContext(g, history, WINDOW);
        var rec = S.recommend(ctx, { weights: state.weights });
        var actual = gameData.draws[i];
        var actualMain = (actual[g.keyMain] || []).slice().sort(function (a, b) { return a - b; });
        var actualSpec = g.specialCount > 0 ? (actual[g.keySpecial] || []).slice().sort(function (a, b) { return a - b; }) : [];
        rows.push({
          issue: actual.issue,
          date: actual.date,
          mainHit: S.hitCount(rec.main.primary, actualMain),
          specHit: g.specialCount > 0 ? S.hitCount(rec.special.primary, actualSpec) : 0,
          pickMain: rec.main.primary,
          pickSpec: rec.special ? rec.special.primary : [],
          actualMain: actualMain,
          actualSpec: actualSpec,
        });
        i++;
      }
      if (i < periods) {
        body.innerHTML = '<div class="muted">正在回放 ' + i + " / " + periods + " 期…</div>" +
          '<progress max="' + periods + '" value="' + i + '"></progress>';
        setTimeout(step, 0);
      } else {
        state.backtestBusy = false;
        btn.disabled = false;
        state.backtest = rows;
        renderBacktest();
      }
    }
    setTimeout(step, 0);
  }

  function renderBacktest() {
    var body = $("backtestBody");
    var rows = state.backtest;
    var g = C.GAMES[state.game];
    if (!rows || !rows.length) {
      body.innerHTML = '<div class="muted">用同一套公式，回放历史每一期，看看命中几个。回测不改变未来概率。</div>';
      return;
    }
    var sumMain = 0, sumSpec = 0, maxMain = 0;
    rows.forEach(function (r) {
      sumMain += r.mainHit; sumSpec += r.specHit;
      if (r.mainHit > maxMain) maxMain = r.mainHit;
    });
    var avgMain = (sumMain / rows.length).toFixed(2);
    var avgSpec = (sumSpec / rows.length).toFixed(2);
    /* 固定号码对照：每期都买最小的一注 */
    var fixedPick = [];
    for (var fv = g.mainMin; fv < g.mainMin + g.mainCount; fv++) fixedPick.push(fv);
    var fixedSum = 0;
    rows.forEach(function (r) { fixedSum += S.hitCount(fixedPick, r.actualMain); });
    var fixedAvg = (fixedSum / rows.length).toFixed(2);
    var fixedLabel = two(g.mainMin) + "-" + two(g.mainMin + g.mainCount - 1);
    /* 纯随机期望：k 个号中命中的期望 = k * k / 池大小 */
    var randMain = (g.mainCount * g.mainCount / g.mainMax).toFixed(2);
    var randSpec = g.specialCount > 0 ? (g.specialCount * g.specialCount / g.specialMax).toFixed(2) : "—";

    var html = '<div class="bt-grid">' +
      '<div class="bt-cell"><div class="v">' + avgMain + '</div><div class="k">' + esc(g.mainLabel) + "平均命中</div></div>" +
      '<div class="bt-cell"><div class="v">' + maxMain + '</div><div class="k">' + esc(g.mainLabel) + "最好成绩</div></div>" +
      (g.specialCount > 0 ? '<div class="bt-cell"><div class="v">' + avgSpec + '</div><div class="k">' + esc(g.specialLabel) + "平均命中</div></div>" : "") +
      "</div>";
    html += '<div class="muted" style="margin-bottom:10px">' +
      "共 " + rows.length + " 期。纯随机期望 " + randMain +
      " · 固定买 " + fixedLabel + " 号 " + fixedAvg +
      " · 本推荐 " + avgMain +
      "。" + (Math.abs(parseFloat(fixedAvg) - parseFloat(avgMain)) <= 0.05
        ? "本推荐和固定买号几乎一样——这说明公式没有带来额外优势。"
        : "本推荐与固定买号有差异，但差异在随机波动范围内，不能说明更准。") +
      "</div>";

    html += '<div class="bt-rows">';
    rows.forEach(function (r) {
      var nums = r.actualMain.map(function (n) {
        return '<span class="mini' + (r.pickMain.indexOf(n) >= 0 ? " on" : "") + '">' + two(n) + "</span>";
      }).join("");
      var sp = r.actualSpec.map(function (n) {
        return '<span class="mini sp' + (r.pickSpec.indexOf(n) >= 0 ? " on" : "") + '">' + two(n) + "</span>";
      }).join("");
      html += '<div class="bt-row">' +
        '<span class="iss">' + esc(String(r.issue).slice(-6)) + "</span>" +
        '<span class="nums">' + nums + (sp ? " ｜ " + sp : "") + "</span>" +
        '<span class="hit' + (r.mainHit === 0 ? " zero" : "") + '">中 ' + r.mainHit + "</span>" +
        "</div>";
    });
    html += "</div>";
    body.innerHTML = html;
  }

  /* ---------- 实盘战绩 ---------- */
  function loadTrack() {
    fetch("data/track.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) { state.track = j; renderTrack(); } })
      .catch(function () { renderTrack(); });
  }

  function trackStats(list) {
    if (!list.length) return null;
    var sum = 0, max = 0;
    list.forEach(function (r) { sum += r.mainHit; if (r.mainHit > max) max = r.mainHit; });
    return { n: list.length, avg: sum / list.length, max: max };
  }

  function renderTrack() {
    var body = $("trackBody");
    var meta = $("trackMeta");
    if (!body) return;
    var g = C.GAMES[state.game];
    var t = state.track;
    if (!t || !t.games || !t.games[state.game]) {
      if (meta) meta.textContent = "—";
      body.innerHTML = '<div class="muted">等待第一份记录…</div>';
      return;
    }
    var b = t.games[state.game];
    var records = (b.records || []).slice();
    var fwd = records.filter(function (r) { return !r.backfilled; });
    var back = records.filter(function (r) { return r.backfilled; });
    var sf = trackStats(fwd), sb = trackStats(back);

    if (meta) meta.textContent = fwd.length + " 期前瞻 · " + back.length + " 期回补";

    var html = "";

    /* 下期待开：开奖前就锁定 */
    if (b.pending) {
      var pn = b.pending;
      html += '<div class="pending-box">' +
        '<div class="pending-label">下期待开 ' + esc(pn.forIssue) + " · 已锁定</div>" +
        '<div class="balls">' +
          pn.pick.map(function (n) { return '<span class="ball small">' + two(n) + "</span>"; }).join("") +
          (pn.special && pn.special.length ? '<span class="ball-split"></span>' +
            pn.special.map(function (n) { return '<span class="ball small special">' + two(n) + "</span>"; }).join("") : "") +
        "</div>" +
        '<div class="pending-note">基于 ' + esc(pn.basedOnIssue) + " 期开奖后生成" +
        (pn.generatedAt ? "（" + esc(fmtDateTime(pn.generatedAt)) + "）" : "") +
        "。开奖后自动比对，写入下方的哈希链。</div>" +
        "</div>";
    }

    /* 前瞻统计 */
    if (sf) {
      html += '<div class="bt-grid">' +
        '<div class="bt-cell"><div class="v">' + sf.n + '</div><div class="k">前瞻记录</div></div>' +
        '<div class="bt-cell"><div class="v">' + sf.avg.toFixed(2) + '</div><div class="k">平均命中</div></div>' +
        '<div class="bt-cell"><div class="v">' + sf.max + '</div><div class="k">最好成绩</div></div>' +
        "</div>";
    } else {
      html += '<div class="muted" style="margin-bottom:12px">还没有前瞻记录。' +
        "从下一期（" + esc(b.pending ? b.pending.forIssue : "待开") + "）开始，每期开奖前锁定推荐，开奖后自动比对，累积成不可篡改的战绩。</div>";
    }

    /* 回补说明 */
    if (sb) {
      html += '<div class="muted" style="margin-bottom:10px">另有 ' + sb.n + " 期回补记录（部署前用历史数据回算，平均命中 " +
        sb.avg.toFixed(2) + "，仅作参考，不计入前瞻战绩）。</div>";
    }

    /* 最近记录 */
    if (records.length) {
      html += '<div class="bt-rows">';
      records.slice(0, 10).forEach(function (r) {
        var nums = (r.actualMain || []).map(function (n) {
          var hit = (r.pick || []).indexOf(n) >= 0;
          return '<span class="mini' + (hit ? " on" : "") + '">' + two(n) + "</span>";
        }).join("");
        var sp = (r.actualSpecial || []).map(function (n) {
          var hit = (r.special || []).indexOf(n) >= 0;
          return '<span class="mini sp' + (hit ? " on" : "") + '">' + two(n) + "</span>";
        }).join("");
        html += '<div class="bt-row">' +
          '<span class="iss">' + esc(String(r.issue).slice(-6)) +
            (r.backfilled ? ' <span class="dim">回</span>' : "") + "</span>" +
          '<span class="nums">' + nums + (sp ? " ｜ " + sp : "") + "</span>" +
          '<span class="hit' + (r.mainHit === 0 ? " zero" : "") + '">中 ' + r.mainHit + "</span>" +
          "</div>";
      });
      html += "</div>";
    }

    html += '<div class="track-chain">哈希链：' + esc(b.lastHash || "—") +
      " · 每条记录包含前一条的哈希，改动任意一期都会断链</div>";

    body.innerHTML = html;
  }

  /* ---------- 权重优化 ---------- */
  var OPT_TRAIN = 100;
  var OPT_VALID = 50;

  function weightsKey(gid) { return "oracle.weights." + gid; }

  function loadWeights(gid) {
    var raw = lsGet(weightsKey(gid));
    if (!raw) return null;
    try {
      var w = JSON.parse(raw);
      return w && typeof w === "object" ? w : null;
    } catch (e) { return null; }
  }

  function saveWeights(gid, w) {
    try { lsSet(weightsKey(gid), JSON.stringify(w)); } catch (e) { /* ignore */ }
    state.weights = w;
    compute();
    renderAll();
  }

  function clearWeights() {
    try { localStorage.removeItem(weightsKey(state.game)); } catch (e) { /* ignore */ }
    state.weights = null;
    compute();
    renderAll();
  }

  function setOptProgress(ratio, text) {
    var bar = $("optBar"), msg = $("optMsg");
    if (bar) bar.value = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    if (msg) msg.textContent = text;
  }

  function verdict(validUp, trainUp) {
    if (validUp > 1) {
      return "独立验证也提升了，说明这段时间里确实存在可复用的规律。但彩票每期独立，这不等于下一期更准。";
    }
    if (validUp < -1) {
      return "训练集提升 " + trainUp.toFixed(1) + "%，但独立验证下降了 " + Math.abs(validUp).toFixed(1) +
        "%。这是典型的过拟合：权重记住的是这 " + OPT_TRAIN + " 期的噪声，换一段历史就失效。" +
        "所以这套权重会让回测数字更好看，但不会提高真实中奖率。";
    }
    return "独立验证基本持平，说明这次调整既没有明显帮助，也没有明显伤害。";
  }

  function renderOpt() {
    var body = $("optBody");
    var meta = $("optMeta");
    if (!body) return;
    var g = C.GAMES[state.game];

    if (meta) meta.textContent = state.weights ? "已应用优化权重" : "等权 1.0×";

    if (state.optimizing) {
      body.innerHTML = '<div class="muted" id="optMsg">正在准备…</div>' +
        '<progress id="optBar" max="100" value="0"></progress>';
      return;
    }

    var r = state.optResult;
    if (!r) {
      body.innerHTML = '<div class="muted">用最近 ' + OPT_TRAIN +
        " 期，搜索让「加权票数前 " + g.mainCount + " 名」命中最多的公式权重。" +
        "优化会用前半 / 后半两折同时约束，避免只拟合某一段历史。</div>" +
        '<div class="pick-actions"><button class="btn primary" id="optRun">开始优化</button>' +
        (state.weights ? '<button class="btn" id="optReset">恢复等权</button>' : "") + "</div>";
      $("optRun").addEventListener("click", runOptimize);
      if ($("optReset")) $("optReset").addEventListener("click", clearWeights);
      return;
    }

    var trainUp = r.baseScore ? (r.tunedScore / r.baseScore - 1) * 100 : 0;
    var validUp = r.validBase ? (r.validTuned / r.validBase - 1) * 100 : 0;
    var applied = !!state.weights;

    body.innerHTML =
      '<div class="bt-grid">' +
        '<div class="bt-cell"><div class="v">' + r.baseScore.toFixed(2) + '</div><div class="k">训练集 等权</div></div>' +
        '<div class="bt-cell"><div class="v">' + r.tunedScore.toFixed(2) + '</div><div class="k">训练集 优化后</div></div>' +
        '<div class="bt-cell"><div class="v ' + (trainUp > 0 ? "ok" : "bad") + '">' +
          (trainUp > 0 ? "+" : "") + trainUp.toFixed(1) + '%</div><div class="k">训练集变化</div></div>' +
      "</div>" +
      '<div class="bt-grid">' +
        '<div class="bt-cell"><div class="v">' + r.validBase.toFixed(2) + '</div><div class="k">独立验证 等权</div></div>' +
        '<div class="bt-cell"><div class="v">' + r.validTuned.toFixed(2) + '</div><div class="k">独立验证 优化后</div></div>' +
        '<div class="bt-cell"><div class="v ' + (validUp > 0 ? "ok" : "bad") + '">' +
          (validUp > 0 ? "+" : "") + validUp.toFixed(1) + '%</div><div class="k">独立验证变化</div></div>' +
      "</div>" +
      '<div class="muted">训练集：最近 ' + r.trainN + " 期；独立验证：紧随其前的 " + r.validN +
      " 期，优化时完全没有使用。共调整 " + r.changed + " 个公式（上调 " + r.upweighted +
      "，下调 " + r.downweighted + "）。</div>" +
      '<p class="warn" style="margin-top:10px">' + verdict(validUp, trainUp) + "</p>" +
      '<div class="pick-actions">' +
        '<button class="btn ' + (applied ? "" : "primary") + '" id="optApply">' +
          (applied ? "重新应用" : "应用这套权重") + "</button>" +
        '<button class="btn" id="optReset">恢复等权</button>' +
      "</div>";

    $("optApply").addEventListener("click", function () {
      saveWeights(state.game, S.weightMap(r.modelIds, r.weights));
      toast("已应用优化权重，推荐号码已重算");
    });
    $("optReset").addEventListener("click", function () {
      clearWeights();
      toast("已恢复等权投票");
    });
  }

  function runOptimize() {
    if (state.optimizing || !state.data) return;
    var g = C.GAMES[state.game];
    var gameData = state.data.games[state.game];
    if (!gameData || !gameData.draws) return;
    var draws = gameData.draws;
    var win = WINDOW;
    var k = g.mainCount, poolMin = g.mainMin, size = g.mainMax - g.mainMin + 1;
    var trainN = Math.min(OPT_TRAIN, Math.max(10, draws.length - win - 2));
    var validN = Math.min(OPT_VALID, Math.max(0, draws.length - win - trainN - 2));

    state.optimizing = true;
    state.optResult = null;
    renderOpt();

    var train = [], valid = [], idx = 0, total = trainN + validN;

    function buildChunk() {
      var t0 = performance.now();
      while (performance.now() - t0 < 45) {
        if (idx >= total) { startSearch(); return; }
        var f = S.makeFrame(g, draws, win, idx);
        if (f) { if (idx < trainN) train.push(f); else valid.push(f); }
        idx++;
      }
      setOptProgress(idx / total * 0.5, "正在构建样本 " + idx + " / " + total + " 期…");
      setTimeout(buildChunk, 0);
    }

    function startSearch() {
      if (!train.length) { state.optimizing = false; renderOpt(); return; }
      var half = Math.floor(train.length / 2);
      var folds = [train.slice(0, half), train.slice(half)];
      var opt = S.createOptimizer(train, k, poolMin, size, { rounds: 2, folds: folds });
      if (!opt) { state.optimizing = false; renderOpt(); return; }

      function tick() {
        var t0 = performance.now();
        while (!opt.state.finished && performance.now() - t0 < 40) opt.stepOne();
        if (!opt.state.finished) {
          setOptProgress(0.5 + opt.progress() * 0.45, "正在搜索公式权重 " + Math.round(opt.progress() * 100) + "%…");
          setTimeout(tick, 0);
          return;
        }
        var res = opt.result();
        var ones = [];
        for (var i = 0; i < res.weights.length; i++) ones.push(1);
        res.validBase = valid.length ? S.evalFrames(valid, ones, k, poolMin, size) : 0;
        res.validTuned = valid.length ? S.evalFrames(valid, res.weights, k, poolMin, size) : 0;
        res.trainN = train.length;
        res.validN = valid.length;
        res.game = state.game;
        state.optResult = res;
        state.optimizing = false;
        renderOpt();
      }
      setOptProgress(0.5, "正在搜索公式权重…");
      tick();
    }

    buildChunk();
  }

  /* ---------- 汇总渲染 ---------- */
  function renderAll() {
    document.body.setAttribute("data-game", state.game);
    renderTabs();
    renderHero();
    renderPick();
    renderVotes();
    renderSchools();
    renderTrend();
    renderTrack();
    renderOpt();
    if (!state.backtest) renderBacktest();
    var g = C.GAMES[state.game];
    var info = $("footMeta");
    if (info) {
      info.textContent = "双色球 " + S.modelCount("ssq") + " 个公式 · 大乐透 " + S.modelCount("dlt") +
        " 个公式，两者独立注册、互不共用。统计窗口：最近 " + WINDOW + " 期。当前彩种：" + g.name + "。";
    }
  }

  /* ---------- 初始化 ---------- */
  function init() {
    var savedGame = lsGet(LS_GAME);
    if (savedGame && C.GAMES[savedGame]) state.game = savedGame;
    var urlGame = new URLSearchParams(location.search).get("game") ||
      (location.hash ? location.hash.replace(/^#/, "") : "");
    if (urlGame && C.GAMES[urlGame]) state.game = urlGame;
    document.body.setAttribute("data-game", state.game);
    state.weights = loadWeights(state.game);
    renderTabs();

    var btn = $("backtestBtn");
    if (btn) btn.addEventListener("click", runBacktest);

    loadData();
    loadTrack();
    setInterval(loadData, REFRESH_MS);
    setInterval(loadTrack, REFRESH_MS);
    setInterval(function () {
      var cd = $("countdown");
      if (cd && state.nextDraw) cd.textContent = fmtLeft(state.nextDraw - Date.now());
    }, 1000);

    /* 回到页面时刷新 */
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) loadData();
    });

    /* Service Worker */
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("sw.js").catch(function () { /* ignore */ });
    }
  }

  init();
})();
