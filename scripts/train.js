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
    cands: [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3],
  },
  dlt: {
    window: 100,
    trainN: 100,
    rounds: 3,
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

  var opt = S.createOptimizer(frames, k, poolMin, size, { rounds: cfg.rounds, cands: cfg.cands });
  var guard = 0;
  while (!opt.state.finished && guard++ < 500000) opt.stepOne();
  var res = opt.result();

  var weights = {};
  for (var j = 0; j < res.modelIds.length; j++) {
    var w = Math.round(res.weights[j] * 100) / 100;
    if (Math.abs(w - 1) > 1e-9) weights[res.modelIds[j]] = w;
  }

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

  console.log("  · " + gid + " 训练 " + frames.length + " 期：命中 " + base.toFixed(3) +
    " -> " + tuned.toFixed(3) + "（" + ((tuned / base - 1) * 100).toFixed(0) +
    "%），调整 " + changed + " 个公式");

  return {
    weights: weights,
    trainN: frames.length,
    baseHit: Math.round(base * 1000) / 1000,
    trainHit: Math.round(tuned * 1000) / 1000,
    changed: changed,
    trainedAt: new Date().toISOString(),
    basedOnIssue: lastIssue,
    window: cfg.window,
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
    var res = trainGame(gid, data, old);
    if (res) out.games[gid] = res;
  });

  fs.mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
  fs.writeFileSync(MODEL_FILE, JSON.stringify(out, null, 1) + "\n", "utf8");

  C.GAME_ORDER.forEach(function (gid) {
    var m = out.games[gid];
    if (!m) return;
    console.log("  " + gid + "：权重 " + Object.keys(m.weights).length +
      " 条，训练命中 " + m.trainHit + "（原始 " + m.baseHit + "），基于 " + m.basedOnIssue + " 期");
  });
  return 0;
}

process.exit(main());
