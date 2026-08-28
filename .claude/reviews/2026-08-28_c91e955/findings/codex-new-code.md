## 指摘

[severity: error] src/core.ts:535 — `recheck: true` でも記録不一致を実バイトで再検証しない

機序: `recorded !== opts.sha256` を `recheck` より先に short-circuit するため、`recheck: true` の「記録を信用せず実バイトを再ハッシュする」契約が破られる。さらに short-circuit を外すだけでは、実バイトが正しくても lines 566–579 は `recorded === null` しか修復しないため、誤った記録が残る。

```ts
await cache.put(url, new Response(bytesA, {
  headers: { "x-fetch-cache-sha256": hashB },
}));

await fetchBytes(url, {
  sha256: hashA,
  recheck: true,
  fetch: () => Promise.reject(new Error("offline")),
});
```

実害: `bytesA` が実際には `hashA` と一致していても、正しいキャッシュを削除して network へ進み、オフラインなら失敗する。README.md:93–99 の force re-verify 契約とも矛盾する。修正案: 記録不一致 short-circuit は `opts.recheck !== true` の場合だけ行う。`recheck` で実バイトが一致した場合は、null／不一致を問わず記録を期待値へ修復する。

[severity: error] src/core.ts:239 — URL 正規化結果を取得元にも使い、relative URL とカスタム輸送の意味を変えている

機序: `location.href` を基準に URL を解決し、fragment を除去した `parsed.href` を storage key だけでなく `fetchImpl` にも渡している。Window の相対 URL は `<base>` を反映した document base URL が基準なので、`location.href` では別リソースになる。また `cache: false` でも正規化されるため、0.4.0 で動いた相対入力や fragment を意味に使う非 HTTP(S) カスタム輸送が壊れる。

```html
<base href="https://cdn.example/assets/">
<!-- fetchBytes("model.bin") は現在 cdn.example ではなく location 側へ向く -->
```

```ts
await fetchBytes("mem:item#v2", {
  cache: false,
  fetch: async (input) => new Response(String(input)),
});
// 0.4.0: "mem:item#v2"、現在: "mem:item"
```

実害: 誤ったファイルの取得、または location のない Deno/Node でカスタム `fetch` が呼ばれる前の失敗になる。修正案: network には元の `string | URL` を渡し、正規化値は storage/single-flight 専用にする。相対 URL のストレージ正規化には Window なら `document.baseURI`、Worker なら適切な API base URL を使う。少なくとも `cache: false` は正規化を要求しない。

[severity: warning] src/core.ts:893 — prefetch の更新失敗が既存の正常エントリまで先に失わせる

機序: 記録なし／不一致を検出すると既存エントリを削除してから network 取得を始める。

```ts
await cache.put(url, new Response(oldBytes, {
  headers: { "x-fetch-cache-sha256": oldHash },
}));

await prefetchUrl(url, {
  sha256: newHash,
  fetch: async () => new Response("", { status: 503 }),
});

await cache.match(url); // undefined
```

実害: HTTP エラー、転送中断、ハッシュ不一致、quota 超過のいずれでも最後の正常コピーを失う。別の利用者が旧ハッシュを必要とする場合や、数 GB のアセットをオフライン利用している場合は再取得コスト／利用不能につながる。修正案: 既存エントリを残したまま `cache.put` で成功時だけ置換する。対象ランタイムの原子的置換を前提にできないなら、一時キーへ検証付きで格納してから昇格する。

[severity: warning] src/core.ts:734 — sha256 を持つ single-flight 合流者は検証しても backfill できない

機序: leader が `sha256` なしなら記録なしで格納され、合流者は line 744 の `checkAndDecode` だけを実行する。合流者が実ハッシュを検証しても cache.put 経路がない。

```ts
const gate = Promise.withResolvers<void>();
const transport = async () => {
  await gate.promise;
  return new Response(bytes);
};

const leader = fetchBytes(url, { fetch: transport });
const verified = fetchBytes(url, { fetch: transport, sha256: hash });
gate.resolve();
await Promise.all([leader, verified]);

const hit = await (await caches.open("fetch-cache")).match(url);
hit!.headers.get("x-fetch-cache-sha256"); // null
```

