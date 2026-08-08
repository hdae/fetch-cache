# @hdae/fetch-cache

A zero-dependency, URL-keyed download cache for Deno and browsers, built on the
Web Cache API. Fetch large assets (models, dictionaries, …) once and serve them
from Cache Storage afterwards — with validation hooks and self-healing for
corrupted cache entries. A thin HuggingFace Hub layer (`./hf`) is included.

## Features

- **Zero dependencies**: Web standard APIs only — fetch / caches / crypto.subtle
- **URL as the key**: just call `fetchBytes(url)` to cache and reuse; switch to
  a plain fetch with `cache: false`
- **Validation & self-heal**: the `validate` hook runs on network responses
  _and_ cache reads; invalid downloads are never cached, and corrupted cache
  entries are evicted and re-fetched from the source of truth (fail loud)
- **Progress callback**: streaming reads fire `onProgress` per chunk (`total`
  is present only when the response has content-length)
- **Decode hook (stored form ≠ usage form)**: keep the cache in the fetched
  form (e.g. gzip) while callers receive the decoded bytes; a failing `decode`
  self-heals exactly like `validate`, and a zero-dependency `decodeGzip`
  helper is included
- **Single-flight**: concurrent `fetchBytes` calls for the same (cacheName,
  URL) join one in-flight download (cached GETs only — `cache: false` opts
  out); joiners share the stored raw bytes and apply their own `validate` /
  `decode`, and `onProgress` fans out to every joined caller
- **Memory-conscious downloads**: the receive buffer is preallocated when the
  size is known (`expectedBytes`, or content-length as a fallback) and stored
  without an extra full-size copy, keeping the heap at one copy of the asset
  instead of two; `prefetchUrl` streams a response straight into the cache and
  never materializes it at all — optionally verifying a `sha256` **in flight**,
  so a corrupted download never becomes a cache entry
- **HuggingFace layer**: resolves mutable refs (`"main"` etc.) to the current
  commit SHA, then fetches and caches via immutable SHA-pinned URLs; parallel
  multi-file downloads with `expectedBytes` / `sha256` integrity checks
- **fetch-compatible options**: pass a standard `RequestInit` via `init` (auth
  headers for gated repos, `AbortSignal`, …) or swap out `fetch` itself
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

### Progress & validation (self-heal)

```typescript
const bytes = await fetchBytes("https://example.com/assets/model.onnx", {
  onProgress: ({ loaded, total }) => console.log(loaded, total), // per chunk; not fired on cache hits
  validate: (bytes) => {
    if (bytes[0] !== 0x4f) throw new Error("magic mismatch"); // throw = invalid
  },
});
```

`validate` also applies to cache reads: an entry that fails validation is
evicted and re-fetched from the network (self-heal). If a freshly fetched
response fails validation, the error is thrown as-is and nothing is cached.

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
[docs/limitations.md](docs/limitations.md)).

### Large assets (multi-GB models)

```typescript
import { fetchBytes, prefetchUrl } from "@hdae/fetch-cache";

// Warm the cache without ever holding the file in the JS heap: the network
// response body is piped straight into Cache Storage.
// true  = downloaded and stored, false = an entry was already there.
await prefetchUrl(url, {
  onProgress: ({ loaded, total }) => console.log(loaded, total),
});

// Materialize it later, one file at a time — this is where validation happens.
const bytes = await fetchBytes(url, { validate, expectedBytes: 1234 });
```

Pass a `sha256` to verify **in flight**, without ever buffering the file:

```typescript
// Hashed chunk by chunk as it streams into the cache. On a mismatch the put is
// rejected, so the entry never comes into existence; on a match the entry is
// stored with a verified marker baked in, which the read path can trust.
await prefetchUrl(url, { sha256: "1a2b…" }); // 64 lowercase hex digits

const bytes = await fetchBytes(url, {
  validate: verifySha256,
  verifiedMarker: "1a2b…", // marker matches -> no re-hashing on this hit
});
```

Without `sha256`, `prefetchUrl` cannot validate (it never sees the bytes), so
verification is concentrated in the read path: `fetchBytes` validates, and a bad
entry is evicted and re-fetched (self-heal). That means unverified bytes may sit
in the cache until the first read — do pass a `validate` when you read them
back. Either way, an entry that is already there is never re-checked:
prefetching returns `false` without touching the network.

Unlike `fetchBytes`, `prefetchUrl` never degrades: a missing `caches`, an HTTP
error, an interrupted transfer, a failing put (quota) or a `sha256` mismatch all
throw, because storing is its only job and it has no bytes to hand back. Fall
back to `fetchBytes` when it throws. It is also not part of single-flight — see
[docs/limitations.md](docs/limitations.md) and
[ADR 0005](docs/decisions/0005-streaming-prefetch-and-verified-marker.md).

`expectedBytes` on `fetchBytes` is an allocation hint only (never a check): the
receive buffer is allocated once up front instead of concatenating chunks at
the end, which halves the peak heap for large files. A wrong hint costs
nothing — the download simply falls back to the chunked path.

### Skipping re-validation on cache hits (opt-in)

