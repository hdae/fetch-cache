# @hdae/fetch-cache

A zero-dependency, URL-keyed download cache for Deno and browsers, built on the
Web Cache API. Fetch large assets (models, dictionaries, …) once and serve them
from Cache Storage afterwards — with sha256 integrity baked into the entries,
validation hooks, and self-healing for corrupted cache entries. A thin
HuggingFace Hub layer (`./hf`) is included.

## Features

- **Zero dependencies**: Web standard APIs only — fetch / caches / crypto.subtle
- **URL as the key**: just call `fetchBytes(url)` to cache and reuse; switch to
  a plain fetch with `cache: false`
- **First-class `sha256`**: network responses are verified before they are
  cached, and the hash is **recorded on the entry** — later cache hits are
  decided by a string comparison against the record (zero hashing), a mismatch
  means "content changed" and self-heals, and `recheck: true` re-hashes the
  bytes when you don't want to trust local storage
- **Validation & self-heal**: the `validate` hook runs on network responses
  _and_ cache reads; invalid downloads are never cached, and corrupted cache
  entries are evicted and re-fetched from the source of truth (fail loud)
- **Decode hook (stored form ≠ usage form)**: keep the cache in the fetched
  form (e.g. gzip) while callers receive the decoded bytes; a failing `decode`
  self-heals exactly like `validate`, and a zero-dependency `decodeGzip`
  helper is included
- **Single-flight**: concurrent `fetchBytes` calls for the same cache key join
  one in-flight download (cached GETs only — `cache: false` opts out); joiners
  share the stored raw bytes and apply their own `sha256` / `validate` /
  `decode`, and `onProgress` fans out to every joined caller
- **Memory-conscious downloads**: the receive buffer is preallocated when the
  size is known (`expectedBytes`, or content-length as a fallback) and stored
  without an extra full-size copy; `prefetchUrl` streams a response straight
  into the cache and never materializes it at all — optionally verifying a
  `sha256` **in flight**, so a corrupted download never becomes a cache entry
- **Caller-owned buffers**: pass `into` to read a download _or a cache hit_
  straight into a buffer you allocated and get a view of it back — reuse one
  buffer across many shards and the heap never holds more than one of them
- **HuggingFace layer**: resolves mutable refs (`"main"` etc.) to the current
  commit SHA, then fetches via immutable SHA-pinned URLs; files with a known
  `sha256` are cached under a **content key** (`["hf", kind, repo, path,
  sha256]`), so a revision bump that leaves the bytes unchanged is still a
  cache hit, and switching revisions keeps both contents side by side
- **Prefix management**: HF entries can be listed and evicted by key prefix —
  `evict(["hf", "model", "owner/name"])` frees a whole repo
- **fetch-compatible options**: pass a standard `RequestInit` via `init` (auth
  headers for gated repos, `AbortSignal`, …) or swap out `fetch` / `caches`
  (testing, custom transport)
- **Quota-safe**: cache I/O failures (quota exceeded, broken storage) never
  lose a successful download — they degrade to a plain fetch and notify via
  `onCacheError` (default `console.warn`)

## Installation

```sh
deno add jsr:@hdae/fetch-cache   # Deno
npx jsr add @hdae/fetch-cache    # npm-based projects (bundlers / Node.js)
```

## Quick Start

```typescript
import { fetchBytes } from "@hdae/fetch-cache";

const url = "https://example.com/assets/model.onnx";

// First call hits the network; subsequent calls are served from
// Cache Storage without any network I/O (the URL is the key).
const bytes = await fetchBytes(url);

// Plain fetch that never touches the Cache API.
const fresh = await fetchBytes(url, { cache: false });
```

### Integrity with `sha256` (recorded hash)

```typescript
// The downloaded bytes are hashed and compared before anything is cached; the
// hash is then recorded on the entry (an entry that failed verification never
// comes into existence).
const bytes = await fetchBytes(url, { sha256: "1a2b…" }); // 64 lowercase hex digits
```

