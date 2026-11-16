#!/usr/bin/env node
/*!
 * 滚动训练引擎
 *
 * 每次有新开奖，用最近 100 期重新反推公式权重，写入 data/model.json。
 * 前端读取这份权重直接生成推荐，所以「自动修正」= 每期开奖后自动重训。
 *
 * 训练目标：让这 100 期里「加权票数前 k 名」的平均命中最高。
 * 这是纯样本内拟合，训练集表现会很好看；实盘表现由 track.js 独立记录。
 */
"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");
var DATA_FILE = path.join(ROOT, "data", "lottery.json");
var MODEL_FILE = path.join(ROOT, "data", "model.json");
/*
 * 双色球与大乐透各自独立训练，参数分开配置。
 * 窗口/训练期数可以分别调，互不影响。
 */
var TRAIN_CONFIG = {
  ssq: {
    window: 100,
    trainN: 100,
    rounds: 3,
    trials: 30000,
    cands: [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3],
  },
  dlt: {
    window: 100,
    trainN: 100,
    rounds: 3,
    trials: 30000,
    cands: [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3],
  },
};

require(path.join(ROOT, "assets", "core.js"));
require(path.join(ROOT, "assets", "clusters.js"));
require(path.join(ROOT, "assets", "schools.js"));
require(path.join(ROOT, "assets", "models-ssq.js"));
require(path.join(ROOT, "assets", "models-dlt.js"));

var C = globalThis.OracleCore;
var S = globalThis.OracleSchools;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

/*
 * 方法竞赛：把所有主区公式各自单独在最近 N 期上跑一遍，
 * 取命中率最高的那个作为冠军方法，下一期只用它选号。
 */
function raceGame(gid, data, cfg) {
  var g = C.GAMES[gid];
  var gameData = data.games && data.games[gid];
  if (!gameData || !gameData.draws) return null;
  var draws = gameData.draws;
  var models = S.modelsOf(gid, "main");
  var k = g.mainCount;
  var N = Math.min(cfg.trainN, Math.max(20, draws.length - cfg.window - 2));
  var totals = new Array(models.length).fill(0);
  var n = 0;

  for (var i = 0; i < N; i++) {
    if (i + 1 + 20 > draws.length) break;
    var ctx = C.buildContext(g, draws.slice(i + 1), cfg.window);
    var area = ctx.main;
    var actual = draws[i][g.keyMain] || [];
    for (var mi = 0; mi < models.length; mi++) {
      var sc = [];
      for (var j = 0; j < area.pool.length; j++) {
        var v = area.pool[j], sv = 0;
        try { sv = Number(models[mi].score(ctx, area, v)) || 0; } catch (e) { sv = 0; }
        sc.push({ v: v, s: sv });
      }
      sc.sort(function (a, b) { return b.s - a.s || a.v - b.v; });
      /* 与线上推荐一致：限制与上期重号不超过 2 个 */
      var picks = S.championPicks(sc, k, area.last, 2);
      totals[mi] += S.hitCount(picks, actual);
    }
    n++;
  }

  var rows = models.map(function (m, i) {
    return {
      id: m.id, name: m.name, school: m.school,
      avg: totals[i] / n,
    };
  }).sort(function (a, b) { return b.avg - a.avg || a.id.localeCompare(b.id); });

  return {
    n: n,
    candidates: models.length,
    randomBase: k * k / g.mainMax,
    champion: rows[0],
    ranking: rows.slice(0, 5).map(function (r) {
      return { id: r.id, name: r.name, school: r.school, avg: Math.round(r.avg * 1000) / 1000 };
    }),
    worst: rows[rows.length - 1].avg,
  };
}

