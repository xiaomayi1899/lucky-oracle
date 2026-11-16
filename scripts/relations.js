#!/usr/bin/env node
/*!
 * 号码关系探针：共现、邻号、斜连、质合、和值。
 * 全部用历史开奖统计，并给出随机基准，方便判断关系是否真实存在。
 */
"use strict";
var fs = require("fs");
var path = require("path");
var ROOT = path.resolve(__dirname, "..");
var DATA_FILE = path.join(ROOT, "data", "lottery.json");
var OUT_FILE = path.join(ROOT, "data", "relations.json");

function isPrime(n) { if (n < 2) return false; for (var i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; }

var data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
var out = { updated: new Date().toISOString(), games: {} };

["ssq", "dlt"].forEach(function (gid) {
  var g = (function () {
    if (gid === "ssq") return { min: 1, max: 33, k: 6, key: "red" };
    return { min: 1, max: 35, k: 5, key: "front" };
  })();
  var gameData = data.games && data.games[gid];
  if (!gameData) return;
  var chrono = gameData.draws.slice().reverse();
  var N = chrono.length;
  var pool = g.max - g.min + 1;
  var base = g.k / pool;

  /* 邻号 */
  var nearHit = 0, nearTot = 0;
  for (var t = 1; t < N; t++) {
    var prev = chrono[t - 1][g.key], cur = chrono[t][g.key];
    for (var i = 0; i < prev.length; i++) {
      nearTot++;
      var x = prev[i];
      if ((x - 1 >= g.min && cur.indexOf(x - 1) >= 0) || (x + 1 <= g.max && cur.indexOf(x + 1) >= 0)) nearHit++;
    }
  }

  /* 斜连 */
  var diagHit = 0, diagTot = 0;
  for (var t2 = 2; t2 < N; t2++) {
    var p2 = chrono[t2 - 2][g.key], p1 = chrono[t2 - 1][g.key], c2 = chrono[t2][g.key];
    for (var j = 0; j < p2.length; j++) {
      var y = p2[j];
      var step = 0;
      if (p1.indexOf(y + 1) >= 0) step = 1;
      else if (p1.indexOf(y - 1) >= 0) step = -1;
      if (!step) continue;
      diagTot++;
      var nxt = y + step * 2;
      if (nxt >= g.min && nxt <= g.max && c2.indexOf(nxt) >= 0) diagHit++;
    }
  }

  /* 共现 */
  var cnt = {}, pair = {};
  chrono.forEach(function (d) {
    var arr = d[g.key].slice().sort(function (a, b) { return a - b; });
    arr.forEach(function (v) { cnt[v] = (cnt[v] || 0) + 1; });
    for (var a = 0; a < arr.length; a++) for (var b = a + 1; b < arr.length; b++) {
      var kk = arr[a] + "-" + arr[b];
      pair[kk] = (pair[kk] || 0) + 1;
    }
  });
  var pairs = Object.keys(pair).map(function (kk) {
    var ab = kk.split("-").map(Number);
    var exp = N * (cnt[ab[0]] / N) * (cnt[ab[1]] / N);
    return { a: ab[0], b: ab[1], c: pair[kk], exp: Math.round(exp * 10) / 10, lift: Math.round(pair[kk] / exp * 100) / 100 };
  }).sort(function (x, y) { return y.lift - x.lift; });

  /* 质数 */
  var oc = {};
  chrono.forEach(function (d) {
    var pn = d[g.key].filter(isPrime).length;
    oc[pn] = (oc[pn] || 0) + 1;
  });

  /* 和值 */
  var sums = chrono.map(function (d) { return d[g.key].reduce(function (a, b) { return a + b; }, 0); })
    .sort(function (a, b) { return a - b; });
  var q = function (p) { return sums[Math.floor(sums.length * p)]; };

  out.games[gid] = {
    n: N,
    near: { hit: Math.round(nearHit / nearTot * 1000) / 10, base: Math.round(Math.min(2, pool - 1) * base * 1000) / 10 },
    diag: { hit: Math.round(diagHit / diagTot * 1000) / 10, base: Math.round(base * 1000) / 10 },
    pairs: pairs.slice(0, 5),
    primes: Object.keys(oc).sort(function (a, b) { return a - b; }).map(function (k) { return { n: +k, c: oc[k] }; }),
    sums: { p10: q(0.1), median: q(0.5), p90: q(0.9) },
  };
});

fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1) + "\n", "utf8");
console.log("写入 data/relations.json");
["ssq", "dlt"].forEach(function (gid) {
  var r = out.games[gid];
  if (!r) return;
  console.log("  " + gid + " 邻号 " + r.near.hit + "%（随机 " + r.near.base + "%）| 斜连 " +
    r.diag.hit + "%（随机 " + r.diag.base + "%）| 最强共现 lift " + r.pairs[0].lift);
});