On a later call with the same `sha256`, the cache hit is decided by comparing
the **recorded** hash with the expected one — a string comparison, no hashing,
and on a mismatch the bytes are not even read. A mismatch means "the content
this URL should have has changed": the entry is evicted and re-fetched from the
source (self-heal). An entry that has no record yet (stored by an unverified
prefetch, or by an older version) is hashed once on its first verified read;
if it matches, the record is backfilled so later hits are string comparisons
again. The backfill rewrites the entry once (all N bytes — the Cache API
cannot update headers in place), so the first verified read of a multi-GB
entry stored by 0.4.0 or by an unverified prefetch pays one extra local write.

Trusting the record is a deliberate decision to **trust local storage** (bit
rot or tampering after the store is not detectable). When you don't:

```typescript
// Re-hash the actual bytes on this hit and compare against the expectation.
const bytes = await fetchBytes(url, { sha256: "1a2b…", recheck: true });
```

`recheck: true` is also the "force re-verify" switch: on a cache hit, a
corrupted entry fails the re-hash and self-heals (evict + refetch). Two limits
to be aware of: a call that joins an in-flight download of the same key
(single-flight) re-hashes the shared bytes but throws on a mismatch without
evicting — self-heal runs on the cache-hit path only; and an entry whose
record differs from the expectation is refetched without any re-hashing
regardless of `recheck` (a differing record means "the content changed").

### Progress & validation (self-heal)

```typescript
const bytes = await fetchBytes("https://example.com/assets/model.onnx", {
  onProgress: ({ loaded, total }) => console.log(loaded, total), // per chunk; not fired on cache hits
  validate: (bytes) => {
    if (bytes[0] !== 0x4f) throw new Error("magic mismatch"); // throw = invalid
  },
});
```

`validate` also applies to cache reads — even ones whose recorded hash matched
(the record only skips re-hashing): an entry that fails validation is evicted
and re-fetched from the network (self-heal). If a freshly fetched response
fails validation, the error is thrown as-is and nothing is cached. `validate`
must not mutate the bytes it receives (they are what gets cached).

### Decode (store compressed, return decompressed)

```typescript
import { decodeGzip, fetchBytes } from "@hdae/fetch-cache";

// The cache keeps the small gzip; callers receive the decompressed bytes.
const bytes = await fetchBytes("https://example.com/assets/dict.jtd.gz", {
  decode: decodeGzip,
});
```

`decode` converts the stored form (raw) into the usage form: the cache always
stores raw, and only the return value has `decode` applied. It runs on cache
reads too, and a throwing `decode` is treated as corruption exactly like
`validate` — cache entries self-heal (evict + refetch), network responses
throw and are never cached. Any custom transform works (decompression,
decryption, …); validate the decoded form by throwing inside `decode`:

```typescript
const dict = await fetchBytes(url, {
  decode: async (raw) => {
    const bytes = await decodeGzip(raw);
    if (bytes[0] !== 0x4a) throw new Error("magic mismatch"); // throw = corrupt
    return bytes;
  },
});
```