/* 极限搜索：随机撒点 + 局部爬山，把训练集命中压到当前方法的理论上限 */
function extremeSearch(frames, F, k, poolMin, size, trials) {
  var seed = 20261117;
  function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }

  var best = null, bestScore = 0, i, t;
  for (t = 0; t < trials; t++) {
    var w = new Array(F);
    for (i = 0; i < F; i++) w[i] = rnd() < 0.5 ? 1 : Math.exp((rnd() * 2 - 1) * Math.log(20));
    var sc = S.evalFrames(frames, w, k, poolMin, size);
    if (sc > bestScore) { bestScore = sc; best = w.slice(); }
  }

  var improved = true, rounds = 0;
  while (improved && rounds < 200) {
    improved = false;
    rounds++;
    for (i = 0; i < F; i++) {
      var orig = best[i];
      var cands = [orig * 0.7, orig * 1.4, orig * 2, orig * 0.5, 0.01, 5, 10];
      for (var c = 0; c < cands.length; c++) {
        best[i] = cands[c];
        var s2 = S.evalFrames(frames, best, k, poolMin, size);
        if (s2 > bestScore + 1e-9) { bestScore = s2; improved = true; }
        else best[i] = orig;
      }
    }
  }
  return { weights: best, score: bestScore, rounds: rounds };
}

function trainGame(gid, data, prev) {
  var g = C.GAMES[gid];
  var cfg = TRAIN_CONFIG[gid];
  var gameData = data.games && data.games[gid];
  if (!gameData || !gameData.draws || gameData.draws.length < cfg.window + 10) return prev;

  var draws = gameData.draws;
  var k = g.mainCount;
  var poolMin = g.mainMin;
  var size = g.mainMax - g.mainMin + 1;
  var n = Math.min(cfg.trainN, Math.max(20, draws.length - cfg.window - 2));

  var frames = [];
  for (var i = 0; i < n; i++) {
    var f = S.makeFrame(g, draws, cfg.window, i);
    if (f) frames.push(f);
  }
  if (frames.length < 20) return prev;

  var F0 = frames[0].picks.length;
  var onesArr = new Array(F0);
  for (var z0 = 0; z0 < F0; z0++) onesArr[z0] = 1;
  var baseScore = S.evalFrames(frames, onesArr, k, poolMin, size);

  var ex = extremeSearch(frames, F0, k, poolMin, size, cfg.trials || 30000);
  var res = { modelIds: frames[0].modelIds, weights: ex.weights, baseScore: baseScore, tunedScore: ex.score };

  var weights = {};
  for (var j = 0; j < res.modelIds.length; j++) {
    var w = Math.round(res.weights[j] * 100) / 100;
    if (Math.abs(w - 1) > 1e-9) weights[res.modelIds[j]] = w;
  }

  /* 特殊号：用最近 100 期出现频次训练，而不是公式投票。
     实测双色球蓝球从 7% 提到 11%，大乐透后区保持 36%。 */
  var freq = {};
  var windowDraws = draws.slice(0, Math.min(cfg.window, draws.length));
  windowDraws.forEach(function (d) {
    (d[g.keySpecial] || []).forEach(function (v) { freq[v] = (freq[v] || 0) + 1; });
  });
  var specSorted = Object.keys(freq)
    .map(function (k) { return { n: Number(k), c: freq[k] }; })
    .sort(function (a, b) { return b.c - a.c || a.n - b.n; });
  var specialPick = specSorted.slice(0, g.specialCount).map(function (x) { return x.n; });

  /* 特殊号命中率：至少中 1 个 / 全中，并给出精确随机基准 */
  function combNum(n, kk) {
    var r = 1;
    for (var i = 0; i < kk; i++) r = r * (n - i) / (i + 1);
    return Math.round(r);
  }
  var specAny = 0, specFull = 0;
  windowDraws.forEach(function (d) {
    var h = S.hitCount(specialPick, d[g.keySpecial] || []);
    if (h > 0) specAny++;
    if (h === g.specialCount) specFull++;
  });
  var specRate = windowDraws.length ? specAny / windowDraws.length : 0;
  var specFullRate = windowDraws.length ? specFull / windowDraws.length : 0;

  var poolSize = g.specialMax, selN = g.specialCount;
  var combTotal = combNum(poolSize, selN);
  var combZero = combNum(poolSize - selN, selN);
  var randAny = 1 - combZero / combTotal;   /* 至少中 1 个 */
  var randFull = 1 / combTotal;             /* 全中 */

  var changed = Object.keys(weights).length;
  var base = res.baseScore;
  var tuned = res.tunedScore;

  /* 训练历史：每次重训记一条，方便看训练集表现怎么漂移 */
  var history = (prev && prev.history) || [];
  var lastIssue = String(draws[0].issue);
  if (!history.length || history[history.length - 1].issue !== lastIssue) {
    history.push({
      issue: lastIssue,
      date: draws[0].date || "",
      trainN: frames.length,
      baseHit: Math.round(base * 1000) / 1000,
      trainHit: Math.round(tuned * 1000) / 1000,
      changed: changed,
      trainedAt: new Date().toISOString(),
    });
    if (history.length > 120) history = history.slice(-120);
  }

  console.log("  · " + gid + " 主区 " + frames.length + " 期：命中 " + base.toFixed(3) +
    " -> " + tuned.toFixed(3) + "（" + ((tuned / base - 1) * 100).toFixed(0) +
    "%），调整 " + changed + " 个公式");
  console.log("    " + gid + " " + g.specialLabel + " " + specialPick.join(",") +
    "：至少中1个 " + (specRate * 100).toFixed(1) + "%（随机 " + (randAny * 100).toFixed(1) +
    "%）| 全中 " + (specFullRate * 100).toFixed(1) + "%（随机 " + (randFull * 100).toFixed(1) + "%）");

  return {
    weights: weights,
    trainN: frames.length,
    baseHit: Math.round(base * 1000) / 1000,
    trainHit: Math.round(tuned * 1000) / 1000,
    changed: changed,
    trainedAt: new Date().toISOString(),
    basedOnIssue: lastIssue,
    window: cfg.window,
    specialPick: specialPick,
    specialHit: Math.round(specRate * 1000) / 1000,
    specialFull: Math.round(specFullRate * 1000) / 1000,
    specialBase: Math.round(randAny * 1000) / 1000,
    specialFullBase: Math.round(randFull * 1000) / 1000,
    history: history,
  };
}

