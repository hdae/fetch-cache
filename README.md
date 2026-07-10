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

A few things worth knowing:

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
> Current Deno does not implement `Cache.keys()`, so only `listCachedUrls`
> throws on Deno (failing loud instead of passing off existing entries as an
> empty list). `fetchBytes` caching, `evictUrl`, and `clearCache` all work on
> Deno.

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
