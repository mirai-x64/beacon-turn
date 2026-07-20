// CDP 検証ハーネス(成果物には含めない)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9000 + Math.floor(Math.random() * 900);      // 実行ごとに変える
const PROFILE = mkdtempSync(join(tmpdir(), "bt-prof-"));  // 前回の残骸に繋がない

const chrome = spawn("/usr/bin/google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--window-size=900,620", "about:blank",
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error("chrome did not come up");
}

const ws = new WebSocket(await wsUrl());
await new Promise(r => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise(res => {
    pending.set(msgId, res);
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });
}

const { result: { targetId } } =
  await send("Target.createTarget", { url: "about:blank" });
const { result: { sessionId } } =
  await send("Target.attachToTarget", { targetId, flatten: true });

const S = (m, p) => send(m, p, sessionId);
await S("Page.enable"); await S("Runtime.enable");

async function evalIn(expr) {
  const r = await S("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.result?.exceptionDetails)
    throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}

// rAF を合成タイムスタンプに差し替え、実時間より速く決定論的に回す
const FAST_RAF = `
(() => {
  let t = 0, queue = [];
  window.__tick = (n) => {
    for (let i = 0; i < n; i++) {
      t += 1000 / 60;
      const q = queue; queue = [];
      for (const fn of q) fn(t);
    }
  };
  window.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
})();
`;

async function load(url) {
  await S("Page.addScriptToEvaluateOnNewDocument", { source: FAST_RAF });
  await S("Page.navigate", { url });
  await sleep(700);
}

const out = [];
const say = s => { out.push(s); console.log(s); };

// ---------------------------------------------------------------- 1. 起動

await load("file:///tmp/beacon-turn/index.html");
await evalIn("__tick(1)");
const boot = await evalIn(`({
  alive: __game.alive, state: __game.state,
  speed: Math.round(__game.speed), px: __game.paddle.x, dir: __game.paddle.dir
})`);
say(`[起動] state=${boot.state} 霧=${boot.alive}枚 帯速=${boot.speed}px/s ` +
    `パドル=${boot.px} 向き=${boot.dir > 0 ? "右" : "左"}`);

// ---------------------------------------------------------------- 2. 初手強制

// 一切押さずに 1 球目を見送ると必ず落とすか
await evalIn("__game.reset()");
const noPress = await evalIn(`(() => {
  const before = __game.alive;
  for (let i = 0; i < 130; i++) {          // ~2.2s ぶん
    __tick(1);
    if (__game.ball.y > 600) break;
  }
  __tick(20);
  return { alive: __game.alive, missed: __game.alive >= before };
})()`);
say(`[初手] 押さずに見送る → 落球=${noPress.missed ? "した" : "しなかった"}`);

// 適時に一度だけ折り返せば拾えるか(t=0.49s 付近が理論上の最適)
const oneFlip = await evalIn(`(() => {
  const res = [];
  for (const flipFrame of [22, 26, 29, 33, 37, 41]) {
    __game.reset();
    let caught = false;
    for (let i = 0; i < 130; i++) {
      if (i === flipFrame) __game.press();
      const yBefore = __game.ball.y;
      __tick(1);
      if (yBefore > 500 && __game.ball.vy < 0) { caught = true; break; }
      if (__game.ball.y > 620) break;
    }
    res.push([ (flipFrame/60).toFixed(2), caught ]);
  }
  return res;
})()`);
say(`[初手] 1回だけ折り返した場合 (押した秒, 拾えたか): ` +
    oneFlip.map(([t, c]) => `${t}s=${c ? "○" : "×"}`).join(" "));

// ---------------------------------------------------------------- 3. ホバー可否

async function hoverSpan(aliveN, tapMs) {
  return await evalIn(`(() => {
    __game.reset();
    __game.clearAllBut(${aliveN});
    const v = __game.speed;
    let min = 1e9, max = -1e9, acc = 0;
    for (let i = 0; i < 120; i++) {        // 2s
      acc += 1000/60;
      while (acc >= ${tapMs}) { acc -= ${tapMs}; __game.press(); }
      __tick(1);
      __game.clearAllBut(${aliveN});       // 落球で速度が戻るのを抑える
      const x = __game.paddle.x;
      if (x > 200 && x < 700) { min = Math.min(min, x); max = Math.max(max, x); }
    }
    return { speed: Math.round(v), span: Math.round(max - min) };
  })()`);
}

const PWIDTH = 110;
say("");
say(`[ホバー] 連打で作れる振れ幅 (帯の幅 ${PWIDTH}px を超えたら一点に留まれない)`);
for (const tap of [100, 120]) {
  for (const n of [40, 20, 5, 1]) {
    const h = await hoverSpan(n, tap);
    const ok = h.span > PWIDTH;
    say(`  残${String(n).padStart(2)}枚 帯速=${String(h.speed).padStart(4)}px/s ` +
        `連打${tap}ms → 振れ幅 ${String(h.span).padStart(3)}px  ` +
        `${ok ? "★ 幅を超える(留まれない)" : "  幅の内(留まれる)"}`);
  }
}

// ---------------------------------------------------------------- 4. 通し

// 反応遅れ付きの自動操縦。完璧AIだと難度が測れないので必ず遅らせる。
const AUTOPLAY = delayFrames => `(() => {
  __game.reset();
  const hist = [];
  let frames = 0, misses = 0, prevAlive = 40;
  const trace = [];
  while (frames < 60 * 300 && __game.state !== "clear") {
    hist.push({ bx: __game.ball.x, px: __game.paddle.x, dir: __game.paddle.dir });
    if (hist.length > ${delayFrames}) {
      const s = hist[hist.length - 1 - ${delayFrames}];
      // 見えている位置へ向かうだけの素朴な操縦(=連打ホバーと同じ戦略)
      if (s.px < s.bx && s.dir < 0) __game.press();
      if (s.px > s.bx && s.dir > 0) __game.press();
    }
    __tick(1);
    frames++;
    const a = __game.alive;
    if (a > prevAlive) misses++;
    if (a !== prevAlive) trace.push([Math.round(frames/60), a, Math.round(__game.speed)]);
    prevAlive = a;
  }
  return { cleared: __game.state === "clear", secs: Math.round(frames/60),
           alive: __game.alive, misses, trace: trace.slice(-6) };
})()`;

say("");
for (const d of [6, 12]) {
  const r = await evalIn(AUTOPLAY(d));
  say(`[通し・素朴] 反応遅れ${Math.round(d/60*1000)}ms → ` +
      (r.cleared ? `クリア (${r.secs}s, 落球${r.misses}回)`
                 : `未クリア 残${r.alive}枚 (${r.secs}s, 落球${r.misses}回)`));
  say(`             推移 [秒,残枚,帯速]: ` +
      r.trace.map(t => `[${t[0]}s,${t[1]},${t[2]}]`).join(" "));
}

// 着弾点を読んで折り返しを"予定"する操縦。熟練プレイヤー相当。
// これでクリアできなければ、そもそも人間に踏破できない面ということになる。
const PLANNER = delayFrames => `(() => {
  const PY = 568, BR = 7, W = 900, PW = 110;

  // 自由飛行の着弾点(壁反射を折り返しで畳む)。霧の当たりは無視し、毎フレーム読み直す。
  function predict(b) {
    if (b.vy <= 0) return null;
    const T = (PY - BR - b.y) / b.vy;
    if (T <= 0) return null;
    const lo = BR, hi = W - BR, span = hi - lo;
    let u = (b.x + b.vx * T - lo) % (2 * span);
    if (u < 0) u += 2 * span;
    return { x: lo + (u > span ? 2 * span - u : u), T };
  }

  // 現在向きのまま / 今折り返す、を時刻Tまで進めて誤差の小さい方を採る
  function simPaddle(px, dir, v, T) {
    const half = PW / 2, lo = half, hi = W - half;
    let x = px, d = dir, t = T;
    while (t > 0) {
      const wall = d > 0 ? hi : lo;
      const dt = Math.abs(wall - x) / v;
      if (dt >= t) return x + d * v * t;
      x = wall; d = -d; t -= dt;
    }
    return x;
  }

  __game.reset();
  const hist = [];
  let frames = 0, misses = 0, prevAlive = 40;
  const trace = [];
  while (frames < 60 * 600 && __game.state !== "clear") {
    hist.push({ bx: __game.ball.x, by: __game.ball.y,
                bvx: __game.ball.vx, bvy: __game.ball.vy,
                px: __game.paddle.x, dir: __game.paddle.dir, v: __game.speed });
    if (hist.length > ${delayFrames}) {
      const s = hist[hist.length - 1 - ${delayFrames}];
      const p = predict({ x: s.bx, y: s.by, vx: s.bvx, vy: s.bvy });
      if (p) {
        const keep = Math.abs(simPaddle(s.px,  s.dir, s.v, p.T) - p.x);
        const flip = Math.abs(simPaddle(s.px, -s.dir, s.v, p.T) - p.x);
        if (flip < keep) __game.press();
      }
    }
    __tick(1);
    frames++;
    const a = __game.alive;
    if (a > prevAlive) misses++;
    if (a !== prevAlive) trace.push([Math.round(frames/60), a, Math.round(__game.speed)]);
    prevAlive = a;
  }
  return { cleared: __game.state === "clear", secs: Math.round(frames/60),
           alive: __game.alive, misses, trace: trace.slice(-8) };
})()`;

say("");
for (const d of [6, 12]) {
  const r = await evalIn(PLANNER(d));
  say(`[通し・予測] 反応遅れ${Math.round(d/60*1000)}ms → ` +
      (r.cleared ? `クリア (${r.secs}s, 落球${r.misses}回)`
                 : `未クリア 残${r.alive}枚 (${r.secs}s, 落球${r.misses}回)`));
  say(`             終盤 [秒,残枚,帯速]: ` +
      r.trace.map(t => `[${t[0]}s,${t[1]},${t[2]}]`).join(" "));
}

// ---------------------------------------------------------------- 5. 見た目

await load("file:///tmp/beacon-turn/index.html");
await evalIn("__tick(40)");
let shot = await S("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/beacon-turn/shot-play.png", Buffer.from(shot.result.data, "base64"));

await evalIn("__game.clearAllBut(0); __tick(30)");
shot = await S("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/beacon-turn/shot-clear.png", Buffer.from(shot.result.data, "base64"));
say("");
say("[描画] shot-play.png / shot-clear.png を書き出した");

ws.close(); chrome.kill();
process.exit(0);
