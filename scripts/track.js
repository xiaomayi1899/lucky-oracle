#!/usr/bin/env node
/*!
 * 实盘前瞻跟踪
 *
 * 规则：
 *   1. 每次运行，用当前已知历史计算「下一期」推荐，写入 pending（此时该期尚未开奖）。
 *   2. 下一期开奖后，用 pending 里的号码对比实际结果，生成一条记录。
 *   3. 每条记录带前一条的哈希，形成哈希链；改动任何历史记录都会断链。
 *
 * 这样记录的推荐是在开奖前生成的，无法用开奖结果倒推调参。
 * 只有 pending 缺失时（如首次部署、错过期）才回补，并标记 backfilled。
 */
"use strict";

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");

var ROOT = path.resolve(__dirname, "..");
var DATA_FILE = path.join(ROOT, "data", "lottery.json");
var TRACK_FILE = path.join(ROOT, "data", "track.json");
var WINDOW = 100;
var BACKFILL = 30;

require(path.join(ROOT, "assets", "core.js"));
require(path.join(ROOT, "assets", "clusters.js"));
require(path.join(ROOT, "assets", "schools.js"));
require(path.join(ROOT, "assets", "models-ssq.js"));
require(path.join(ROOT, "assets", "models-dlt.js"));

var C = globalThis.OracleCore;
var S = globalThis.OracleSchools;

