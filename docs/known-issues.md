# Known Issues — 未解決の既知問題

現在、本ライブラリ起因のオープンな既知問題は無い。

## 環境起因（上流の挙動・注視のみ）

- **Deno: Cache put の上書きで旧 body ファイルが orphan として残る**（ディスクリーク）。
  Deno の Cache 実装（sqlite + body ファイル）の挙動で、本ライブラリでは同一 URL の
  put 上書き（並行取得・self-heal 再取得）時に発生しうる。実害は小（ディスク使用量のみ、
  整合性には影響なし）。Deno 側の将来修正を注視する。
  参照: .claude/reviews/2026-07-10_b5ccf62/findings/verify-A.md（V1 副作用注記）。
