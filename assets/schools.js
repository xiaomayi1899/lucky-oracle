/*!
 * 数理投票选号 · 投票与组合引擎
 *
 * 硬约束：公式按彩种独立注册。双色球公式 id 必须以 "ssq_" 开头，
 * 大乐透公式 id 必须以 "dlt_" 开头；交叉注册会直接抛错。
 * 双色球与大乐透的公式、参数、号码池完全分开，互不可见。
 */
(function (root, factory) {
  var C = root.OracleCore;
  if (!C && typeof require === "function") {
    try { C = require("./core.js"); } catch (e) { C = null; }
  }
  var api = factory(C);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.OracleSchools = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (C) {
  "use strict";

  if (!C) throw new Error("OracleSchools 需要先加载 OracleCore");

  /* ==================== 学科定义 ==================== */

  var SCHOOLS = {
    trend: {
      id: "trend", name: "开奖走势学", short: "走势", color: "#e2453c",
      desc: "从号码的冷热、遗漏、重号、邻号、斜连、区间轮动中寻找「形状」",
    },
    probability: {
      id: "probability", name: "概率学", short: "概率", color: "#2f7ad8",
      desc: "超几何、二项、泊松、几何分布与贝叶斯后验，用分布刻画号码的出现机会",
    },
    statistics: {
      id: "statistics", name: "统计学", short: "统计", color: "#1a9e78",
      desc: "频率、卡方、Z 分数、置信区间、相关性与信息熵，检验偏差是否显著",
    },
    psychology: {
      id: "psychology", name: "心理学", short: "心理", color: "#9b59b6",
      desc: "生日号、吉利号、视觉模式、热手与赌徒谬误，刻画大众的选号偏好",
    },
    game: {
      id: "game", name: "博弈学", short: "博弈", color: "#c9920a",
      desc: "拥挤度、奖池分摊、少数者博弈与混合策略，估计一注号码的「撞号」风险",
    },
    futures: {
      id: "futures", name: "未来学", short: "未来", color: "#0f9bb5",
      desc: "趋势外推、周期分解、卡尔曼滤波、情景树与灰色预测，推演可能的走向",
    },
  };

  var SCHOOL_ORDER = ["trend", "probability", "statistics", "psychology", "game", "futures"];

  /* ==================== 注册表 ==================== */

  var REGISTRY = {
    ssq: { main: [], special: [] },
    dlt: { main: [], special: [] },
  };

  function register(gameId, models) {
    var bucket = REGISTRY[gameId];
    if (!bucket) throw new Error("未知彩种：" + gameId);
    var prefix = gameId + "_";
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      if (String(m.id).indexOf(prefix) !== 0) {
        throw new Error("公式 " + m.id + " 不属于彩种 " + gameId + "（必须以 " + prefix + " 开头）");
      }
      if (!SCHOOLS[m.school]) throw new Error("公式 " + m.id + " 的学科无效：" + m.school);
      var target = m.target === "special" ? "special" : "main";
      var exists = bucket[target].some(function (x) { return x.id === m.id; });
      if (exists) throw new Error("公式 id 重复：" + m.id);
      bucket[target].push({
        id: m.id,
        name: m.name,
        school: m.school,
        formula: m.formula || "",
        weight: m.weight || 1,
        score: m.score,
      });
    }
  }

  function modelCount(gameId) {
    var b = REGISTRY[gameId];
    return b ? b.main.length + b.special.length : 0;
  }

  function modelsOf(gameId, target) {
    var b = REGISTRY[gameId];
    if (!b) return [];
    return b[target === "special" ? "special" : "main"];
  }

  /* ==================== 单目标投票 ==================== */

  function voteK(area) {
    /* 每个公式给最看好的前几个号码各投 1 票 */
    if (area.pool.length <= 20) return 3;
    return Math.max(3, Math.min(4, Math.round(area.pool.length / 11)));
  }

  function safeNum(x) { return isFinite(x) ? x : 0; }

  function evaluate(ctx, target, weights) {
    var area = target === "special" ? ctx.special : ctx.main;
    if (!area) return null;
    var models = modelsOf(ctx.gameId, target);
    var pool = area.pool;
    var K = voteK(area);

    var votes = {}, wvotes = {}, scoreSum = {}, winnerBy = {};
    var i, j;
    for (i = 0; i < pool.length; i++) {
      votes[pool[i]] = 0;
      wvotes[pool[i]] = 0;
      scoreSum[pool[i]] = 0;
      winnerBy[pool[i]] = [];
    }

    var rows = [];
    for (i = 0; i < models.length; i++) {
      var m = models[i];
      /* 权重：优化后按公式权重计票，未优化时全部为 1 */
      var w = weights && weights[m.id] !== undefined ? safeNum(weights[m.id]) : 1;
      var items = [];
      for (j = 0; j < pool.length; j++) {
        var v = pool[j];
        var sc;
        try { sc = safeNum(m.score(ctx, area, v)); } catch (e) { sc = 0; }
        items.push({ v: v, s: sc });
      }
      var norm = C.normalizeScores(items);
      norm.sort(function (a, b) { return b.s - a.s || a.v - b.v; });
      var top = norm.slice(0, K);
      for (j = 0; j < top.length; j++) {
        votes[top[j].v] += 1;
        wvotes[top[j].v] += w;
        winnerBy[top[j].v].push(m.id);
      }
      for (j = 0; j < norm.length; j++) {
        scoreSum[norm[j].v] += norm[j].s * m.weight;
      }
      rows.push({
        id: m.id, name: m.name, school: m.school,
        formula: m.formula, weight: w,
        top: top.map(function (x) { return x.v; }),
        topScores: top.map(function (x) { return x.s; }),
      });
    }

    var sorted = pool.map(function (v) {
      return { n: v, votes: wvotes[v], count: votes[v], score: scoreSum[v] };
    }).sort(function (a, b) {
      return b.votes - a.votes || b.count - a.count || b.score - a.score || a.n - b.n;
    });

    return {
      target: target,
      area: area,
      voteK: K,
      modelCount: models.length,
      votes: wvotes,
      counts: votes,
      scores: scoreSum,
      sorted: sorted,
      models: rows,
      winnerBy: winnerBy,
      maxVotes: sorted.length ? sorted[0].votes : 0,
      totalVotes: models.length * K,
      weighted: !!weights,
    };
  }

  /* ==================== 组合选择 ==================== */

  function totalVotesOf(sorted, nums) {
    var map = {};
    for (var i = 0; i < sorted.length; i++) map[sorted[i].n] = sorted[i].votes;
    var s = 0;
    for (var j = 0; j < nums.length; j++) s += map[nums[j]] || 0;
    return s;
  }

  function totalScoreOf(sorted, nums) {
    var map = {};
    for (var i = 0; i < sorted.length; i++) map[sorted[i].n] = sorted[i].score;
    var s = 0;
    for (var j = 0; j < nums.length; j++) s += map[nums[j]] || 0;
    return s;
  }

  /*
   * 主推荐：票数最高的前 k 个号码（同票按归一化总分，再按号码本身）。
   * 备选：候选池（前 poolSize 名）中，与主推荐至少差 minDiff 个号码，
   *       且组合总票数最大的那一组。
   */
  function pickSets(sorted, k, poolSize, minDiff) {
    var primary = sorted.slice(0, k).map(function (x) { return x.n; })
      .sort(function (a, b) { return a - b; });

    var cand = sorted.slice(0, Math.min(sorted.length, poolSize || 14));
    var candNums = cand.map(function (x) { return x.n; });
    var best = null;

    if (candNums.length >= k) {
      C.eachCombination(candNums, k, function (comb) {
        var diff = 0;
        for (var i = 0; i < comb.length; i++) {
          if (primary.indexOf(comb[i]) < 0) diff++;
        }
        if (diff < (minDiff || 1)) return;
        var vs = totalVotesOf(sorted, comb);
        var ss = totalScoreOf(sorted, comb);
        if (!best || vs > best.votes || (vs === best.votes && ss > best.score)) {
          best = { nums: comb.slice().sort(function (a, b) { return a - b; }), votes: vs, score: ss };
        }
      });
    }

    var maxVotes = primary.length ? Math.max.apply(null, primary.map(function (n) {
      for (var i = 0; i < sorted.length; i++) if (sorted[i].n === n) return sorted[i].votes;
      return 0;
    })) : 0;

    return {
      primary: primary,
      primaryVotes: totalVotesOf(sorted, primary),
      primaryScore: totalScoreOf(sorted, primary),
      alt: best ? best.nums : [],
      altVotes: best ? best.votes : 0,
      altScore: best ? best.score : 0,
    };
  }

  /* ==================== 完整推荐 ==================== */

  function recommend(ctx, opts) {
    var weights = opts && opts.weights ? opts.weights : null;
    var mainEval = evaluate(ctx, "main", weights);
    var specEval = ctx.game.specialCount > 0 ? evaluate(ctx, "special", weights) : null;

    var mainSets = pickSets(mainEval.sorted, ctx.game.mainCount, 14, 2);
    var specSets = specEval ? pickSets(specEval.sorted, ctx.game.specialCount, 10, 1) : null;

    var pickMain = mainSets.primary;
    var pickSpec = specSets ? specSets.primary : [];

    /* 学科贡献：最终号码获得了哪些学科多少票 */
    var schoolStats = {};
    SCHOOL_ORDER.forEach(function (sid) {
      schoolStats[sid] = { main: 0, special: 0, models: 0, hitModels: 0 };
    });

    function tally(ev, nums, field) {
      if (!ev) return;
      ev.models.forEach(function (m) {
        schoolStats[m.school].models += 1;
        var hit = m.top.some(function (v) { return nums.indexOf(v) >= 0; });
        if (hit) {
          schoolStats[m.school].hitModels += 1;
          schoolStats[m.school][field] += m.top.filter(function (v) { return nums.indexOf(v) >= 0; }).length;
        }
      });
    }
    tally(mainEval, pickMain, "main");
    tally(specEval, pickSpec, "special");

    return {
      main: {
        primary: pickMain,
        primaryVotes: mainSets.primaryVotes,
        primaryScore: mainSets.primaryScore,
        alt: mainSets.alt,
        altVotes: mainSets.altVotes,
        sorted: mainEval.sorted,
        votes: mainEval.votes,
        models: mainEval.models,
        voteK: mainEval.voteK,
        modelCount: mainEval.modelCount,
        totalVotes: mainEval.totalVotes,
        maxVotes: mainEval.maxVotes,
      },
      special: specEval ? {
        primary: pickSpec,
        primaryVotes: specSets.primaryVotes,
        primaryScore: specSets.primaryScore,
        alt: specSets.alt,
        altVotes: specSets.altVotes,
        sorted: specEval.sorted,
        votes: specEval.votes,
        models: specEval.models,
        voteK: specEval.voteK,
        modelCount: specEval.modelCount,
        totalVotes: specEval.totalVotes,
        maxVotes: specEval.maxVotes,
      } : null,
      schoolStats: schoolStats,
      totalModels: mainEval.modelCount + (specEval ? specEval.modelCount : 0),
      totalVotes: mainEval.totalVotes + (specEval ? specEval.totalVotes : 0),
    };
  }

  /* ==================== 权重优化 ==================== */

  /* 只算主区每个公式的 topK，不做计票，供训练集使用 */
  function mainPicks(ctx) {
    var area = ctx.main;
    var models = modelsOf(ctx.gameId, "main");
    var K = voteK(area);
    var picks = [], ids = [];
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var items = [];
      for (var j = 0; j < area.pool.length; j++) {
        var v = area.pool[j], sc;
        try { sc = safeNum(m.score(ctx, area, v)); } catch (e) { sc = 0; }
        items.push({ v: v, s: sc });
      }
      var norm = C.normalizeScores(items);
      norm.sort(function (a, b) { return b.s - a.s || a.v - b.v; });
      picks.push(norm.slice(0, K).map(function (x) { return x.v; }));
      ids.push(m.id);
    }
    return { picks: picks, ids: ids };
  }

  /* 构造一期的训练样本：各公式的投票 + 实际开奖 */
  function makeFrame(game, draws, windowSize, idx) {
    if (idx < 0 || idx >= draws.length) return null;
    var history = draws.slice(idx + 1);
    if (history.length < 20) return null;
    var ctx = C.buildContext(game, history, windowSize);
    var p = mainPicks(ctx);
    var actual = (draws[idx][game.keyMain] || []).slice().sort(function (a, b) { return a - b; });
    var size = game.mainMax - game.mainMin + 1;
    var set = new Uint8Array(size);
    for (var i = 0; i < actual.length; i++) set[actual[i] - game.mainMin] = 1;
    return {
      issue: draws[idx].issue,
      picks: p.picks,
      modelIds: p.ids,
      actual: actual,
      set: set,
    };
  }

  /*
   * 给定一组权重，计算训练集上「取加权票数前 k 名」的平均命中数。
   * 这是优化的目标函数，纯数值计算，不涉及 DOM。
   */
  function evalFrames(frames, weights, k, poolMin, size) {
    var total = 0;
    var buf = new Float64Array(size);
    var topV = new Float64Array(k);
    var topI = new Int32Array(k);

    for (var t = 0; t < frames.length; t++) {
      buf.fill(0);
      var fr = frames[t];
      var picks = fr.picks;
      for (var mi = 0; mi < picks.length; mi++) {
        var w = weights[mi];
        if (!w) continue;
        var arr = picks[mi];
        for (var j = 0; j < arr.length; j++) buf[arr[j] - poolMin] += w;
      }

      var cnt = 0;
      for (var v = 0; v < size; v++) {
        var sc = buf[v];
        if (sc <= 0) continue;
        var p = cnt < k ? cnt : k - 1;
        if (cnt >= k && sc <= topV[k - 1]) continue;
        while (p > 0 && topV[p - 1] < sc) {
          topV[p] = topV[p - 1];
          topI[p] = topI[p - 1];
          p--;
        }
        topV[p] = sc;
        topI[p] = v;
        if (cnt < k) cnt++;
      }

      var hit = 0;
      for (var a = 0; a < cnt; a++) if (fr.set[topI[a]]) hit++;
      total += hit;
    }
    return frames.length ? total / frames.length : 0;
  }

  /*
   * 坐标上升优化器：逐个公式尝试候选权重，保留让训练集平均命中提升的那个。
   * 通过 stepOne() 分批推进，避免阻塞主线程。
   */
  function createOptimizer(frames, k, poolMin, size, opts) {
    var o = opts || {};
    var cands = o.cands || [0.25, 0.5, 1, 1.5, 2, 2.5, 3];
    var rounds = o.rounds || 2;
    /*
     * 稳健模式：传入 folds（把训练期切成两段）。
     * 只有候选权重在每一折上都不下降时才接受，显著抑制过拟合。
     */
    var folds = o.folds && o.folds.length ? o.folds : null;
    if (!frames.length) return null;

    var F = frames[0].picks.length;
    var weights = new Array(F);
    for (var i = 0; i < F; i++) weights[i] = 1;

    var base = evalFrames(frames, weights, k, poolMin, size);
    var best = base;
    var bestFolds = folds ? folds.map(function (fr) { return evalFrames(fr, weights, k, poolMin, size); }) : null;
    var st = { f: 0, round: 0, steps: 0, totalSteps: F * rounds, finished: false };

    function avg(a) { var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return a.length ? t / a.length : 0; }

    function stepOne() {
      if (st.finished) return true;
      var f = st.f;
      var orig = weights[f];
      var bestW = orig;

      if (folds) {
        var bestAvg = avg(bestFolds);
        var bestScs = bestFolds;
        for (var c = 0; c < cands.length; c++) {
          if (cands[c] === orig) continue;
          weights[f] = cands[c];
          var scs = [], noWorse = true;
          for (var fi = 0; fi < folds.length; fi++) {
            var sc = evalFrames(folds[fi], weights, k, poolMin, size);
            scs.push(sc);
            if (sc < bestFolds[fi] - 1e-9) { noWorse = false; break; }
          }
          if (noWorse) {
            var av = avg(scs);
            if (av > bestAvg + 1e-9) { bestW = cands[c]; bestAvg = av; bestScs = scs; }
          }
        }
        weights[f] = bestW;
        if (bestW !== orig) bestFolds = bestScs;
      } else {
        var bestLocal = best;
        for (var d = 0; d < cands.length; d++) {
          if (cands[d] === orig) continue;
          weights[f] = cands[d];
          var s2 = evalFrames(frames, weights, k, poolMin, size);
          if (s2 > bestLocal + 1e-9) { bestLocal = s2; bestW = cands[d]; }
        }
        weights[f] = bestW;
        if (bestW !== orig) best = bestLocal;
      }

      st.f++;
      st.steps++;
      if (st.f >= F) {
        st.f = 0;
        st.round++;
        if (st.round >= rounds) st.finished = true;
      }
      return st.finished;
    }

    return {
      state: st,
      progress: function () { return st.totalSteps ? st.steps / st.totalSteps : 1; },
      stepOne: stepOne,
      result: function () {
        var changed = 0, down = 0, up = 0;
        for (var i = 0; i < F; i++) {
          if (Math.abs(weights[i] - 1) > 1e-9) changed++;
          if (weights[i] < 1 - 1e-9) down++;
          if (weights[i] > 1 + 1e-9) up++;
        }
        return {
          modelIds: frames[0].modelIds,
          weights: weights.slice(),
          baseScore: base,
          tunedScore: evalFrames(frames, weights, k, poolMin, size),
          foldScores: folds ? folds.map(function (fr) { return evalFrames(fr, weights, k, poolMin, size); }) : null,
          foldBase: folds ? folds.map(function (fr) {
            var one = [];
            for (var i = 0; i < F; i++) one.push(1);
            return evalFrames(fr, one, k, poolMin, size);
          }) : null,
          changed: changed,
          downweighted: down,
          upweighted: up,
          robust: !!folds,
          frames: frames.length,
        };
      },
    };
  }

  function weightMap(modelIds, weights) {
    var m = {};
    for (var i = 0; i < modelIds.length; i++) m[modelIds[i]] = weights[i];
    return m;
  }

  /* ==================== 回测 ==================== */

  function hitCount(pick, actual) {
    var n = 0;
    for (var i = 0; i < pick.length; i++) {
      if (actual.indexOf(pick[i]) >= 0) n++;
    }
    return n;
  }

  function backtest(game, draws, windowSize, periods) {
    var out = [];
    var limit = Math.min(periods || 30, draws.length - Math.max(20, windowSize) - 1);
    if (limit <= 0) return out;

    for (var i = 0; i < limit; i++) {
      var history = draws.slice(i + 1);
      var ctx = C.buildContext(game, history, windowSize);
      var rec = recommend(ctx);
      var actualDraw = draws[i];
      var actualMain = (actualDraw[game.keyMain] || []).slice().sort(function (a, b) { return a - b; });
      var actualSpec = game.specialCount > 0
        ? (actualDraw[game.keySpecial] || []).slice().sort(function (a, b) { return a - b; })
        : [];
      out.push({
        issue: actualDraw.issue,
        date: actualDraw.date,
        mainHit: hitCount(rec.main.primary, actualMain),
        mainCount: game.mainCount,
        specialHit: game.specialCount > 0 ? hitCount(rec.special.primary, actualSpec) : 0,
        specialCount: game.specialCount,
        pickMain: rec.main.primary,
        pickSpec: rec.special ? rec.special.primary : [],
        actualMain: actualMain,
        actualSpec: actualSpec,
      });
    }
    return out;
  }

  function backtestSummary(rows) {
    if (!rows.length) return null;
    var mh = 0, sh = 0, maxMain = 0;
    var dist = {};
    for (var i = 0; i < rows.length; i++) {
      mh += rows[i].mainHit;
      sh += rows[i].specialHit;
      if (rows[i].mainHit > maxMain) maxMain = rows[i].mainHit;
      dist[rows[i].mainHit] = (dist[rows[i].mainHit] || 0) + 1;
    }
    return {
      periods: rows.length,
      avgMain: mh / rows.length,
      avgSpecial: sh / rows.length,
      maxMain: maxMain,
      dist: dist,
      /* 完全随机情况下的期望命中：k * k / 池大小 */
      randomMain: null,
    };
  }

  return {
    SCHOOLS: SCHOOLS,
    SCHOOL_ORDER: SCHOOL_ORDER,
    register: register,
    modelCount: modelCount,
    modelsOf: modelsOf,
    evaluate: evaluate,
    recommend: recommend,
    pickSets: pickSets,
    backtest: backtest,
    makeFrame: makeFrame,
    evalFrames: evalFrames,
    createOptimizer: createOptimizer,
    weightMap: weightMap,
    backtestSummary: backtestSummary,
    totalVotesOf: totalVotesOf,
    hitCount: hitCount,
  };
});
