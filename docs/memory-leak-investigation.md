## Problem

RSS grows linearly during book processing. heap_used stable at 12-13 MB, RSS grows unbounded → OOM crash at 512 MB Docker limit.

## Root Causes Found

### 1. Bun ReadableStream leak (FIXED)

`new Response(proc.stdout).arrayBuffer()` leaks ~180 KB/spawn in native memory.
**Fix:** Redirect stdout to temp file via fd, read with fs.open.

### 2. mimalloc page retention (PARTIALLY MITIGATED)

Bun uses mimalloc which retains freed pages instead of returning to OS. Confirmed in oven-sh/bun#21560.
**Fix:** `MIMALLOC_PURGE_DELAY=0` — reduced growth from 5.1 → 3.4 KB/event.

### 3. Effect Queue allocation throughput

Each `Queue.take()` on empty queue creates `Deferred` + `LinkedListNode`. GC collects them (heap stable), but mimalloc retains the pages.
**Status:** Not fixable from userland. Effect code is correct per source analysis.

## Fixes Applied (commits on main)

| Fix                                               | Impact                                            |
| ------------------------------------------------- | ------------------------------------------------- |
| Single magick call for cover+thumbnail            | 2x less subprocess spawns                         |
| Cover buffer null + Bun.gc(true) after each event | Prevent heap bloat                                |
| stdout/stderr: "ignore" for magick                | No pipe buffers                                   |
| stdout/stderr: "ignore" for spawnWithTimeout      | No pipe buffers                                   |
| Eliminate pending Promise in spawnWithTimeout     | Remove closure retention                          |
| stdout via temp file instead of pipe              | **Key fix:** 180 KB/spawn → 0                     |
| fd instead of Bun.file() for stdout               | Avoid BunFile object accumulation                 |
| unlinkSync instead of async unlink                | No floating promises                              |
| Cached TextDecoder singleton                      | Avoid per-call allocation                         |
| fs.open for detectArchiveType                     | Avoid Bun.file().slice().arrayBuffer()            |
| `--smol` flag                                     | More aggressive JSC GC                            |
| `MIMALLOC_PURGE_DELAY=0`                          | Force mimalloc page return                        |
| Poll loop in entrypoint.sh                        | Detect Bun crash (wait -n unsupported in BusyBox) |

## Current State (2026-03-14)

- heap_used: 12 MB stable
- RSS growth: ~3.4 KB/event (was 180+ KB/event before fixes)
- Estimated peak for 21K events: ~180 MB (was 430+ MB → OOM)
- JSC object count stable, protected objects stable, InternalPromise stable

## Remaining Options to Explore

1. Other mimalloc env vars: `MIMALLOC_ARENA_EAGER_COMMIT=0`, `MIMALLOC_SEGMENT_RESET=1`
2. Report to Bun team with reproduction (memory-leak-runtime.test.ts)
3. Replace Effect Queue with plain array + async/await (eliminates Deferred/LinkedListNode churn)
4. Switch to Node.js runtime (no mimalloc, different allocator behavior)
5. Use bounded Queue with power-of-2 capacity (Effect docs recommend for perf)

## Key Test Files

- `test/integration/memory-leak.test.ts` — isolated operation tests (< 3 KB/iter threshold)
- `test/integration/memory-leak-handler.test.ts` — full handler chain (< 1 KB/iter)
- `test/integration/memory-leak-runtime.test.ts` — Effect runtime isolation (Queue tests skipped — mimalloc)

## Key Measurements

| Version                      | RSS at 3500 events      | Growth rate   |
| ---------------------------- | ----------------------- | ------------- |
| Original (pipe stdout)       | 270+ MB (6 books) → OOM | ~180 KB/event |
| After pipe→file fix          | 135 MB                  | ~5.1 KB/event |
| After MIMALLOC_PURGE_DELAY=0 | 124 MB                  | ~3.4 KB/event |