```typescript
// Bakes the marker into the cached entry after validation succeeds, and skips
// `validate` on later hits whose marker matches. Default (no marker): every
// cache hit is validated, exactly as before.
const bytes = await fetchBytes(url, {
  validate: async (bytes) => {/* e.g. sha256 check */},
  verifiedMarker: "sha256:1a2b…",
});
```

This trades verification for start-up time on huge assets, and it is a decision
to **trust local storage**: the marker only claims "these bytes passed
`validate` when they were stored", so tampering or bit rot after the fact is
not detectable (the marker would be rewritten with them). Entries stored before
you opted in and single-flight joiners carry no marker and are validated
normally; `prefetchUrl` writes one only when it verified a `sha256` in flight,
and that marker claims the hash match alone (any extra checks your `validate`
performs are skipped on those hits).

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
[docs/limitations.md](docs/limitations.md).

### Cache management

```typescript
import { clearCache, evictUrl, listCachedUrls } from "@hdae/fetch-cache";

await evictUrl("https://example.com/assets/model.onnx"); // delete one entry (true if it existed)
await clearCache(); // delete the whole namespace (default "fetch-cache")
await listCachedUrls(); // list cached URLs
```

Every function accepts a custom namespace: `fetchBytes(url, { cacheName })`,
`evictUrl(url, { cacheName })`, `clearCache(cacheName)`,
`listCachedUrls(cacheName)`.

### HuggingFace layer (`./hf`)

```typescript
import { fetchHfFile, fetchHfFiles } from "@hdae/fetch-cache/hf";

// Mutable refs ("main") are resolved to the current commit SHA first, then
// fetched and cached via the SHA-pinned URL — no network on later calls as
// long as the SHA is unchanged. Passing a SHA as `revision` skips the
// resolution request entirely.
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

`expectedBytes` / `sha256` are implemented as the generic layer's `validate`
hook, so they also protect cache reads (corrupted entries self-heal).

Each file spec also takes a custom `validate` (extra checks on the raw bytes,
after the built-in ones) and a `decode` (stored form → usage form, per file):

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
import { prefetchHfFile, resolveHfRevision } from "@hdae/fetch-cache/hf";

const ref = { repo: "owner/name" };
// Resolve the revision once, then prefetch against the immutable SHA (no
// repeated resolution requests, no chance of files drifting across revisions).
const revision = await resolveHfRevision(ref);
const spec = { path: "model.safetensors", sha256: "1a2b…" };

// true = downloaded and stored, false = an entry was already there.
// A mismatching hash rejects the put, so the entry never comes into existence.
await prefetchHfFile({ ...ref, revision }, spec, {
  onProgress: ({ path, loaded, total }) => console.log(path, loaded, total),
});

// Reading it back is a cache hit, and the marker skips the full re-hash.
const model = await fetchHfFile({ ...ref, revision }, spec, {
  trustCachedSha256: true,
});
```

There is no multi-file prefetch on purpose: downloading several multi-GB files
in parallel only splits the same bandwidth, so the loop (and its concurrency) is
left to you.

A few things worth knowing:

- `trustCachedSha256: true` (opt-in) bakes the declared `sha256` into the
  cached entry and skips re-hashing on later hits whose marker matches — the
  `verifiedMarker` trust boundary above applies. Default: every cache hit is
  hashed in full. Entries warmed by `prefetchHfFile` carry the same marker; note
  that it certifies the hash only, so a custom `validate` on that file is
  skipped on those hits.
- The HF layer uses its own default cache namespace `"fetch-cache-hf"`
  (the generic layer uses `"fetch-cache"`), so `clearCache()` does not touch
  HF downloads — use `clearCache("fetch-cache-hf")`.
- `hubUrl` (default `"https://huggingface.co"`) can be overridden to point at
  a mirror.
- Gated / private repos: pass an Authorization header via `init` — it reaches
  both the revision-resolution call and the file download.
- If any file fails, `fetchHfFiles` rejects as a whole, but files that already
  succeeded stay cached — a retry picks them up as instant cache hits.

> [!NOTE]
> `resolveHfRevision` relies on `{hubUrl}/api/…/revision/{ref}` returning
> `{"sha": …}`, which is observed HuggingFace API behavior, not a documented
> guarantee (it throws if the response has no `sha`).

## Runtime support

| Runtime  | Cache                                                           |
| -------- | --------------------------------------------------------------- |
| Browsers | Cache Storage (per origin; secure context: https / localhost)   |
| Deno     | Cache Storage (persistent, local)                               |
| Node.js  | no `caches` — caching skipped, plain fetch (behavior unchanged) |

Caching is an optimization, not a correctness requirement. On runtimes without
`caches`, `fetchBytes` falls back to a plain fetch (`validate` still applies),
`evictUrl` / `clearCache` return false, and `listCachedUrls` returns `[]`.

> [!NOTE]
> Deno implements `Cache.keys()` since 2.9, so `listCachedUrls` works there.
> On Deno 2.8 and earlier it throws instead (failing loud rather than passing
> off existing entries as an empty list). `fetchBytes` caching, `evictUrl`,
> and `clearCache` work on every Deno version.

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
   [`release.yml`](.github/workflows/release.yml), which verifies tag ==
   `deno.json` version and then publishes to JSR (OIDC).

## Documentation

Full API documentation is available on
[JSR](https://jsr.io/@hdae/fetch-cache).

## License

MIT (`LICENSE`).