function log(msg) { console.log(msg); }

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function hashOf(record) {
  var payload = [
    record.prevHash || "",
    record.issue,
    (record.pick || []).join(","),
    (record.special || []).join(","),
    (record.actualMain || []).join(","),
    (record.actualSpecial || []).join(","),
    record.mainHit,
    record.specialHit,
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function guessNextIssue(issue) {
  var digits = String(issue).replace(/\D/g, "");
  if (!digits) return "";
  try {
    var n = BigInt(digits) + 1n;
    var s = n.toString();
    /* 保持原位数（跨年进位会导致不匹配，届时回退为回补） */
    while (s.length < String(issue).length) s = "0" + s;
    return s;
  } catch (e) {
    return "";
  }
}

function recommendFor(gid, draws) {
  var g = C.GAMES[gid];
  var ctx = C.buildContext(g, draws, WINDOW);
  var rec = S.recommend(ctx);
  return {
    pick: rec.main.primary,
    special: rec.special ? rec.special.primary : [],
    alt: rec.main.alt,
    altSpecial: rec.special ? rec.special.alt : [],
    votes: {},
    models: rec.main.modelCount,
    clusters: rec.main.clusterCount,
  };
}

function buildRecord(pending, draw, g, backfilled) {
  var gid = g.id;
  var actualMain = (draw[g.keyMain] || []).slice().sort(function (a, b) { return a - b; });
  var actualSpecial = g.specialCount > 0
    ? (draw[g.keySpecial] || []).slice().sort(function (a, b) { return a - b; })
    : [];
  return {
    issue: String(draw.issue),
    date: draw.date || "",
    pick: pending.pick,
    special: pending.special,
    alt: pending.alt,
    altSpecial: pending.altSpecial,
    actualMain: actualMain,
    actualSpecial: actualSpecial,
    mainHit: S.hitCount(pending.pick, actualMain),
    specialHit: g.specialCount > 0 ? S.hitCount(pending.special, actualSpecial) : 0,
    generatedAt: pending.generatedAt || "",
    recordedAt: new Date().toISOString(),
    backfilled: !!backfilled,
  };
}

function trackGame(gid, data, prevBucket) {
  var g = C.GAMES[gid];
  var gameData = data.games && data.games[gid];
  if (!gameData || !gameData.draws || gameData.draws.length < WINDOW + 5) {
    log("  ! " + gid + " 数据不足，跳过");
    return prevBucket;
  }
  var draws = gameData.draws;
  var latest = draws[0];
  var bucket = (prevBucket && prevBucket.records) ? prevBucket
    : { records: [], pending: null, lastHash: "" };
  if (!bucket.records) bucket.records = [];

  var existing = {};
  bucket.records.forEach(function (r) { existing[r.issue] = true; });

  var added = 0, backfilled = 0;

  /* 1) 处理上一次写入的 pending：如果正好开了这一期，就落成记录 */
  if (bucket.pending && bucket.pending.forIssue === String(latest.issue) && !existing[latest.issue]) {
    var rec = buildRecord(bucket.pending, latest, g, false);
    rec.prevHash = bucket.lastHash || "";
    rec.hash = hashOf(rec);
    bucket.records.unshift(rec);
    bucket.lastHash = rec.hash;
    existing[latest.issue] = true;
    added++;
    log("  ✓ " + gid + " " + rec.issue + " 前瞻记录：" +
      rec.pick.join(",") + " 命中 " + rec.mainHit);
  }

  /* 2) 回补：首次部署或错过的期数，用该期之前的数据回算并标记 */
  if (bucket.records.length < BACKFILL) {
    for (var i = 0; i < draws.length && bucket.records.length < BACKFILL; i++) {
      var d = draws[i];
      if (existing[d.issue]) continue;
      var history = draws.slice(i + 1);
      if (history.length < WINDOW + 2) break;
      var pending = recommendFor(gid, history);
      pending.generatedAt = "";
      var r2 = buildRecord(pending, d, g, true);
      r2.prevHash = bucket.lastHash || "";
      r2.hash = hashOf(r2);
      bucket.records.unshift(r2);
      bucket.lastHash = r2.hash;
      existing[d.issue] = true;
      backfilled++;
    }
    if (backfilled) {
      /* unshift 逆序，回补后按时间倒序重排并重算链 */
      bucket.records.sort(function (a, b) {
        return String(b.issue).localeCompare(String(a.issue));
      });
      relink(bucket);
      log("  · " + gid + " 回补 " + backfilled + " 期（标记为 backfilled）");
    }
  }

  /* 3) 写入下一期的 pending（开奖前的推荐） */
  var nextIssue = guessNextIssue(latest.issue);
  var fresh = recommendFor(gid, draws);
  fresh.forIssue = nextIssue;
  fresh.basedOnIssue = String(latest.issue);
  fresh.generatedAt = new Date().toISOString();
  bucket.pending = fresh;

  var fwd = bucket.records.filter(function (r) { return !r.backfilled; }).length;
  log("  · " + gid + " 记录 " + bucket.records.length + " 期（前瞻 " + fwd +
    " / 回补 " + (bucket.records.length - fwd) + "），下期待开 " + nextIssue +
    " -> " + fresh.pick.join(",") + (fresh.special.length ? " +" + fresh.special.join(",") : ""));

  bucket.updated = new Date().toISOString();
  return bucket;
}

function relink(bucket) {
  var prev = "";
  /* records 是倒序（新→旧），链方向也按新→旧：每条记录指向它下面那条 */
  for (var i = bucket.records.length - 1; i >= 0; i--) {
    var r = bucket.records[i];
    r.prevHash = prev;
    r.hash = hashOf(r);
    prev = r.hash;
  }
  bucket.lastHash = bucket.records.length ? bucket.records[0].hash : "";
}

function verifyChain(bucket) {
  if (!bucket.records.length) return true;
  var expected = "";
  for (var i = bucket.records.length - 1; i >= 0; i--) {
    var r = bucket.records[i];
    if (r.prevHash !== expected) return false;
    if (hashOf(r) !== r.hash) return false;
    expected = r.hash;
  }
  return true;
}

function main() {
  var data = readJson(DATA_FILE, null);
  if (!data || !data.games) {
    log("!! 读不到 data/lottery.json");
    return 1;
  }
  var state = readJson(TRACK_FILE, { version: 1, updated: "", games: {} });
  if (!state.games) state.games = {};

  log("→ 更新实盘跟踪（数据更新于 " + (data.updated || "?") + "）");
  C.GAME_ORDER.forEach(function (gid) {
    state.games[gid] = trackGame(gid, data, state.games[gid] || {});
  });

  state.version = 1;
  state.updated = new Date().toISOString();
  state.games = state.games;
  fs.mkdirSync(path.dirname(TRACK_FILE), { recursive: true });
  fs.writeFileSync(TRACK_FILE, JSON.stringify(state, null, 1) + "\n", "utf8");

  C.GAME_ORDER.forEach(function (gid) {
    var b = state.games[gid];
    if (!b) return;
    log("  " + gid + " 链校验: " + (verifyChain(b) ? "完整" : "断裂!"));
  });
  return 0;
}

process.exit(main());