Two contract details: `validate` (if given) runs on the raw bytes _before_
`decode`, and `decode` must not mutate its input — the raw bytes are written
to the cache after decoding. The decoded form is never cached, so `decode`
runs on every call (storage savings traded for CPU; see
[docs/limitations.md](https://github.com/hdae/fetch-cache/blob/main/docs/limitations.md)).

### Large assets (multi-GB models)

```typescript
import { fetchBytes, prefetchUrl } from "@hdae/fetch-cache";

// Warm the cache without ever holding the file in the JS heap: the network
// response body is piped straight into Cache Storage.
// true  = downloaded and stored, false = a matching entry was already there.
await prefetchUrl(url, {
  sha256: "1a2b…", // hashed chunk by chunk as it streams into the cache
  onProgress: ({ loaded, total }) => console.log(loaded, total),
});

// Materialize it later — the recorded hash makes this hit a string comparison,
// so a multi-GB file is never re-hashed on startup.
const bytes = await fetchBytes(url, { sha256: "1a2b…" });
```

With a `sha256`, the streamed bytes are verified **in flight**: on a mismatch
the cache put is rejected, so the entry never comes into existence, and on a
match the recorded hash is baked in. The existing-entry check uses the same
record: an entry whose record matches is left alone (no network), one with a
missing or different record is deleted and re-warmed with verification.

Without `sha256`, `prefetchUrl` cannot validate (it never sees the bytes), so
verification is concentrated in the read path: `fetchBytes` validates, and a
bad entry is evicted and re-fetched (self-heal). Unverified bytes may sit in
the cache until the first read — do pass a `sha256` or `validate` when you
read them back.

Unlike `fetchBytes`, `prefetchUrl` never degrades: a missing `caches`, an HTTP
error, an interrupted transfer, a failing put (quota) or a `sha256` mismatch
all throw, because storing is its only job and it has no bytes to hand back.
Fall back to `fetchBytes` when it throws. It is also not part of single-flight
— see [docs/limitations.md](https://github.com/hdae/fetch-cache/blob/main/docs/limitations.md) and
[ADR 0005](https://github.com/hdae/fetch-cache/blob/main/docs/decisions/0005-streaming-prefetch-and-verified-marker.md).

`expectedBytes` on `fetchBytes` is an allocation hint only (never a check): the
receive buffer is allocated once up front instead of concatenating chunks at
the end, which halves the peak heap for large files. A wrong hint costs
nothing — the download simply falls back to the chunked path.

One exception: if the allocation itself fails for a size **you** passed
explicitly, `fetchBytes` cancels the body and throws before reading a single
byte, instead of degrading. The chunked path ends with a concatenation buffer of
the very same length, so degrading would only download the whole file and then
fail for the same reason (Chromium caps a single ArrayBuffer at 2,145,386,496
bytes). A failing allocation for a server-declared content-length still degrades
— see [ADR 0007](https://github.com/hdae/fetch-cache/blob/main/docs/decisions/0007-explicit-expected-bytes-fail-loud.md).

### Reusing one buffer across many reads (`into`)

```typescript
// One buffer sized for the largest shard, reused for every read.
const into = new Uint8Array(new ArrayBuffer(largestShardBytes));
for (const shard of shards) {
  const bytes = await fetchBytes(shard.url, {
    sha256: shard.sha256,
    expectedBytes: shard.size,
    into,
  });
  // `bytes` is `into.subarray(0, shard.size)` — consume it before the next
  // iteration overwrites the buffer.
  device.queue.writeBuffer(gpuBuffer, shard.offset, bytes);
}
```

`into` makes `fetchBytes` write straight into a buffer **you own** — both a
network download and a cache hit (which is streamed out of Cache Storage
instead of being materialized with `arrayBuffer()`) — and return a prefix view
of it. No per-call allocation happens, so a loop over dozens of large shards
keeps the heap at one buffer's worth instead of leaving a trail of dead
buffers for the GC to catch up with. The view (and the raw bytes handed to
`validate` / `decode`) is only valid until the next write into the same
buffer; with `decode`, the buffer holds the stored form and the decoded form
is returned separately.

A buffer that is too small fails loud rather than degrading: a network
download is cancelled at the chunk that overflows and nothing is cached, a
cache hit throws but keeps the entry, and an `expectedBytes` larger than the
buffer throws before the request is made. Callers that join an in-flight
download (single-flight) never receive the leader's buffer — they get their
own copy, or their own `into` — see
[ADR 0009](https://github.com/hdae/fetch-cache/blob/main/docs/decisions/0009-into-caller-buffer.md).

### Auth & abort

```typescript
// A standard RequestInit passes straight through to fetch.
const controller = new AbortController();
const bytes = await fetchBytes("https://example.com/private/model.onnx", {
  init: {
    headers: { authorization: "Bearer <token>" },
    signal: controller.signal,
  },
});
```

The cache key is the URL only (headers are not part of it), and only GET can
be cached — pass `cache: false` for other methods. See
[docs/limitations.md](https://github.com/hdae/fetch-cache/blob/main/docs/limitations.md).

### Cache management

```typescript
import {
  clearCache,
  evict,
  evictUrl,
  listCachedUrls,
  listKeys,
} from "@hdae/fetch-cache";

// URL-keyed entries (everything fetched without a sha256-keyed HF spec):
await evictUrl("https://example.com/assets/model.onnx"); // true if it existed
await listCachedUrls();

// Array-keyed entries (the HF layer's content keys) are managed by prefix:
await listKeys(["hf"]); // e.g. [["hf", "model", "owner/name", "model.onnx", "1a2b…"]]
await evict(["hf", "model", "owner/name"]); // sha256-declared files of one repo

// HF files fetched *without* a sha256 are URL-keyed — invisible to evict /
// listKeys. Sweep them by resolve-URL prefix instead:
for (const url of await listCachedUrls()) {
  if (url.startsWith("https://huggingface.co/owner/name/resolve/")) {
    await evictUrl(url);
  }
}

// Everything this library manages (the fixed "fetch-cache" namespace; a
// 0.4.0-era "fetch-cache-hf" namespace is NOT touched — see Migrating below):
await clearCache();
```

Cache keys are generated by the library — URL by default, or the HF layer's
content key `["hf", kind, repo, path, sha256]`. There is deliberately no
option to supply your own key
([ADR 0008](https://github.com/hdae/fetch-cache/blob/main/docs/decisions/0008-remove-public-key-and-backfill-record.md)), so
the prefix vocabulary above is stable and documented.

### HuggingFace layer (`./hf`)

```typescript
import { fetchHfFile, fetchHfFiles } from "@hdae/fetch-cache/hf";

// Mutable refs ("main") are resolved to the current commit SHA first, then
// fetched via the SHA-pinned URL. With a sha256 (from the hub's LFS metadata),
// the cache key is the content key — a README-only revision bump is still a
// cache hit, and the hit itself is a string comparison (no re-hashing).
const model = await fetchHfFile(
  { repo: "owner/name" }, // kind: "model" (default) | "dataset" | "space"
  { path: "model.onnx", sha256: "…", expectedBytes: 1234 },
  { onProgress: ({ path, loaded, total }) => console.log(path, loaded, total) },
);

// Resolve the revision once, then download all files in parallel
// (returns a name → bytes map).
const files = await fetchHfFiles(
  { repo: "owner/name", kind: "dataset", revision: "main" },
  {
    dict: "naist-jdic.jtd.gz",
    meta: { path: "meta.json", expectedBytes: 512 },
  },
);
files.dict; // Uint8Array
```

How the cache key is chosen (per file):

- **`sha256` given** → content key `["hf", kind, repo, path, sha256]`. The
  revision is _not_ part of the key: bump the revision without changing the
  bytes and you keep the hit; switch to a revision with different bytes and
  the two contents coexist as separate entries (no ping-pong). `hubUrl` is not
  part of the key either, so the same content is shared across mirrors.
- **no `sha256`** → the SHA-pinned resolve URL is the key. There is no
  freshness signal to detect changes with, so the key stays revision-specific
  (one entry per revision). These entries are URL-keyed — `evict` / `listKeys`
  do **not** see them; clean them up with `listCachedUrls` + `evictUrl` (see
  Cache management above).

`expectedBytes` (exact length check) and a custom per-file `validate` run on
top of the generic layer's hooks, so they also protect cache reads. `into` (a
caller-owned buffer, see above) is a per-file setting as well — put it on the
`HfFileSpec` of sequential `fetchHfFile` reads. A per-file `decode` maps the
stored form to the usage form:

```typescript
import { decodeGzip } from "@hdae/fetch-cache";

const files = await fetchHfFiles(
  { repo: "owner/name", kind: "dataset" },
  {
    // sha256 matches the hub's LFS metadata (the stored gzip);
    // callers receive the decompressed bytes.
    dict: { path: "dict.jtd.gz", sha256: "…", decode: decodeGzip },
    meta: "meta.json",
  },
);
```

For multi-GB models, warm the cache first with `prefetchHfFile` — nothing is
ever held in the JS heap, and a declared `sha256` is verified in flight:

```typescript
import {
  fetchHfFiles,
  prefetchHfFile,
  resolveHfRevision,
} from "@hdae/fetch-cache/hf";

const ref = { repo: "owner/name" };
// Resolve the revision once, then prefetch against the immutable SHA (no
// repeated resolution requests, no chance of files drifting across revisions).
const revision = await resolveHfRevision(ref);
for (const spec of MODEL_FILES) { // [{ path, sha256 }, …] — prefetch reads only sha256
  await prefetchHfFile({ ...ref, revision }, spec, {
    onProgress: ({ path, loaded, total }) => console.log(path, loaded, total),
  });
}

// Reading the same specs hits the warmed entries; the recorded hashes make
// every hit a string comparison (a multi-GB model is never re-hashed).
const parts = await fetchHfFiles({ ...ref, revision }, {
  model: MODEL_FILES[0],
  vocab: MODEL_FILES[1],
});
```

There is no multi-file prefetch on purpose: downloading several multi-GB files
in parallel only splits the same bandwidth, so the loop (and its concurrency)
is left to you.

A few things worth knowing:

- `prefetchHfFile` returns `{ fetched, revision, url }`: `fetched` is true when
  it downloaded and stored, false when a matching entry was already there.
  `revision` is the SHA that was actually warmed even if you passed a mutable
  ref — for specs **without** a `sha256` the key is revision-specific, so pass
  that SHA back into later reads or the entry is orphaned when the branch
  moves (with a `sha256` the content key makes this moot).
- Even a fully warmed cache reaches the network when you pass a mutable ref
  (`"main"` etc.): the revision-resolution request always runs first. For
  offline startup, persist the resolved SHA on your side and pass it as
  `revision` (`isCommitSha` tells you whether a string is already pinned; with
  a `sha256` per file the cache hits themselves are revision-independent).
- Suspicious about a cached file? `{ recheck: true }` re-hashes files that
  declare a `sha256` and self-heals on a mismatch. Files **without** a
  `sha256` are not affected (there is nothing to compare against) — drop them
  explicitly with `evictUrl(hfResolveUrl({ ...ref, revision, path }))`.
- `prefetchHfFile` reads only `sha256` from the spec: `expectedBytes` /
  `validate` are ignored while warming (no bytes in hand) and apply when the
  file is read back.
- Free a repo's sha256-declared files with `evict(["hf", "model",
  "owner/name"])`, one file with `evict(["hf", "model", "owner/name",
  "model.onnx"])` (all contents of it), and inspect what is stored with
  `listKeys(["hf"])`. Files fetched without a `sha256` are URL-keyed — sweep
  them via `listCachedUrls` (see Cache management).
- `hubUrl` (default `"https://huggingface.co"`) can be overridden to point at
  a mirror; contents with the same `sha256` are shared across hubs.
- Gated / private repos: pass an Authorization header via `init` — it reaches
  both the revision-resolution call and the file download.
- If any file fails, `fetchHfFiles` rejects as a whole, but files that already
  succeeded stay cached — a retry picks them up as instant cache hits.

> [!NOTE]
> `resolveHfRevision` relies on `{hubUrl}/api/…/revision/{ref}` returning
> `{"sha": …}`, which is observed HuggingFace API behavior, not a documented
> guarantee (it throws if the response has no `sha`).

## Migrating from 0.4.0

0.5.0 is a breaking release
([ADR 0006](https://github.com/hdae/fetch-cache/blob/main/docs/decisions/0006-cache-control-redesign.md),
[ADR 0008](https://github.com/hdae/fetch-cache/blob/main/docs/decisions/0008-remove-public-key-and-backfill-record.md)):

- **`cacheName` is gone.** The namespace is a fixed internal `"fetch-cache"`.
  The HF layer's old namespace `"fetch-cache-hf"` is no longer referenced —
  reclaim the space once with `caches.delete("fetch-cache-hf")` (same for any
  custom namespace you used; `clearCache()` does not touch them).
- **Admin APIs take an options object now.** 0.4.0's positional
  `clearCache(cacheName)` / `listCachedUrls(cacheName)` are gone; both take an
  optional `{ caches }` object instead. Careful in plain JS:
  `clearCache("fetch-cache-hf")` does not error — the string is ignored and
  the **default** namespace is cleared. Delete old namespaces directly with
  `caches.delete(...)` as above.
- **`verifiedMarker` / `trustCachedSha256` are gone**, absorbed by the
  first-class `sha256` + recorded hash. The default is **reversed**: 0.4.0
  validated every hit unless you opted in; 0.5.0 trusts a matching record
  unless you pass `recheck: true`. Migration by case: if your marker was the
  file's sha256, drop the marker (and any hand-written hash check in
  `validate`) and pass `sha256`; to keep 0.4.0's verify-every-hit default,
  pass `sha256` + `recheck: true`; if your marker skipped an arbitrary
  expensive custom `validate`, there is no successor — custom `validate` now
  runs on every hit by design. The old `x-fetch-cache-verified` header is not
  read (treated as "no record"): such entries are re-hashed once on their
  first verified **read** and the record is backfilled. `prefetchUrl` /
  `prefetchHfFile` with a `sha256` instead treat a record-less entry as stale
  and re-download it — upgrade 0.4.0-era entries with a verified `fetchBytes`
  / `fetchHfFile` read, not with a prefetch.
- **Explicit `expectedBytes` fails loud on allocation failure.** 0.4.0 fell
  back to the chunked path when the up-front receive buffer could not be
  allocated; 0.5.0 cancels the body and throws before reading instead (the
  chunked path would fail at the end for the same reason, after burning the
  whole download — ADR 0007). A server-declared content-length still degrades.
- **HF default keys changed** to the content key above — entries cached by
  0.4.0 simply miss and are re-downloaded (it is a cache; no data is lost).
- **`cacheName`-based partitioning has no direct successor.** There has never
  been a public option to supply your own cache key, and `evict` prefixes only
  address the HF content keys. If you used `cacheName` to partition caches
  (per app / per tenant), pass a custom `caches` implementation instead (e.g.
  a thin wrapper remapping `open(name)` to a per-tenant name) to every call —
  the admin APIs accept the same `{ caches }` — or keep the URLs themselves
  distinct.

## Runtime support

| Runtime  | Cache                                                           |
| -------- | --------------------------------------------------------------- |
| Browsers | Cache Storage (per origin; secure context: https / localhost)   |
| Deno     | Cache Storage (persistent, local)                               |
| Node.js  | no `caches` — caching skipped, plain fetch (behavior unchanged) |

Caching is an optimization, not a correctness requirement. On runtimes without
`caches`, `fetchBytes` falls back to a plain fetch (`sha256` / `validate`
still apply per call), `evictUrl` / `evict` / `clearCache` return
false / 0, and `listCachedUrls` / `listKeys` return `[]`. The one exception:
`prefetchUrl` / `prefetchHfFile` **throw** there instead — storing is their
only job, so there is nothing to degrade to (see Large assets).

> [!NOTE]
> Deno implements `Cache.keys()` since 2.9, so `listCachedUrls` / `listKeys` /
> `evict` work there. On Deno 2.8 and earlier they throw instead (failing loud
> rather than passing off existing entries as an empty list). `fetchBytes`
> caching, `evictUrl`, and `clearCache` work on every Deno version.

In browsers, keep in mind that Cache Storage is subject to the browser's
storage eviction policy (consider `navigator.storage.persist()` for large
assets), and that cross-origin downloads — including HuggingFace Hub — depend
on the target's CORS headers.

## Releasing

The single source of truth for the version is `version` in `deno.json`. The
public `VERSION` (`src/mod.ts`) is a baked-in copy, and `deno task bump` keeps
the two in sync within one commit. Drift is detected fail-loud by
`scripts/version_sync.test.ts` (part of `deno task check`) and by
`scripts/verify_tag.ts` at release time.

```sh
deno task bump patch   # 0.1.0 -> 0.1.1 (deno.json + src/mod.ts in one commit; no tag/push)
```

To publish:

1. Bump the version with `deno task bump <patch|minor|major>`.
2. `git push`, then create a GitHub Release tagged `v<version>` (e.g.
   `v0.1.1`).
3. Publishing the Release triggers
   [`release.yml`](https://github.com/hdae/fetch-cache/blob/main/.github/workflows/release.yml), which verifies tag ==
   `deno.json` version and then publishes to JSR (OIDC).

## Documentation

Full API documentation is available on
[JSR](https://jsr.io/@hdae/fetch-cache).

## License

MIT (`LICENSE`).
