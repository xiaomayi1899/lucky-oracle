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
    showAllVotes: false,
    modelData: null,
    track: null,
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
      var mw = state.modelData && state.modelData.games && state.modelData.games[state.game]
        ? state.modelData.games[state.game].weights : null;
      state.rec = S.recommend(state.ctx, { weights: mw });
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
      rec.main.clusterCount + " 个独立观点，按训练权重合计票数" +
      "，共 " + fmtVote(rec.main.totalVotes) + " 票" +
      (rec.special ? "；" + esc(g.specialLabel) + " " + rec.special.clusterCount + " 个观点共 " +
        fmtVote(rec.special.totalVotes) + " 票" : "") +
      "。票数相同按归一化总分排序。</div>";

    if (rec.main.shape) {
      var sh = rec.main.shape;
      html += '<div class="shapeline">形态：和值 <b>' + sh.sum + '</b>（历史中位 ' + sh.mid +
        "）· 奇偶 <b>" + sh.odd + ":" + sh.even + "</b> · 连号 <b>" + sh.consec + "</b> 对 · 形态合理度 <b>" +
        Math.round((sh.shape || 0) * 100) + '%</b><small>票数按 70% + 形态 30% 加权排序，避免推出历史上几乎不出现的极端组合</small></div>';
    }

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

  /* ---------- 训练引擎 ---------- */
  function loadModel() {
    fetch("data/model.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j) { state.modelData = j; compute(); renderAll(); }
      })
      .catch(function () { /* ignore */ });
  }

  function renderModel() {
    var body = $("modelBody");
    var meta = $("modelMeta");
    if (!body) return;
    var g = C.GAMES[state.game];
    var all = state.modelData;
    var mm = all && all.games && all.games[state.game];
    if (!mm) {
      if (meta) meta.textContent = "—";
      body.innerHTML = '<div class="muted">训练数据加载中…</div>';
      return;
    }

    var up = mm.baseHit ? (mm.trainHit / mm.baseHit - 1) * 100 : 0;
    var track = state.track && state.track.games && state.track.games[state.game];
    var fwd = track ? (track.records || []).filter(function (r) { return !r.backfilled; }) : [];
    var liveAvg = fwd.length ? fwd.reduce(function (a, r) { return a + r.mainHit; }, 0) / fwd.length : null;
    var rand = g.mainCount * g.mainCount / g.mainMax;

    var html = '<div class="bt-grid">' +
      '<div class="bt-cell"><div class="v">' + mm.trainN + '</div><div class="k">训练期数</div></div>' +
      '<div class="bt-cell"><div class="v">' + mm.trainHit.toFixed(2) + '</div><div class="k">训练集命中</div></div>' +
      '<div class="bt-cell"><div class="v ok">+' + up.toFixed(0) + '%</div><div class="k">相对等权提升</div></div>' +
      "</div>";

    if (liveAvg !== null) {
      var diff = liveAvg - rand;
      html += '<div class="bt-grid">' +
        '<div class="bt-cell"><div class="v">' + liveAvg.toFixed(2) + '</div><div class="k">实盘命中（' + fwd.length + ' 期）</div></div>' +
        '<div class="bt-cell"><div class="v">' + rand.toFixed(2) + '</div><div class="k">随机期望</div></div>' +
        '<div class="bt-cell"><div class="v ' + (diff >= 0 ? "ok" : "bad") + '">' +
          (diff >= 0 ? "+" : "") + diff.toFixed(2) + '</div><div class="k">与随机之差</div></div>' +
        "</div>";
    }

    html += '<div class="muted">基于 ' + esc(mm.basedOnIssue) + " 期开奖后重训，调整了 " + mm.changed + " 个公式的权重。" +
      (liveAvg === null
        ? "实盘记录还没积累，从下一期开奖开始统计。"
        : "训练集是模型见过的数据，实盘是它没见过的——以实盘为准。") +
      "</div>";

    if (mm.history && mm.history.length) {
      html += '<div class="bt-rows" style="margin-top:10px">';
      mm.history.slice(-5).reverse().forEach(function (h) {
        html += '<div class="bt-row"><span class="iss">' + esc(String(h.issue).slice(-6)) + "</span>" +
          '<span class="nums dim">训练 ' + h.trainN + " 期 · 调整 " + h.changed + " 个</span>" +
          '<span class="hit">' + h.trainHit.toFixed(2) + "</span></div>";
      });
      html += "</div>";
    }

    body.innerHTML = html;
    if (meta) meta.textContent = "最近 " + mm.trainN + " 期 · " + esc(mm.basedOnIssue) + " 期后重训";
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

  /* ---------- 汇总渲染 ---------- */
  function renderAll() {
    document.body.setAttribute("data-game", state.game);
    renderTabs();
    renderHero();
    renderPick();
    renderVotes();
    renderTrend();
    renderModel();
    renderTrack();
    var g = C.GAMES[state.game];
    var info = $("footMeta");
    if (info) {
      info.textContent = "双色球 " + S.modelCount("ssq") + " 个公式 · 大乐透 " + S.modelCount("dlt") +
        " 个公式，按彩种隔离。每期开奖后用最近 " + WINDOW + " 期重训权重。当前彩种：" + g.name + "。";
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
    renderTabs();

    if (!window.OracleClusters) {
      setStatus("警告：公式聚类表未加载，投票可能退化，请刷新页面");
    }

    loadData();
    loadModel();
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
      navigator.serviceWorker.register("sw.js").then(function (reg) {
        /* 有新版本时提示刷新，避免看到旧页面 */
        reg.addEventListener("updatefound", function () {
          var nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", function () {
            if (nw.state === "installed" && navigator.serviceWorker.controller) {
              toast("有新版本，请下拉刷新一次");
            }
          });
        });
      }).catch(function () { /* ignore */ });
    }
  }

  init();
})();
