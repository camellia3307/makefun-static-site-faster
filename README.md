# Build a static site faster — make.fun entry

Bounty: **Build a static site faster, 22 November 2026**
Slug: `site-generator-speed-01-run-20261122`
Reward: $100 total, 1st–10th $10 each. Ends Tue 24 Nov 2026, 20:00 UTC.
https://make.fun/bounty/site-generator-speed-01-run-20261122

## What to build

A faster drop-in for make.fun's own `makefun-site` 1.0.0. For each case's
input `{ site, templates, files }` (200–600 Markdown sources, a few static
files, 14–30 templates), return exactly the output tree makefun-site 1.0.0
returns: a JSON object of every path it writes (each page's `index.html`,
the index and tag pages, `build-report.txt`, each static file) and that
file's text, byte for byte.

- Entry point: `solve.js`, a dependency-free ES module; `run(input)` returns
  the output tree. `main.ts` is the harness driver (unchanged from the house
  baseline): it reads `/input/cases.json`, answers each case alone with
  `run`, and writes `/output/answers.json`.
- Grading metric: **CPU time (µs, lower is better)**. An entry must answer
  every case exactly before speed counts; the fastest passing entries are
  timed in a heat (1 untimed warm-up, 9 timed rounds, trimmed mean, net of
  a do-nothing control). A reward needs a CPU time faster than makefun-site
  1.0.0, the house baseline, at 95% confidence (one-sided).
- Constraints: Node 22, JavaScript/TypeScript source only, nothing installed
  before the program runs, no WebAssembly, native addon or prebuilt binary.
  Every answer identical to makefun-site 1.0.0; each case answered alone,
  nothing cached from one case to the next (the slug cache is cleared at the
  start of every `run`). Repository at most 4 MiB.

## What was built

`solve.js` is a from-scratch reimplementation of makefun-site 1.0.0 with
the same semantics (front matter, template dialect, Markdown subset, slug
rule, report — the reference code was the authority where it differed from
its README), optimised for CPU:

- **Bulk HTML escaping**: the reference escapes one character at a time
  inside its inline renderer; here literal runs are escaped in bulk with a
  single native regex pass.
- **Inline parser that jumps**: a single native regex finds the next
  markup character (`\`, `` ` ``, `*`, `[`) instead of a per-character JS
  loop; `**` / `*` closers are found with `indexOf` fast paths when the
  text holds no backslash escapes.
- **Cached slugify**: `slugify` (NFKD + combining-mark strip) is memoised
  within a case — titles, tags and headings repeat constantly — and the
  cache is cleared per `run`.
- **Single-pass Markdown lexer** using char-code checks instead of a
  regex per line; code blocks are escaped as one joined string.
- **Flat-scope template interpreter**: loop variables are set/restored on
  one shared scope object instead of allocating a scope chain per loop
  iteration; output is pushed to an array and joined once.
- **Fused build passes**: word counts are computed once per source,
  tag slugs once per source, cards once per post; no repeated scans.

## Benchmark (actually run)

Machine: this VM, Node 24.22.1, 1.5 shared CPUs. Practice set: 3 cases,
257 / 348 / 486 files, 2.9 MB `cases.json`. Solve-only timing (harness
`main.ts` I/O excluded), 7 runs each, median CPU:

| entry | median CPU, 3 cases |
|---|---|
| makefun-site 1.0.0 (house baseline) | 677 ms |
| this entry (`solve.js`) | 225 ms |

**~3.0x faster than the baseline** (225 ms vs 677 ms; earlier paired runs
gave 186–243 ms vs 559–677 ms, i.e. 2.3–3.0x).

End-to-end via `main.ts` (includes JSON parse of the 2.9 MB input and
writing the 7.2 MB answers): ~0.70 s wall vs ~1.18 s for the baseline.

Commands:

```sh
# baseline
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out-base \
  node <kit>/baselines/makefun-site/main.ts
# this entry (from this repo root)
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out-fast \
  node main.ts
```

## Verification

- Practice set: **3/3 cases byte-identical** to
  `practice/reference/expected.json` (checked with the kit's scorer
  semantics: canonical JSON comparison per case).
- Fuzz: 12 fresh cases drawn with the kit's own generator
  (`program/generator/subject/sites.mjs`, 4 seeds × 3 cases, 209–559
  files each) — **12/12 byte-identical** to the baseline's output.
- Determinism: ran `main.ts` twice on the practice set; the two
  `answers.json` files are byte-identical (`cmp` clean).

## Files

- `solve.js` — the entry (28 KB)
- `main.ts` — harness driver, unchanged from the house baseline
- `package.json` — `{"type": "module"}`
- `README.md`, `LICENSE` (MIT)

## Status

Built locally only. **Not submitted to make.fun** — no account, wallet
or submission was created, and nothing was pushed to GitHub.
