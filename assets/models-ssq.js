/*!
 * 双色球专属公式集 —— 只在本文件内定义，编号一律以 ssq_ 开头。
 * 号码池：红球 1–33 选 6，蓝球 1–16 选 1。
 * 大乐透的任何公式都不会出现在这里，反之亦然（由 schools.js 强制校验）。
 */
(function (root) {
  "use strict";

  var C = root.OracleCore;
  var S = root.OracleSchools;
  if (!C || !S) throw new Error("models-ssq.js 需要 core.js 与 schools.js 先加载");

  var MODELS = [];
  var ZONES = [[1, 11], [12, 22], [23, 33]];

  function reg(id, name, school, formula, target, fn, weight) {
    MODELS.push({
      id: "ssq_" + id, name: name, school: school, formula: formula,
      target: target, score: fn, weight: weight || 1,
    });
  }
  function main(id, name, school, formula, fn, weight) { reg(id, name, school, formula, "main", fn, weight); }
  function spec(id, name, school, formula, fn, weight) { reg(id, name, school, formula, "special", fn, weight); }

  /* ---------------- 工具 ---------------- */

  function cache(ctx, key, fn) {
    if (!ctx.__cache) ctx.__cache = {};
    if (ctx.__cache[key] === undefined) ctx.__cache[key] = fn();
    return ctx.__cache[key];
  }
  function has(arr, v) { return arr.indexOf(v) >= 0; }
  function lastN(a, n) { return a.slice(Math.max(0, a.length - n)); }
  function sd(a, b, f) { return C.safeDiv(a, b, f); }
  function zoneOf(v) { for (var i = 0; i < ZONES.length; i++) if (v >= ZONES[i][0] && v <= ZONES[i][1]) return i; return 0; }
  function tail(v) { return v % 10; }
  function detRng(seedText) {
    var s = 2166136261;
    for (var i = 0; i < seedText.length; i++) { s ^= seedText.charCodeAt(i); s = Math.imul(s, 16777619); }
    s >>>= 0;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function seedOf(ctx) {
    return (ctx.latestRaw && ctx.latestRaw.issue ? String(ctx.latestRaw.issue) : "0") + ":" + ctx.window;
  }

  /* 红球与上期平均重号数 */
  function repeatAvg(ctx) {
    return cache(ctx, "ssq_repeatAvg", function () {
      var d = ctx.main.draws, tot = 0, n = 0;
      for (var i = 1; i < d.length; i++) { tot += C.intersection(d[i], d[i - 1]); n++; }
      return n ? tot / n : 1.1;
    });
  }

  /* 红球与上期邻号（差 1）的平均个数 */
  function neighborAvg(ctx) {
    return cache(ctx, "ssq_neighborAvg", function () {
      var d = ctx.main.draws, tot = 0, n = 0;
      for (var i = 1; i < d.length; i++) {
        var prev = d[i - 1];
        for (var j = 0; j < d[i].length; j++) {
          var v = d[i][j], hit = 0;
          for (var k = 0; k < prev.length; k++) if (Math.abs(prev[k] - v) === 1) { hit = 1; break; }
          if (hit) tot++;
        }
        n++;
      }
      return n ? tot / n : 2;
    });
  }

  /* 斜连候选：上上期 u、上期 u±1 → 本期 u±2 */
  function diagCandidates(ctx) {
    return cache(ctx, "ssq_diagCandidates", function () {
      var d = ctx.main.draws, out = {};
      if (d.length < 3) return out;
      var p2 = d[d.length - 3], p1 = d[d.length - 2];
      for (var i = 0; i < p1.length; i++) {
        var u = p1[i];
        if (p2.indexOf(u - 1) >= 0) out[u + 1] = 1;
        if (p2.indexOf(u + 1) >= 0) out[u - 1] = 1;
      }
      return out;
    });
  }

  /* 蓝球与「红球和值取模」的历史吻合率（纯统计巧合，无因果） */
  function blueSumMatch(ctx) {
    return cache(ctx, "ssq_blueSumMatch", function () {
      var d = ctx.main.draws, b = ctx.special.draws, hit = 0, n = 0;
      for (var i = 0; i < d.length; i++) {
        if (!b[i] || !b[i].length) continue;
        var guess = (C.sum(d[i]) % 16) + 1;
        if (b[i][0] === guess) hit++;
        n++;
      }
      return n ? hit / n : 1 / 16;
    });
  }

  /* ============================================================
   * 一、开奖走势学 · 12 个
   * ============================================================ */

  main("t_hot10", "近十期热度", "trend", "score = 最近 10 期出现次数",
    function (ctx, a, v) { return a.recent10[v]; });

  main("t_hot30", "近三十期热度", "trend", "score = 最近 30 期出现次数",
    function (ctx, a, v) { return a.recent30[v]; });

  main("t_cold", "冷号回补", "trend", "score = 当前遗漏期数",
    function (ctx, a, v) { return a.omit[v]; });

  main("t_overdue", "超期指数", "trend", "score = 当前遗漏 / 平均遗漏",
    function (ctx, a, v) { return sd(a.omit[v], Math.max(1, a.avgOmit[v]), 0); });

  main("t_repeat", "上期重号", "trend", "score = 上期出现 ? 1 + 重号率 : 0",
    function (ctx, a, v) {
      var inLast = has(a.last, v) ? 1 : 0;
      return inLast * (1 + repeatAvg(ctx) / ctx.game.mainCount);
    });

  main("t_neighbor", "邻号延伸", "trend", "score = 上期存在 v±1 的个数 × 邻号率",
    function (ctx, a, v) {
      var n = 0;
      for (var i = 0; i < a.last.length; i++) if (Math.abs(a.last[i] - v) === 1) n++;
      return n * (1 + neighborAvg(ctx) / ctx.game.mainCount);
    });

  main("t_diag", "斜连走势", "trend", "score = 上上期与上期构成 v-2/v-1 斜连 ? 1 : 0",
    function (ctx, a, v) { var d = diagCandidates(ctx); return d[v] ? 1 + neighborAvg(ctx) / 10 : 0; });

  main("t_zone", "三区轮动", "trend", "score = 1 / (1 + 近 3 期该区出现次数)",
    function (ctx, a, v) {
      var z = zoneOf(v), cnt = 0, recent = lastN(a.draws, 3);
      for (var i = 0; i < recent.length; i++) {
        for (var j = 0; j < recent[i].length; j++) if (zoneOf(recent[i][j]) === z) cnt++;
      }
      return 1 / (1 + cnt);
    });

  main("t_sumtrend", "和值回归", "trend", "预测和值 = 0.5·近 10 期均值 + 0.5·理论均值，score = exp(-(v-目标均号)²/2σ²)",
    function (ctx, a, v) {
      var theory = ctx.game.mainCount * (1 + 33) / 2;
      var pred = 0.5 * C.mean(lastN(a.sumSeries, 10)) + 0.5 * theory;
      var target = pred / ctx.game.mainCount;
      var sigma = 4.2;
      var d = v - target;
      return Math.exp(-(d * d) / (2 * sigma * sigma));
    });

  main("t_tail", "同尾走势", "trend", "score = 近 10 期出现最多的尾数命中 ? 1 : 0.2",
    function (ctx, a, v) {
      var tailCnt = {}, recent = lastN(a.draws, 10);
      for (var i = 0; i < recent.length; i++) {
        for (var j = 0; j < recent[i].length; j++) tailCnt[tail(recent[i][j])] = (tailCnt[tail(recent[i][j])] || 0) + 1;
      }
      var t = tail(v), mx = 0;
      for (var k in tailCnt) if (tailCnt[k] > mx) mx = tailCnt[k];
      return mx ? 0.2 + 0.8 * ((tailCnt[t] || 0) / mx) : 0.2;
    });

  main("t_consec", "连号倾向", "trend", "score = 与上期号码形成连号 ? 1 : 0，叠加历史连号率",
    function (ctx, a, v) {
      var near = 0;
      for (var i = 0; i < a.last.length; i++) if (Math.abs(a.last[i] - v) === 1) near++;
      var avgConsec = C.mean(a.consecSeries);
      return near ? 1 + avgConsec / 3 : 0;
    });

  main("t_span", "跨度位置", "trend", "预测跨度后，边界号码得分更高",
    function (ctx, a, v) {
      var predSpan = 0.6 * C.mean(lastN(a.spanSeries, 5)) + 0.4 * (33 - 6);
      var edge = Math.max(v - 1, 33 - v);
      return Math.exp(-Math.pow(edge - predSpan, 2) / (2 * 36));
    });

  /* ============================================================
   * 二、概率学 · 12 个
   * ============================================================ */

  main("p_hyper", "超几何上尾", "probability", "P(X≥count)，X~Hypergeom(33,6,N)",
    function (ctx, a, v) {
      var N = a.draws.length, K = ctx.game.mainCount, c = a.counts[v];
      var lp = 0, lq = 0, tot = 0;
      for (var x = c; x <= Math.min(K * N, 33); x++) {
        var lw = C.logChoose(K * N, x) + C.logChoose(33 * N - K * N, N - x) - C.logChoose(33 * N, N);
        tot += Math.exp(lw);
      }
      return -Math.log(Math.max(tot, 1e-12));
    });

  main("p_binom", "二项分布密度", "probability", "P(X=count)，X~B(N, 6/33)",
    function (ctx, a, v) {
      var n = a.draws.length, p = ctx.game.mainCount / 33, k = a.counts[v];
      return Math.exp(C.logChoose(n, k) + k * Math.log(Math.max(p, 1e-9)) + (n - k) * Math.log(Math.max(1 - p, 1e-9)));
    });

  main("p_poisson", "泊松密度", "probability", "P(X=count)，λ=N·6/33",
    function (ctx, a, v) {
      var lam = a.draws.length * ctx.game.mainCount / 33, k = a.counts[v];
      return Math.exp(-lam + k * Math.log(Math.max(lam, 1e-9)) - C.logFact(k));
    });

  main("p_geom", "几何回补", "probability", "P(再等 1 期即出现) = (1-p)^omit · p",
    function (ctx, a, v) {
      var p = ctx.game.mainCount / 33;
      return Math.pow(1 - p, a.omit[v]) * p;
    });

  main("p_beta", "Beta 后验均值", "probability", "(count+1)/(N+2)，α=β=1",
    function (ctx, a, v) { return (a.counts[v] + 1) / (a.draws.length + 2); });

  main("p_bayes", "贝叶斯因子", "probability", "(count+0.5)/(N·p+0.5)",
    function (ctx, a, v) {
      var p = ctx.game.mainCount / 33;
      return (a.counts[v] + 0.5) / (a.draws.length * p + 0.5);
    });

  main("p_cond", "条件概率", "probability", "P(v 出现 | 上期每个号码)，取平均",
    function (ctx, a, v) {
      var s = 0, n = 0;
      for (var i = 0; i < a.last.length; i++) {
        var u = a.last[i], base = a.transBase[u] || 0;
        if (base) { s += (a.trans[u][v] || 0) / base; n++; }
      }
      return n ? s / n : 0;
    });

  main("p_expect", "期望偏差", "probability", "score = |count - N·p| / √(N·p(1-p))",
    function (ctx, a, v) {
      var n = a.draws.length, p = ctx.game.mainCount / 33;
      var e = n * p, sdv = Math.sqrt(Math.max(n * p * (1 - p), 1e-9));
      return Math.abs(a.counts[v] - e) / sdv;
    });

  main("p_birthday", "重号概率", "probability", "两期同时出现的经验概率",
    function (ctx, a, v) {
      var s = a.series[v], both = 0, occ = 0;
      for (var i = 1; i < s.length; i++) { if (s[i]) occ++; if (s[i] && s[i - 1]) both++; }
      return occ ? both / occ : 0;
    });

  main("p_multi", "多项分布似然", "probability", "Σ count·log(p_v)",
    function (ctx, a, v) {
      var p = ctx.game.mainCount / 33;
      return a.counts[v] * Math.log(Math.max(p, 1e-9));
    });

  main("p_negbinom", "负二项等待", "probability", "第 count+1 次出现所需的期望期数倒数",
    function (ctx, a, v) {
      var p = ctx.game.mainCount / 33, r = a.counts[v] + 1;
      var mean = r / Math.max(p, 1e-9);
      return 1 / Math.max(1, mean);
    });

  main("p_ci", "后验下界", "probability", "Beta(count+1, N-count+1) 的 10% 分位近似",
    function (ctx, a, v) {
      var n = a.draws.length, x = a.counts[v];
      var m = (x + 1) / (n + 2);
      var se = Math.sqrt(m * (1 - m) / (n + 3));
      return Math.max(0, m - 1.28 * se);
    });

  /* ============================================================
   * 三、统计学 · 12 个
   * ============================================================ */

  main("s_freq", "原始频率", "statistics", "count / N",
    function (ctx, a, v) { return a.counts[v] / Math.max(1, a.draws.length); });

  main("s_chi", "卡方残差", "statistics", "(O-E)/√E",
    function (ctx, a, v) {
      var N = a.draws.length, p = ctx.game.mainCount / 33, E = N * p;
      return (a.counts[v] - E) / Math.sqrt(Math.max(E, 1e-9));
    });

  main("s_z", "频率 Z 分数", "statistics", "(count-μ)/σ",
    function (ctx, a, v) {
      var N = a.draws.length, p = ctx.game.mainCount / 33;
      return (a.counts[v] - N * p) / Math.sqrt(Math.max(N * p * (1 - p), 1e-9));
    });

  main("s_ewma", "指数加权频率", "statistics", "Σ 0.93^t · I(v 出现)",
    function (ctx, a, v) {
      var s = a.series[v], acc = 0, w = 1;
      for (var i = s.length - 1; i >= 0; i--) { if (s[i]) acc += w; w *= 0.93; }
      return acc;
    });

  main("s_entropy", "信息熵贡献", "statistics", "-p·log2(p)，p 为该号归一化频率",
    function (ctx, a, v) {
      var N = a.draws.length, p = a.counts[v] / Math.max(1, N * ctx.game.mainCount / 33);
      return p > 1e-9 ? -p * Math.log(p) / Math.LN2 : 0;
    });

  main("s_slope", "线性回归斜率", "statistics", "slope(series[v], 20)",
    function (ctx, a, v) { return C.linregSlope(lastN(a.series[v], 20)); });

  main("s_autocorr", "自相关", "statistics", "corr(series[t], series[t-1])",
    function (ctx, a, v) { return C.autocorr(a.series[v], 1); });

  main("s_cv", "间隔变异系数", "statistics", "std(gaps)/mean(gaps)",
    function (ctx, a, v) {
      var g = a.gaps[v];
      if (g.length < 2) return 0;
      return sd(C.std(g), Math.max(1e-9, C.mean(g)), 0);
    });

  main("s_rank", "频率排名分", "statistics", "1 - rank/(pool-1)",
    function (ctx, a, v) {
      var sorted = a.pool.slice().sort(function (x, y) { return a.counts[y] - a.counts[x] || x - y; });
      var idx = sorted.indexOf(v);
      return 1 - idx / (a.pool.length - 1);
    });

  main("s_ks", "KS 距离", "statistics", "经验分布与理论均匀分布的 KS 距离（取负）",
    function (ctx, a, v) {
      var d = a.draws, pos = [];
      for (var i = 0; i < d.length; i++) for (var j = 0; j < d[i].length; j++) if (d[i][j] === v) pos.push(i);
      if (!pos.length) return 0;
      var maxD = 0;
      for (var k = 0; k < pos.length; k++) {
        var emp = (k + 1) / pos.length, th = pos[k] / Math.max(1, d.length - 1);
        maxD = Math.max(maxD, Math.abs(emp - th));
      }
      return -maxD;
    });

  main("s_mad", "遗漏稳健偏差", "statistics", "|omit - median(omit_all)| / MAD",
    function (ctx, a, v) {
      var all = a.pool.map(function (x) { return a.omit[x]; });
      var med = C.median(all);
      var mad = C.median(all.map(function (x) { return Math.abs(x - med); })) || 1;
      return Math.abs(a.omit[v] - med) / mad;
    });

  main("s_ci", "频率置信区间", "statistics", "95% 置信区间半宽（取负，越窄越稳）",
    function (ctx, a, v) {
      var N = a.draws.length, p = a.counts[v] / Math.max(1, N);
      return -1.96 * Math.sqrt(Math.max(p * (1 - p) / Math.max(1, N), 0));
    });

  /* ============================================================
   * 四、心理学 · 12 个（刻画大众会偏好哪些号码；分高 = 更受青睐）
   * ============================================================ */

  main("psy_birthday", "生日号偏好", "psychology", "1–31 视为生日号，偏好度更高",
    function (ctx, a, v) { return v <= 31 ? 1 : 0.1; });

  main("psy_lucky", "吉利数字", "psychology", "6/8/9/16/18/28 的吉利偏好",
    function (ctx, a, v) { return [6, 8, 9, 16, 18, 28, 33].indexOf(v) >= 0 ? 1 : 0.15; });

  main("psy_taboo", "避讳数字", "psychology", "尾数 4 与 13 被回避（分低 = 少人选）",
    function (ctx, a, v) { return (tail(v) === 4 || v === 13) ? 0 : 1; });

  main("psy_tailpref", "尾数偏好", "psychology", "尾数 8/6/9 更受欢迎",
    function (ctx, a, v) { var t = tail(v); return [8, 6, 9].indexOf(t) >= 0 ? 1 : (t === 4 ? 0.1 : 0.4); });

  main("psy_visual", "视觉模式", "psychology", "连号/对称/对角等看得见的图案更易被选中",
    function (ctx, a, v) {
      var s = 0;
      if (has(a.last, v)) s += 0.6;
      for (var i = 0; i < a.last.length; i++) if (Math.abs(a.last[i] - v) === 1) s += 0.4;
      if (has(a.last, 34 - v)) s += 0.5;   /* 关于 17 对称 */
      return s;
    });

  main("psy_hotband", "热手谬误", "psychology", "大众相信热号会继续热：近 10 期出现次数",
    function (ctx, a, v) { return a.recent10[v] + a.recent5[v] * 0.5; });

  main("psy_gambler", "赌徒谬误", "psychology", "大众相信冷号该出：当前遗漏期数",
    function (ctx, a, v) { return a.omit[v]; });

  main("psy_anchor", "锚定效应", "psychology", "以上期号码为锚，重复与邻近号码更受关注",
    function (ctx, a, v) {
      if (has(a.last, v)) return 1;
      for (var i = 0; i < a.last.length; i++) if (Math.abs(a.last[i] - v) <= 2) return 0.5;
      return 0.1;
    });

  main("psy_avail", "可得性偏差", "psychology", "近期频繁出现让人误以为更容易再出",
    function (ctx, a, v) { return a.recent5[v] * 2 + a.recent10[v]; });

  main("psy_herd", "从众效应", "psychology", "上期开出的号码会被大量跟买",
    function (ctx, a, v) { return has(a.last, v) ? 1 : 0; });

  main("psy_round", "整数偏好", "psychology", "5 的倍数与 1–9 小号更受欢迎",
    function (ctx, a, v) {
      var s = 0;
      if (v % 5 === 0) s += 0.6;
      if (v <= 9) s += 0.5;
      return s;
    });

  main("psy_symmetry", "对称偏好", "psychology", "关于 17 对称的两号（v 与 34-v）常被成对选择",
    function (ctx, a, v) { return has(a.last, 34 - v) ? 1 : 0.2; });

  /* ============================================================
   * 五、博弈学 · 12 个（分高 = 被分摊风险低，更适合作为唯一一注）
   * ============================================================ */

  /* 大众热度综合分：心理学各维度的加权和 */
  function crowdScore(ctx, a, v) {
    return cache(ctx, "ssq_crowd_" + v, function () {
      var s = 0;
      if (v <= 31) s += 0.30; else s -= 0.10;
      if ([6, 8, 9, 16, 18, 28, 33].indexOf(v) >= 0) s += 0.35;
      if (tail(v) === 4 || v === 13) s -= 0.45;
      if (tail(v) === 8) s += 0.20;
      if (v % 5 === 0) s += 0.12;
      if (v <= 9) s += 0.18;
      if (has(a.last, v)) s += 0.40;
      s += 0.20 * (a.recent10[v] / 10);
      for (var i = 0; i < a.last.length; i++) if (Math.abs(a.last[i] - v) === 1) s += 0.15;
      return s;
    });
  }

  main("g_crowd", "拥挤度反向", "game", "score = -大众热度综合分",
    function (ctx, a, v) { return -crowdScore(ctx, a, v); });

  main("g_share", "奖池分摊", "game", "高奖池时分摊更痛，score = -crowd × ln(奖池/1e8)",
    function (ctx, a, v) {
      var poolRatio = Math.max(0.1, ctx.pool / 1e8);
      return -crowdScore(ctx, a, v) * Math.log(1 + poolRatio);
    });

  main("g_minority", "少数者博弈", "game", "同时避开历史高频号与心理热门号",
    function (ctx, a, v) {
      var freqRank = a.counts[v] / Math.max(1, a.draws.length);
      return -(freqRank * 4 + crowdScore(ctx, a, v) * 0.5);
    });

  main("g_nash", "混合策略均衡", "game", "偏离大众平均选择的程度（越偏越好）",
    function (ctx, a, v) {
      var avgCrowd = 0;
      for (var i = 0; i < a.pool.length; i++) avgCrowd += crowdScore(ctx, a, a.pool[i]);
      avgCrowd /= a.pool.length;
      return Math.abs(crowdScore(ctx, a, v) - avgCrowd);
    });

  main("g_dominant", "占优策略", "game", "低热度 + 历史出现次数不低 = 不被支配",
    function (ctx, a, v) {
      return a.counts[v] / Math.max(1, a.draws.length) - 0.5 * Math.max(0, crowdScore(ctx, a, v));
    });

  main("g_zero", "零和对抗", "game", "假设对手专挑上期号码，score = -上期热度",
    function (ctx, a, v) {
      var s = 0;
      if (has(a.last, v)) s += 1;
      for (var i = 0; i < a.last.length; i++) if (Math.abs(a.last[i] - v) === 1) s += 0.4;
      return -s;
    });

  main("g_anticipate", "二阶预判", "game", "预判大众会避开冷门，于是冷门反而变拥挤：取中等热度最优",
    function (ctx, a, v) {
      var c = crowdScore(ctx, a, v);
      return -Math.abs(c - 0.05);
    });

  main("g_payoff", "期望收益", "game", "中奖概率相同，score = 1/(1+拥挤度)",
    function (ctx, a, v) {
      return 1 / (1 + Math.max(0, crowdScore(ctx, a, v)) * 4);
    });

  main("g_pareto", "帕累托组合", "game", "兼顾「少人买」与「和值不极端」",
    function (ctx, a, v) {
      var theory = ctx.game.mainCount * 17;
      var sumFit = Math.exp(-Math.pow(v - theory / ctx.game.mainCount, 2) / 32);
      return sumFit * 2 - Math.max(0, crowdScore(ctx, a, v));
    });

  main("g_signal", "信号博弈", "game", "认为「热号会继续热」的跟风者越多，热号越拥挤",
    function (ctx, a, v) { return -a.recent10[v] * 0.6 - a.recent5[v] * 0.4; });

  main("g_auction", "竞价避让", "game", "按热度倒数出价，避开被抬价的热门号",
    function (ctx, a, v) {
      var bid = Math.exp(crowdScore(ctx, a, v));
      return 1 / bid;
    });

  main("g_evolution", "演化稳定", "game", "长期看，避开被反复追捧的号码更稳定",
    function (ctx, a, v) {
      var hot = a.recent30[v] / 30;
      return -(hot * 2 + Math.max(0, crowdScore(ctx, a, v)));
    });

  /* ============================================================
   * 六、未来学 · 12 个
   * ============================================================ */

  main("f_trend", "趋势外推", "futures", "最近 20 期线性斜率外推",
    function (ctx, a, v) { return C.linregSlope(lastN(a.series[v], 20)) * 10 + 0.5; });

  main("f_fourier", "傅里叶周期", "futures", "对 series[v] 做周期 7 的离散傅里叶振幅",
    function (ctx, a, v) {
      var s = a.series[v], re = 0, im = 0, N = Math.min(s.length, 56);
      for (var t = 0; t < N; t++) {
        var ang = 2 * Math.PI * 7 * t / N;
        re += s[s.length - N + t] * Math.cos(ang);
        im -= s[s.length - N + t] * Math.sin(ang);
      }
      return Math.sqrt(re * re + im * im) / Math.max(1, N);
    });

  main("f_holt", "Holt 双指数", "futures", "level + trend，α=0.35 β=0.15",
    function (ctx, a, v) { return C.holt(a.series[v], 0.35, 0.15); });

  main("f_ar1", "AR(1) 预测", "futures", "μ + φ(x_t-μ)，φ 为自相关系数",
    function (ctx, a, v) {
      var s = a.series[v], mu = C.mean(s), phi = C.autocorr(s, 1);
      return mu + phi * (s[s.length - 1] - mu);
    });

  main("f_kalman", "卡尔曼滤波", "futures", "状态空间滤波后的预测值",
    function (ctx, a, v) { return C.kalman(a.series[v], 0.02, 0.15); });

  main("f_scenario", "情景树", "futures", "乐观/中性/悲观三情景加权",
    function (ctx, a, v) {
      var s = a.series[v], m5 = C.mean(lastN(s, 5)), m15 = C.mean(lastN(s, 15));
      var opt = m5 * 1.4, neu = (m5 + m15) / 2, pes = m15 * 0.6;
      return 0.3 * opt + 0.4 * neu + 0.3 * pes;
    });

  main("f_delphi", "德尔菲加权", "futures", "MA5、EMA、Holt 三种预测的加权共识",
    function (ctx, a, v) {
      var s = a.series[v];
      return 0.34 * C.mean(lastN(s, 5)) + 0.33 * C.ema(lastN(s, 20), 0.3) + 0.33 * C.holt(lastN(s, 20));
    });

  main("f_changepoint", "突变点检测", "futures", "最近 5 期均值与之前 15 期均值之差",
    function (ctx, a, v) {
      var s = a.series[v];
      if (s.length < 20) return 0;
      var recent = C.mean(s.slice(-5)), base = C.mean(s.slice(-20, -5));
      return recent - base;
    });

  main("f_scurve", "S 曲线拟合", "futures", "logistic 拟合近期累计出现率",
    function (ctx, a, v) {
      var s = a.series[v], t = 0, cum = 0;
      for (var i = Math.max(0, s.length - 30); i < s.length; i++) { cum += s[i]; t++; }
      var rate = t ? cum / t : 0;
      return 1 / (1 + Math.exp(-(rate - 0.18) * 12));
    });

  main("f_montecarlo", "蒙特卡洛重抽样", "futures", "对近期序列做固定种子的 bootstrap",
    function (ctx, a, v) {
      var s = lastN(a.series[v], 40);
      var rng = detRng(seedOf(ctx) + ":mc:" + v);
      var hits = 0, sims = 60;
      for (var i = 0; i < sims; i++) {
        var pick = s[Math.floor(rng() * s.length)];
        if (pick) hits++;
      }
      return hits / sims;
    });

  main("f_grey", "灰色预测 GM(1,1)", "futures", "一阶累加后的指数预测",
    function (ctx, a, v) {
      var s = lastN(a.series[v], 16);
      if (s.length < 4) return 0;
      var x1 = [], acc = 0;
      for (var i = 0; i < s.length; i++) { acc += s[i]; x1.push(acc || 1e-6); }
      var z = [];
      for (var j = 1; j < x1.length; j++) z.push(0.5 * (x1[j] + x1[j - 1]));
      var B = z.map(function (x) { return [-x, 1]; });
      /* 最小二乘简化：用最后两点的增长率 */
      var last = x1[x1.length - 1], prev = x1[x1.length - 2];
      var growth = sd(last - prev, Math.max(1e-6, prev), 0);
      return sd(x1[0] * Math.exp(growth * x1.length), x1.length, 0);
    });

  main("f_cycle", "周期共振", "futures", "7 期与 30 期自相关的合成",
    function (ctx, a, v) {
      var s = a.series[v];
      return C.autocorr(s, 7) * 0.6 + C.autocorr(s, 1) * 0.4;
    });

  /* ============================================================
   * 蓝球专属（special）· 7 个
   * ============================================================ */

  spec("sp_omit", "蓝球遗漏", "trend", "当前遗漏期数",
    function (ctx, a, v) { return a.omit[v]; });

  spec("sp_hot", "蓝球热度", "trend", "近 10 期出现次数",
    function (ctx, a, v) { return a.recent10[v] * 2 + a.recent30[v] * 0.3; });

  spec("sp_markov", "蓝球转移", "probability", "P(v | 上期蓝球)",
    function (ctx, a, v) {
      var last = a.last[0];
      if (last === undefined) return 0;
      var base = a.transBase[last] || 0;
      return base ? (a.trans[last][v] || 0) / base : 0;
    });

  spec("sp_sumlink", "红蓝和值联动", "statistics", "红球和值 mod 16 + 1 的历史吻合率加成",
    function (ctx, a, v) {
      var rate = blueSumMatch(ctx);
      var guess = (C.sum(ctx.main.last) % 16) + 1;
      return guess === v ? rate * 3 : rate;
    });

  spec("sp_psych", "蓝球心理号", "psychology", "8/16/6/9 等吉利蓝球更受青睐",
    function (ctx, a, v) {
      var s = 0;
      if ([8, 16, 6, 9].indexOf(v) >= 0) s += 1;
      if (tail(v) === 4) s -= 0.4;
      if (v <= 12) s += 0.2;   /* 与大乐透后区同池，部分人只用 1–12 */
      return s;
    });

  spec("sp_anti", "蓝球反热门", "game", "避开最受追捧的蓝球号",
    function (ctx, a, v) {
      var s = 0;
      if ([8, 16, 6, 9].indexOf(v) >= 0) s += 1;
      if (v <= 12) s += 0.2;
      return -s;
    });

  spec("sp_future", "蓝球趋势", "futures", "EMA + 遗漏比 + 周期自相关",
    function (ctx, a, v) {
      var s = a.series[v];
      return C.ema(lastN(s, 20), 0.3) * 2 + C.autocorr(s, 4) * 0.5 + sd(a.omit[v], Math.max(1, a.avgOmit[v]), 0) * 0.3;
    });

  spec("sp_zone", "蓝球区间轮动", "trend", "蓝球四分区 1–4/5–8/9–12/13–16 轮动",
    function (ctx, a, v) {
      var z = Math.floor((v - 1) / 4), cnt = 0, recent = lastN(a.draws, 4);
      for (var i = 0; i < recent.length; i++) {
        for (var j = 0; j < recent[i].length; j++) if (Math.floor((recent[i][j] - 1) / 4) === z) cnt++;
      }
      return 1 / (1 + cnt);
    });

  spec("sp_geom", "蓝球几何回补", "probability", "(1-p)^omit · p，p=1/16",
    function (ctx, a, v) { var p = 1 / 16; return Math.pow(1 - p, a.omit[v]) * p; });

  spec("sp_beta", "蓝球 Beta 后验", "probability", "(count+1)/(N+2)",
    function (ctx, a, v) { return (a.counts[v] + 1) / (a.draws.length + 2); });

  spec("sp_chi", "蓝球卡方残差", "statistics", "(O-E)/√E，E=N/16",
    function (ctx, a, v) {
      var E = a.draws.length / 16;
      return (a.counts[v] - E) / Math.sqrt(Math.max(E, 1e-9));
    });

  spec("sp_z", "蓝球 Z 分数", "statistics", "(count-μ)/σ，p=1/16",
    function (ctx, a, v) {
      var N = a.draws.length, p = 1 / 16;
      return (a.counts[v] - N * p) / Math.sqrt(Math.max(N * p * (1 - p), 1e-9));
    });

  spec("sp_taboo", "蓝球避讳", "psychology", "尾数 4 的蓝球被回避（分低 = 少人选）",
    function (ctx, a, v) { return v % 10 === 4 ? 0 : 1; });

  spec("sp_cycle", "蓝球周期", "futures", "8 期与 1 期自相关的合成",
    function (ctx, a, v) {
      var s = a.series[v];
      return C.autocorr(s, 8) * 0.6 + C.autocorr(s, 1) * 0.4;
    });

  S.register("ssq", MODELS);

  if (typeof module === "object" && module.exports) module.exports = MODELS;
})(typeof globalThis !== "undefined" ? globalThis : this);