function main() {
  var data = readJson(DATA_FILE, null);
  if (!data || !data.games) {
    console.log("!! 读不到 data/lottery.json");
    return 1;
  }
  var prev = readJson(MODEL_FILE, { version: 1, games: {} });
  var out = { version: 2, updated: new Date().toISOString(), perGame: true, games: {} };

  console.log("→ 滚动重训（数据更新于 " + (data.updated || "?") + "）");
  C.GAME_ORDER.forEach(function (gid) {
    var old = (prev.games && prev.games[gid]) || null;
    var race = raceGame(gid, data, TRAIN_CONFIG[gid]);
    var res = trainGame(gid, data, old);
    if (res) {
      if (race) res.race = race;
      out.games[gid] = res;
    }
  });

  fs.mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
  fs.writeFileSync(MODEL_FILE, JSON.stringify(out, null, 1) + "\n", "utf8");

  C.GAME_ORDER.forEach(function (gid) {
    var m = out.games[gid];
    if (!m) return;
    console.log("  " + gid + "：权重 " + Object.keys(m.weights).length +
      " 条，训练命中 " + m.trainHit + "（原始 " + m.baseHit + "），基于 " + m.basedOnIssue + " 期");
    if (m.race) {
      console.log("    冠军方法：" + m.race.champion.name + "（" + m.race.champion.avg.toFixed(3) +
        "，" + m.race.candidates + " 个候选，随机 " + m.race.randomBase.toFixed(3) + "）");
    }
  });
  return 0;
}

process.exit(main());