実害: 「最初の verified read で一度だけハッシュして backfill」という約束が成立せず、毎回この順で並行起動する下流では multi-GB ファイルの全量ハッシュが恒久化する。記録とバイトの不一致は作られないが、backfill の性能目的を失う。修正案: in-flight 結果に leader の cache/storage 情報と記録状態を含め、合流者の検証成功後に同じ保存先へ安全に backfill できるようにする。

[severity: low] src/core.ts:203 — `deserializeKey` が非正規な JSON 表現を正規キーとして受理する

機序: 要素型だけを検査し、`serializeKey` が生成する正規表現との round-trip を確認していない。例えば `1e0` は数値 `1` として復元されるが、再直列化は `1` になる。

```ts
await cache.put(
  "https://fetch-cache.invalid/v1/1e0",
  new Response("foreign"),
);

await listKeys(); // [[1]]
await evict([1]); // 0: 実際の URL は /1e0 なので消えない
```

実害: `listKeys` が削除不能な「幽霊キー」を正常値として返し、外部直書きを fail loud にする契約が破れる。`-0` と `0` の直列化衝突も単射・可逆という説明に反する。修正案: 復元後に `serializeKey(elements) === url` を検証する。あわせて `-0` を拒否するか専用表現を定義する。

[severity: low] src/core.ts:1041 — `has` と `open` の競合で削除済み名前空間を再作成し得る

機序: `has()` と `open()` が別操作なので、その間に `clearCache()` が走ると、後続の `open()` が空の名前空間を再作成する。これは evict/list 系4 APIに共通する。

```ts
await Promise.all([
  listCachedUrls({ caches: storage }),
  clearCache({ caches: storage }),
]);
// 実行順次第で clearCache が true でも空の "fetch-cache" が再作成される
```

実害: 「存在しない名前空間を作らない」という副作用契約が並行管理操作では成立しない。実害は空名前空間の残存に限られるため low。再現順序は CacheStorage 実装依存。修正案: 同一 CacheStorage/名前空間の管理操作を直列化するか、並行 `clearCache` に対しては非保証であることを明記する。

## 「問題なし」確認リスト

- 標準的な絶対 HTTP(S) URLでは、scheme/host、既定 port、fragment、IDN の正規化は Cache API のキー処理と整合し、0.4.0 の既定名前空間にある URL エントリは継続してヒットする。
- backfill の leader 経路は、実バイトの SHA-256 検証成功後にだけ記録を付けており、「未検証バイトに記録を付けない」不変条件を保っている。
- prefetch の記録一致判定、streaming 検証、保険 delete 失敗時の `AggregateError` は fail-loud 契約と整合している。
- HF の全入口で `toSpec` が revision 解決より前に呼ばれ、形式不正な SHA-256 で network が漏れない。
- 管理 API 5本は、競合がない通常経路では一貫して注入された `caches` を使い、global との取り違えはない。
- `deno.json` の exports は `.` と `./hf` のみで、`fetchBytesWithKey` / `prefetchUrlWithKey` は公開ファサードから漏れていない。`CacheAdminOptions` を含む公開型の再公開漏れもない。
- `deserializeKey` の追加型検査は null、配列、object、非有限数値を拒否できている。
- 進捗通知の snapshot 反復は、通知中に合流した listener への同一進捗の二重通知を防いでいる。
- 0.4.0 からの `cacheName`、旧 marker、HF キー変更と既定 trust 反転は README の移行節に明記されている。

## 総評

現状の 0.5.0 は publish 保留を推奨する。  
特に `recheck` の契約違反と relative/custom URL の意味論変更は、正しいキャッシュの消失や誤取得につながるためリリース阻害要因である。  
prefetch の先行削除と single-flight 合流時の backfill 欠落も、下流の multi-GB 利用で帯域・CPUコストを顕在化させる。  
上記再現ケースを固定テストに加えて修正すれば、公開境界と通常の 0.4.0 URLキャッシュ移行はリリース可能な状態に近い。