[severity: error] src/mod.ts:230 — URL キーの正規化が Cache API と一致しない / 予約 origin を生文字列の `startsWith` で判定するため、`HTTPS://FETCH-CACHE.INVALID/...` はガードを通過して配列キーと衝突する一方、`https://fetch-cache.invalid.example/...` は過剰拒否される。また URL の表記違い・fragment は Cache API では同一キーでも `inflight` では別キーとなり、二重フライトと競合書込みが起こる / URL を標準 URL として正規化し、解析済み `origin` で予約判定する。Cache API と single-flight に同じ正規化済み storage key を渡し、大文字 scheme/host・既定 port・fragment のテストを追加する。

[severity: error] src/mod.ts:192 — `0` と `-0` が同じキーへ直列化される / `-0` は有限数なのでガードを通るが、`JSON.stringify(-0)` は `"0"` となる。したがって単射性・完全な可逆性という ADR 0006 の契約を破り、別内容が誤ヒットし得る / `Object.is(element, -0)` を拒否するか、`-0` を保存できる独自表現を定義する。`[0]` と `[-0]` の衝突・round-trip テストを追加する。

[severity: error] src/mod.ts:520 — 記録ハッシュ不一致でもキャッシュ内容を再ハッシュして採用してしまう / ADR 0006 と JSDoc は「記録 ≠ 期待なら即 evict → network」と定めるが、実装は単に `trusted=false` とし、実バイトが期待値ならヒットを返す。その結果、壊れた記録ヘッダが修復されず毎回全量ハッシュされ、network に出るという公開挙動にも反する / 記録が存在して期待値と違う場合は再ハッシュせず self-heal へ送る。実バイトは期待値と一致するが記録だけ異なるケースを追加する。

[severity: error] src/hf/mod.ts:268 — HF の sha256 形式ガードが revision 解決後に走る / `fetchHfFile`、`prefetchHfFile`、`fetchHfFiles` は先に `resolveHfRevision` を await し、その後 `toSpec` を呼ぶため、可変 revision では形式不正でも API network が発生する。複数ファイル版では正常な兄弟ファイルの取得まで開始し得る / 全 spec を同期的に正規化・検査してから revision を解決し、その後に並列取得を始める。現行テストの固定 SHA では検出できないため、可変 revision と複数ファイルの失敗前 network 0 回を確認する。

[severity: warning] src/mod.ts:431 — カスタム `validate` が記録ハッシュと保存内容を乖離させられる / SHA-256 の計算後、同じ可変 `Uint8Array` を `validate` に渡し、その後そのまま期待ハッシュ付きで保存する。`validate` の JSDocには非破壊契約がなく、同期的な変更だけで次回から誤った内容が信頼される / `validate` にも非破壊 MUST を明記し、可能ならカスタム検証後に記録との整合性を再確認するか、検証用コピーで raw を隔離する。

[severity: warning] src/mod.ts:219 — `deserializeKey` が復元値の型を検査していない / JSON として解析可能なら `null`、配列、オブジェクト、`1e400` 由来の Infinity まで型キャストして `CacheKey` として返す。外部直書き異常を fail loud にするという `listKeys` の契約に反する / parse 後に各要素へ `assertKeyElement` を適用し、不正なら復元不能として throw する。JSON-valid な不正要素のテストを加える。

[severity: warning] src/mod.ts:899 — prefetch の保険 delete 失敗を黙殺し、信頼される不正エントリを残し得る / stream error を無視する Cache 実装で `put` が成功した後、`delete` の reject を空 catch して元の integrity errorだけを投げる。次回の既定読み出しは残った `x-fetch-cache-sha256` を信頼する / cleanup 失敗を `AggregateError` 等で必ず通知し、キャッシュが汚染された可能性を明示する。保険分岐で delete が reject するテストを追加する。

[severity: low] src/mod.ts:684 — 進捗通知中の再入合流で同じ進捗が二重通知される / `Set` の live iterator中に既存 listener が同一キーの `fetchBytes` を開始すると、新 listener は `state.last` の即時 replayを受けた後、同じ `for...of` にも追加されて再度呼ばれる / 通知対象を `[...listeners]` へ snapshot してから反復し、onProgress 内で合流者を作るテストを追加する。

[severity: warning] src/mod.test.ts:1065 — 「記録 ≠ 期待」のテストが判定方式を凍結できていない / 記録だけでなく実バイトのハッシュも期待値と異なるため、実装のように記録を無視して再ハッシュしても同じ self-heal 結果になり、ADR 違反を検出できない / 実バイトは期待値と一致し、記録ヘッダだけ別値のエントリを仕込み、必ず evict・network 取得されることを検証する。

[severity: low] src/hf/mod.ts:41 — HF の `expectedBytes` JSDoc が実挙動を説明していない / 実際は長さ検証だけでなく受信バッファ確保ヒントでもあり、明示サイズの確保失敗は ADR 0007 により body cancel + early throw となる / `fetchHfFile(s)` での二重用途と確保失敗契約、`prefetchHfFile` では無視されることをプロパティ側にも明記する。

[severity: low] src/hf/mod.ts:44 — `sha256` の「crypto.subtle 必須」は prefetch には当てはまらない / `prefetchHfFile` は純 TS の逐次 SHA-256 を使うため、`crypto.subtle` がなくても検証できる / `fetchHfFile(s)` のみ必須、prefetch は不要と JSDoc を入口別に書き分ける。

問題なし: ADR 0007 の実装は、明示 `expectedBytes` の確保失敗時に body を cancel し、要求サイズ・URL・ArrayBuffer 上限の可能性・元 cause を含めて受信前に throw している。content-length 由来と形式不正値の縮退も設計どおり。

問題なし: single-flight の通常の check→set 同期区間、成否を問わない `finally` 解除、settle 後の再取得には lost wakeup は見当たらない。実行時外部依存の追加もなく、対象テストの fetch はすべて DI されている。

総評: 再設計の骨格、self-heal の共通経路、記録一致時の trust、ADR 0007 は概ね設計どおりだが、予約 URL の正規化、`-0` のキー衝突、記録不一致時の判定、HF の事前ガード順序はリリース前に修正すべき正当性問題である。テストは主要経路を広く覆う一方、記録ヘッダだけが食い違うケースなど、設計上の分岐を単独で固定できていない箇所が残る。指示に従いテスト実行およびファイル・git 操作は行っていない。