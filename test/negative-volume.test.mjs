// ガード試験：量に負の値・非数値を入れても中毒%の合計が下がらないこと（ISSUE-001）
//
// 実行方法: node --test test/negative-volume.test.mjs
// 追加の依存なし（Node.js 標準の test runner + vm モジュールのみ使用）。
//
// index.html 内の <script> をそのまま vm サンドボックスで実行し、
// 本番と同じコードで setVolume() / calculate() の挙動を検証する。
// DOM API は「何を呼んでも自分自身を返す」汎用スタブ（AutoStub）で代替する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// 本体の <script>...</script>（gtag や tailwind CDN の <script src=...> ではない、
// アプリロジック本体）を取り出す。DRUGS の定義を含むブロックを対象にする。
const scriptBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert.ok(
  scriptBlocks.some(s => s.includes('function setVolume')),
  'index.html からアプリ本体の <script> を抽出できること'
);
// GA計測初期化ブロック（window._evt 等）とアプリ本体ブロックを、実際の読み込み順のまま連結する
const appScript = scriptBlocks.join('\n;\n');

// ============================================================
// 汎用 DOM スタブ：何を読んでも/呼んでも自分自身(または新しいスタブ)を返す
// ============================================================
function makeAutoStub() {
  const handler = {
    get(target, prop) {
      if (prop === 'then') return undefined; // Promise判定を避ける
      if (prop === 'style' || prop === 'dataset' || prop === 'classList') {
        if (!target[prop]) target[prop] = makeAutoStub();
        return target[prop];
      }
      if (prop === 'textContent' || prop === 'innerHTML' || prop === 'value') {
        return target[prop] ?? '';
      }
      if (prop in target) return target[prop];
      // メソッド呼び出し（addEventListener, toggle, appendChild 等）は no-op 関数を返す
      const fn = (...args) => {
        // querySelector 系は新しい要素スタブ、それ以外は自分自身を返す
        if (prop === 'querySelector' || prop === 'querySelectorAll' || prop === 'createElement' || prop === 'getElementById') {
          return makeAutoStub();
        }
        return target;
      };
      target[prop] = fn;
      return fn;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  };
  return new Proxy({}, handler);
}

function loadApp() {
  const sandbox = {};
  sandbox.window = sandbox; // window === globalThis 相当
  sandbox.document = makeAutoStub();
  sandbox.console = console;
  sandbox.localStorage = { getItem: () => null, setItem: () => {} };
  sandbox.requestAnimationFrame = (cb) => { /* no-op: アニメーションは試験対象外 */ };
  vm.createContext(sandbox);
  // S・DRUGS は const 宣言のため、そのままだとグローバルオブジェクト(sandbox)の
  // プロパティにならない。同じコンテキスト内で window に持ち出す。
  vm.runInContext(appScript + '\nwindow.S = S; window.DRUGS = DRUGS;', sandbox, { filename: 'last-guard-app-script.js' });
  return sandbox;
}

test('setVolume: 負の値を入れると量が0として扱われる', () => {
  const sandbox = loadApp();
  sandbox.S.weight = 60;
  sandbox.S.drugs = [{ id: 'xylocaine-test', hasEpi: false, conc: 1.0, volume: 0, open: false }];
  // DRUGS にテスト用IDがないと maxMg=0 になるので、既存の lidocaine を使う
  sandbox.S.drugs = [{ id: 'lidocaine', hasEpi: false, conc: 1.0, volume: 0, open: false }];

  sandbox.setVolume('lidocaine', -5);

  const ds = sandbox.S.drugs.find(d => d.id === 'lidocaine');
  assert.equal(ds.volume, 0, '負の値は0にクランプされること');
});

test('setVolume: 非数値(NaN)を入れても量が0として扱われる', () => {
  const sandbox = loadApp();
  sandbox.S.weight = 60;
  sandbox.S.drugs = [{ id: 'lidocaine', hasEpi: false, conc: 1.0, volume: 0, open: false }];

  sandbox.setVolume('lidocaine', NaN);

  const ds = sandbox.S.drugs.find(d => d.id === 'lidocaine');
  assert.equal(ds.volume, 0, 'NaN は0にクランプされること');
});

test('calculate: マイナスの薬剤を追加しても合計%が下がらない（本来の再現手順）', () => {
  const sandbox = loadApp();
  sandbox.S.weight = 60;
  // Bupivacaine 20mL(100mg) で 83% DANGER の状態を作る
  sandbox.S.drugs = [
    { id: 'bupivacaine', hasEpi: false, conc: 0.5, volume: 20, open: false },
  ];
  sandbox.calculate();
  const pctBefore = (() => {
    let frac = 0;
    sandbox.S.drugs.forEach(ds => {
      const d = sandbox.DRUGS.find(x => x.id === ds.id);
      const maxMg = (ds.hasEpi ? d.epi : d.plain) * sandbox.S.weight;
      const mg = Math.max(0, ds.volume) * ds.conc * 10;
      if (maxMg > 0) frac += mg / maxMg;
    });
    return frac * 100;
  })();
  assert.ok(pctBefore > 80, `前提確認：Bupivacaine 20mLで80%超のはず（実際 ${pctBefore.toFixed(1)}%）`);

  // Lidocaine を -5mL で追加（再現手順）
  sandbox.S.drugs.push({ id: 'lidocaine', hasEpi: false, conc: 1.0, volume: 0, open: false });
  sandbox.setVolume('lidocaine', -5);
  sandbox.calculate();

  // ガード後：Lidocaine の volume は 0 にクランプされているので、
  // 合計%は追加前の pctBefore を下回ってはいけない
  let fracAfter = 0;
  sandbox.S.drugs.forEach(ds => {
    const d = sandbox.DRUGS.find(x => x.id === ds.id);
    const maxMg = (ds.hasEpi ? d.epi : d.plain) * sandbox.S.weight;
    const mg = Math.max(0, ds.volume) * ds.conc * 10;
    if (maxMg > 0) fracAfter += mg / maxMg;
  });
  const pctAfter = fracAfter * 100;

  assert.ok(
    pctAfter >= pctBefore - 0.01,
    `マイナスの量を追加しても合計%は下がらないこと（前 ${pctBefore.toFixed(1)}% → 後 ${pctAfter.toFixed(1)}%）`
  );
});
