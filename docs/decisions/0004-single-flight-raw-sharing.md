# ADR-0004: single-flight は保存形 raw を共有し、validate / decode は各呼び出しが適用する

状態: 採択（2026-07-10、オーナー承認済みタスクの実装）
関連: [0003](0003-decode-hook-raw-in-cache.md)（decode: raw-in-cache）の Consequences を実装

## 文脈

同一 URL への並行 `fetchBytes`（例: 辞書の同時 `getDictionary`、HF ファイル群の並行取得と
UI の再入）は、それぞれ network に出て二重ダウンロードになっていた（旧 limitations に凍結）。
呼び出しごとに `validate` / `decode` が異なり得るため、「何を共有し、何を呼び出し毎に行うか」
の線引きが必要。

## 決定

1. **合流の単位は「保存形 raw の取得」**（cache open/match → self-heal → network → put）。
   合流キーは `(cacheName, URL)`。同一キーの in-flight があれば network に出ず、その
   フライトの raw を受け取る。
2. **`validate` / `decode` は合流後に各呼び出しが自分のオプションで適用する**
   （ADR-0003 Consequences の直交設計）。先行呼び出し（leader）のオプションが取得側の
   self-heal / 不正物非キャッシュを駆動し、合流者の validate 失敗はその呼び出しだけ throw する。
3. **合流するのは cache 有効（= GET）呼び出しのみ**。`cache: false` は「毎回取りに行く」
   意図（非 GET・認証バリエーション等）なので合流しない。
4. **フライトは成否に依らず settle で閉じる**（失敗を記憶しない）。失敗は合流全員へ伝播し、
   後続の呼び出しは新規に取得する。
5. **`onProgress` は fan-out**: 合流者のリスナーも同一フライトの進捗を受け、合流時に直近の
   進捗を 1 回即時通知する。**リスナーの throw はリスナー毎に隔離**し、console.warn で
   通知して取得を続行する（進捗は任意情報 — 1 リスナーの事故が合流フライト全体＝他の
   呼び出しのダウンロードを巻き添えにするのを防ぐ。単独呼び出しでも同じ扱いに統一する。
   0.2.0 までは onProgress の throw がその呼び出しの取得を落としていた＝挙動変更）。

## 帰結

- 実装は同期区間で in-flight Map を check→set する（間に await を挟まない MUST —
  挟むと同一ターンの並行呼び出しが二重フライトになる TOCTOU）。単一スレッドの
  マイクロタスク意味論のみに依存し、ロック不要。
- 合流者の `fetch` / `caches` / `init` / `onCacheError` は使われない（limitations 記載）。
  DI が呼び出しごとに異なるテストは cacheName を分けて合流を避ける。
- 合流者は leader と同じ raw インスタンスを受け取る。`decode` の「raw を破壊的に変更しない
  MUST NOT」（ADR-0003）がここでも安全性の前提になる。
- MUST NOT: `decode` / `validate` の中から同一 (cacheName, URL) の `fetchBytes` を呼ぶ —
  自分自身のフライトに合流して自己デッドロックする（現実的な用途は無い）。
- yomi 側の既知問題 W-E-7（並行 `getDictionary` の重複 DL）は、yomi が本バージョンへ
  floor を上げるだけで構造的に解消する。
