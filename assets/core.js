/*!
 * 数理投票选号 · 核心层
 * 彩种定义、数学工具、统计上下文。纯前端、无依赖。
 * 本文件不含任何"预测"承诺：彩票每期开奖相互独立，任何模型都不能提高中奖概率。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OracleCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var VERSION = "2.0.0";

  /* ==================== 彩种 ==================== */

  var GAMES = {
    ssq: {
      id: "ssq",
      name: "双色球",
      tag: "福彩",
      color: "#e2453c",
      mainLabel: "红球",
      specialLabel: "蓝球",
      mainMin: 1, mainMax: 33, mainCount: 6,
      specialMin: 1, specialMax: 16, specialCount: 1,
      keyMain: "red",
      keySpecial: "blue",
      schedule: { days: [0, 2, 4], hour: 21, minute: 15 },
      odds: "1/17,721,088",
    },
    dlt: {
      id: "dlt",
      name: "大乐透",
      tag: "体彩",
      color: "#d97318",
      mainLabel: "前区",
      specialLabel: "后区",
      mainMin: 1, mainMax: 35, mainCount: 5,
      specialMin: 1, specialMax: 12, specialCount: 2,
      keyMain: "front",
      keySpecial: "back",
      schedule: { days: [1, 3, 6], hour: 21, minute: 25 },
      odds: "1/21,425,712",
    },
  };

  var GAME_ORDER = ["ssq", "dlt"];

  /* ==================== 通用数学 ==================== */

  function range(min, max) {
    var out = [];
    for (var i = min; i <= max; i++) out.push(i);
    return out;
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function mean(a) { return a.length ? sum(a) / a.length : 0; }

  function variance(a) {
    if (a.length < 2) return 0;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) { var d = a[i] - m; s += d * d; }
    return s / a.length;
  }
  function std(a) { return Math.sqrt(variance(a)); }

  function median(a) {
    if (!a.length) return 0;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  function quantile(a, q) {
    if (!a.length) return 0;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var pos = (b.length - 1) * Math.max(0, Math.min(1, q));
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? b[lo] : b[lo] + (b[hi] - b[lo]) * (pos - lo);
  }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function clamp01(x) { return clamp(x, 0, 1); }
  function safeDiv(a, b, fb) { return Math.abs(b) > 1e-12 ? a / b : (fb || 0); }

  /* 把 [{v, s}] 的 s 归一到 0..1 */
  function normalizeScores(items) {
    var min = Infinity, max = -Infinity, i;
    for (i = 0; i < items.length; i++) {
      var s = isFinite(items[i].s) ? items[i].s : 0;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    var span = max - min, out = [];
    for (i = 0; i < items.length; i++) {
      var v = isFinite(items[i].v2) ? items[i].v2 : 0;
      var raw = isFinite(items[i].s) ? items[i].s : 0;
      out.push({ v: items[i].v, s: span > 1e-12 ? (raw - min) / span : 0.5 });
    }
    return out;
  }

  function zscores(values) {
    var m = mean(values), sd = std(values);
    return values.map(function (x) { return safeDiv(x - m, sd, 0); });
  }

  function pearson(x, y) {
    var n = Math.min(x.length, y.length);
    if (n < 3) return 0;
    var mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    var sxy = 0, sxx = 0, syy = 0;
    for (i = 0; i < n; i++) {
      var dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return safeDiv(sxy, Math.sqrt(sxx * syy), 0);
  }

  function linregSlope(series, n) {
    var k = Math.min(series.length, n || series.length);
    if (k < 2) return 0;
    var xs = [], ys = [], i;
    for (i = 0; i < k; i++) { xs.push(i); ys.push(series[k - 1 - i]); }
    var mx = mean(xs), my = mean(ys), num = 0, den = 0;
    for (i = 0; i < k; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
    return safeDiv(num, den, 0);
  }

  function ema(series, alpha) {
    if (!series.length) return 0;
    var a = alpha || 0.3, out = series[0];
    for (var i = 1; i < series.length; i++) out = a * series[i] + (1 - a) * out;
    return out;
  }

  function holt(series, alpha, beta) {
    if (series.length < 2) return series.length ? series[0] : 0;
    var a = alpha || 0.35, b = beta || 0.15;
    var level = series[0], trend = series[1] - series[0];
    for (var i = 1; i < series.length; i++) {
      var prev = level;
      level = a * series[i] + (1 - a) * (level + trend);
      trend = b * (level - prev) + (1 - b) * trend;
    }
    return level + trend;
  }

  function kalman(series, q, r) {
    if (!series.length) return 0;
    var Q = q === undefined ? 0.01 : q, R = r === undefined ? 0.1 : r;
    var x = series[0], p = 1;
    for (var i = 1; i < series.length; i++) {
      p += Q;
      var k = p / (p + R);
      x = x + k * (series[i] - x);
      p = (1 - k) * p;
    }
    return x;
  }

  function autocorr(series, lag) {
    var L = lag || 1, n = series.length;
    if (n <= L + 2) return 0;
    var a = [], b = [], i;
    for (i = L; i < n; i++) { a.push(series[i]); b.push(series[i - L]); }
    return pearson(a, b);
  }

  function hurst(series) {
    var n = series.length;
    if (n < 12) return 0.5;
    var m = mean(series), cum = 0, mx = -Infinity, mn = Infinity;
    for (var i = 0; i < n; i++) {
      cum += series[i] - m;
      if (cum > mx) mx = cum;
      if (cum < mn) mn = cum;
    }
    var R = mx - mn, S = std(series);
    return S > 1e-12 ? clamp(Math.log(safeDiv(R, S, 1)) / Math.log(n), 0.01, 0.99) : 0.5;
  }

  function entropy(probs) {
    var h = 0;
    for (var i = 0; i < probs.length; i++) {
      var p = probs[i];
      if (p > 1e-12) h -= p * Math.log(p) / Math.LN2;
    }
    return h;
  }

  function logGamma(x) {
    var g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    var ser = 1.000000000190015;
    for (var j = 0; j < 6; j++) { y += 1; ser += g[j] / y; }
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }

  function logChoose(n, k) {
    if (k < 0 || k > n) return -Infinity;
    return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
  }

  function logFact(n) { return logGamma(n + 1); }

  /* 枚举组合（回调） */
  function eachCombination(arr, k, cb) {
    var n = arr.length, idx = [], i;
    if (k > n) return;
    for (i = 0; i < k; i++) idx.push(i);
    while (true) {
      var cur = [];
      for (i = 0; i < k; i++) cur.push(arr[idx[i]]);
      if (cb(cur, idx) === false) return;
      var p = k - 1;
      while (p >= 0 && idx[p] === n - k + p) p--;
      if (p < 0) return;
      idx[p]++;
      for (i = p + 1; i < k; i++) idx[i] = idx[i - 1] + 1;
    }
  }

  function shuffle(arr, rng) {
    var a = arr.slice(), r = rng || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1)), t = a[i];
      a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function uniqueSorted(a) {
    var seen = {}, out = [];
    for (var i = 0; i < a.length; i++) if (!seen[a[i]]) { seen[a[i]] = 1; out.push(a[i]); }
    return out.sort(function (x, y) { return x - y; });
  }

  function intersection(a, b) {
    var sb = {}, n = 0;
    for (var i = 0; i < b.length; i++) sb[b[i]] = 1;
    for (var j = 0; j < a.length; j++) if (sb[a[j]]) n++;
    return n;
  }

  /* ==================== 区域统计 ==================== */

  function buildArea(game, chrono, which) {
    var isMain = which === "main";
    var min = isMain ? game.mainMin : game.specialMin;
    var max = isMain ? game.mainMax : game.specialMax;
    var key = isMain ? game.keyMain : game.keySpecial;
    var pick = isMain ? game.mainCount : game.specialCount;
    var pool = range(min, max);
    var N = chrono.length;
    var P = safeDiv(pick, pool.length, 0);

    var counts = {}, series = {}, gaps = {}, omit = {}, lastSeen = {};
    var recent10 = {}, recent30 = {}, recent5 = {};
    var trans = {}, transBase = {}, cooc = {}, posFreq = [];
    var i, j, v, u;

    for (i = 0; i < pool.length; i++) {
      v = pool[i];
      counts[v] = 0;
      series[v] = [];
      gaps[v] = [];
      lastSeen[v] = -1;
      recent10[v] = 0; recent30[v] = 0; recent5[v] = 0;
      trans[v] = {};
      transBase[v] = 0;
      cooc[v] = {};
    }

    /* 每期实际号码（按时间正序） */
    var drawsByIndex = [];
    for (i = 0; i < N; i++) {
      var nums = (chrono[i][key] || []).slice().sort(function (a, b) { return a - b; });
      drawsByIndex.push(nums);
    }

    /* 出现序列 / 频次 / 共现 / 转移 / 位置 */
    for (i = 0; i < N; i++) {
      var cur = drawsByIndex[i];
      var inCur = {};
      for (j = 0; j < cur.length; j++) inCur[cur[j]] = 1;

      for (j = 0; j < pool.length; j++) {
        v = pool[j];
        var hit = inCur[v] ? 1 : 0;
        series[v].push(hit);
        if (hit) {
          counts[v]++;
          if (lastSeen[v] >= 0) gaps[v].push(i - lastSeen[v]);
          lastSeen[v] = i;
        }
        if (hit && i >= N - 10) recent10[v]++;
        if (hit && i >= N - 30) recent30[v]++;
        if (hit && i >= N - 5) recent5[v]++;
      }

      /* 共现 */
      for (j = 0; j < cur.length; j++) {
        for (var m2 = j + 1; m2 < cur.length; m2++) {
          var a1 = cur[j], b1 = cur[m2];
          if (cooc[a1] && cooc[b1] !== undefined) {
            cooc[a1][b1] = (cooc[a1][b1] || 0) + 1;
            cooc[b1][a1] = (cooc[b1][a1] || 0) + 1;
          }
        }
      }

      /* 位置分布：排序后第 pos 位出现的号码 */
      for (j = 0; j < cur.length; j++) {
        if (!posFreq[j]) posFreq[j] = {};
        posFreq[j][cur[j]] = (posFreq[j][cur[j]] || 0) + 1;
      }

      /* 转移：本期出现 u，下期出现 v */
      if (i > 0) {
        var prev = drawsByIndex[i - 1], inPrev = {};
        for (j = 0; j < prev.length; j++) inPrev[prev[j]] = 1;
        for (var pu in inPrev) {
          if (!inPrev[pu]) continue;
          transBase[pu] = (transBase[pu] || 0) + 1;
          for (var cv = 0; cv < cur.length; cv++) {
            var tv = cur[cv];
            trans[pu][tv] = (trans[pu][tv] || 0) + 1;
          }
        }
      }
    }

    /* 当前遗漏：距最近一次出现的期数（上期出现记 0） */
    for (i = 0; i < pool.length; i++) {
      v = pool[i];
      var o = 0;
      for (var t = N - 1; t >= 0; t--) {
        if (series[v][t]) break;
        o++;
      }
      omit[v] = o;
    }

    var avgOmit = {}, maxOmit = {}, curOmitZ = {};
    for (i = 0; i < pool.length; i++) {
      v = pool[i];
      var g = gaps[v];
      var avg = g.length ? mean(g) : safeDiv(N + 1, counts[v] + 1, N);
      avgOmit[v] = avg;
      maxOmit[v] = g.length ? Math.max.apply(null, g) : avg;
    }
    var omitVals = pool.map(function (x) { return omit[x]; });
    var om = mean(omitVals), osd = std(omitVals);
    for (i = 0; i < pool.length; i++) {
      v = pool[i];
      curOmitZ[v] = safeDiv(omit[v] - om, osd, 0);
    }

    /* 每期的区域特征序列 */
    var sumSeries = [], spanSeries = [], oddSeries = [], bigSeries = [];
    var zoneSeries = [], tailSeries = [], acSeries = [], consecSeries = [];
    var mid = (min + max) / 2;
    var cut1 = min + Math.floor((max - min + 1) / 3);
    var cut2 = min + Math.floor((max - min + 1) * 2 / 3);

    for (i = 0; i < N; i++) {
      var arr = drawsByIndex[i];
      sumSeries.push(sum(arr));
      spanSeries.push(arr.length ? arr[arr.length - 1] - arr[0] : 0);
      var odd = 0, big = 0, z1 = 0, z2 = 0, z3 = 0;
      for (j = 0; j < arr.length; j++) {
        if (arr[j] % 2) odd++;
        if (arr[j] > mid) big++;
        if (arr[j] <= cut1) z1++;
        else if (arr[j] <= cut2) z2++;
        else z3++;
      }
      oddSeries.push(odd);
      bigSeries.push(big);
      zoneSeries.push([z1, z2, z3]);
      var tails = {};
      for (j = 0; j < arr.length; j++) tails[arr[j] % 10] = 1;
      tailSeries.push(Object.keys(tails).map(Number));
      /* AC 值：不同差值个数 - (k-1) */
      var diffs = {};
      for (j = 0; j < arr.length; j++) {
        for (var q = j + 1; q < arr.length; q++) diffs[arr[q] - arr[j]] = 1;
      }
      acSeries.push(Math.max(0, Object.keys(diffs).length - (arr.length - 1)));
      /* 连号组数 */
      var cc = 0;
      for (j = 1; j < arr.length; j++) if (arr[j] - arr[j - 1] === 1) cc++;
      consecSeries.push(cc);
    }

    return {
      which: which,
      min: min, max: max, pool: pool, pick: pick, baseP: P,
      draws: drawsByIndex,
      last: drawsByIndex.length ? drawsByIndex[drawsByIndex.length - 1] : [],
      prev: drawsByIndex.length > 1 ? drawsByIndex[drawsByIndex.length - 2] : [],
      series: series,
      counts: counts,
      gaps: gaps,
      omit: omit,
      omitZ: curOmitZ,
      avgOmit: avgOmit,
      maxOmit: maxOmit,
      recent5: recent5, recent10: recent10, recent30: recent30,
      trans: trans, transBase: transBase,
      cooc: cooc,
      posFreq: posFreq,
      /* 特征序列 */
      sumSeries: sumSeries,
      spanSeries: spanSeries,
      oddSeries: oddSeries,
      bigSeries: bigSeries,
      zoneSeries: zoneSeries,
      tailSeries: tailSeries,
      acSeries: acSeries,
      consecSeries: consecSeries,
      cut1: cut1, cut2: cut2, mid: mid,
    };
  }

  function buildContext(game, draws, windowSize) {
    var w = Math.max(10, Math.min(windowSize || draws.length, draws.length));
    var chrono = draws.slice(0, w).reverse();
    var ctx = {
      game: game,
      gameId: game.id,
      window: chrono.length,
      chrono: chrono,
      main: buildArea(game, chrono, "main"),
      special: game.specialCount > 0 ? buildArea(game, chrono, "special") : null,
      latest: chrono[chrono.length - 1],
      latestRaw: draws[0],
      /* 奖池从原始最新一期取 */
      pool: draws[0] && draws[0].pool ? draws[0].pool : 0,
    };
    return ctx;
  }

  return {
    VERSION: VERSION,
    GAMES: GAMES,
    GAME_ORDER: GAME_ORDER,
    range: range,
    pad: pad,
    sum: sum,
    mean: mean,
    variance: variance,
    std: std,
    median: median,
    quantile: quantile,
    clamp: clamp,
    clamp01: clamp01,
    safeDiv: safeDiv,
    normalizeScores: normalizeScores,
    zscores: zscores,
    pearson: pearson,
    linregSlope: linregSlope,
    ema: ema,
    holt: holt,
    kalman: kalman,
    autocorr: autocorr,
    hurst: hurst,
    entropy: entropy,
    logGamma: logGamma,
    logChoose: logChoose,
    logFact: logFact,
    eachCombination: eachCombination,
    shuffle: shuffle,
    uniqueSorted: uniqueSorted,
    intersection: intersection,
    buildArea: buildArea,
    buildContext: buildContext,
  };
});
