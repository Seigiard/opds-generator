## Problem

RSS grows linearly during book processing. heap_used stable at 12-13 MB, RSS grows unbounded → OOM crash at 512 MB Docker limit.

## Root Causes Found

### 1. Bun ReadableStream leak (FIXED)

`new Response(proc.stdout).arrayBuffer()` leaks ~180 KB/spawn in native memory.
**Fix:** Redirect stdout to temp file via fd, read with fs.open.

### 2. mimalloc page retention (PARTIALLY MITIGATED)

Bun uses mimalloc which retains freed pages instead of returning to OS. Confirmed in oven-sh/bun#21560.
**Fix:** `MIMALLOC_PURGE_DELAY=0` — reduced growth from 5.1 → 3.4 KB/event.

### 3. Effect runtime object accumulation (NOT FIXED)

Effect internal objects (`Type`, `ScheduleImpl`, `AsyncFromSyncIterator`) accumulate ~1 object/event and are never collected. This is NOT specific to Effect.gen generators — flatMap chains produce the same leak with different object types.

Heap snapshot evidence (100 → 5000 events):

| With Effect.gen | With flatMap chains |
|---|---|
| Generator: +12221 | Type: +12232 |
| EmptySet: +1757 | ScheduleImpl: +1787 |
| DOMImpl: +1718 | AsyncFromSyncIterator: +1764 |

Both approaches leak ~12K objects per 5K events. The leak is in Effect runtime internals, not in the generator/flatMap choice.

**Conclusion:** Cannot fix from userland. Requires removing Effect entirely.

## Fixes Applied (commits on main)

| Fix | Impact |
|---|---|
| Single magick call for cover+thumbnail | 2x less subprocess spawns |
| Cover buffer null + Bun.gc(true) after each event | Prevent heap bloat |
| stdout/stderr: "ignore" for magick | No pipe buffers |
| stdout/stderr: "ignore" for spawnWithTimeout | No pipe buffers |
| Eliminate pending Promise in spawnWithTimeout | Remove closure retention |
| stdout via temp file instead of pipe | **Key fix:** 180 KB/spawn → 0 |
| fd instead of Bun.file() for stdout | Avoid BunFile object accumulation |
| unlinkSync instead of async unlink | No floating promises |
| Cached TextDecoder singleton | Avoid per-call allocation |
| fs.open for detectArchiveType | Avoid Bun.file().slice().arrayBuffer() |
| `--smol` flag | More aggressive JSC GC |
| `MIMALLOC_PURGE_DELAY=0` | Force mimalloc page return |
| Poll loop in entrypoint.sh | Detect Bun crash (wait -n unsupported in BusyBox) |
| Consumer: Effect.forever + flatMap | Eliminated outer generator (no improvement in practice) |
| Handlers: flatMap chains | Eliminated handler generators (no improvement — Type objects replace Generator objects) |

## Current State (2026-03-14)

- heap_used: 12-13 MB stable
- RSS growth: ~5.4 KB/event
- Object count growth: ~1.06/event (Effect internal Type objects)
- Estimated peak for 21K events: ~225 MB
- Original peak was 430+ MB → OOM crash

## Resolution Path

Full migration from Effect to neverthrow + vanilla TS async/await.
Plan: `docs/superpowers/specs/2026-03-14-effect-to-neverthrow-migration-design.md`

This eliminates:
- Effect runtime Type/Primitive object accumulation
- Effect Queue Deferred/LinkedListNode churn
- Generator/flatMap overhead entirely
- mimalloc pressure from Effect's allocation patterns

## Key Test Files

- `test/integration/memory-leak.test.ts` — isolated operation tests (< 3 KB/iter threshold)
- `test/integration/memory-leak-handler.test.ts` — full handler chain (< 3 KB/iter)
- `test/integration/memory-leak-runtime.test.ts` — Effect runtime isolation (Queue + gen tests skipped — mimalloc + Effect internals)

## Key Measurements

| Version | RSS at 5K events | Growth rate |
|---|---|---|
| Original (pipe stdout) | 270+ MB (6 books) → OOM | ~180 KB/event |
| After pipe→file fix | 135 MB | ~5.1 KB/event |
| After MIMALLOC_PURGE_DELAY=0 | 124 MB | ~3.4 KB/event |
| After flatMap migration | 141 MB | ~5.4 KB/event |
| **After neverthrow migration** | **TBD** | **target: 0** |
