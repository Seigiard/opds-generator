# EffectTS → neverthrow + vanilla TS Migration

## Problem

EffectTS `Queue.take()` creates `Deferred` + `LinkedListNode` on each call to an empty queue. GC collects them (heap stable at 12 MB), but Bun's mimalloc retains the freed pages, causing RSS growth of ~3.4 KB/event. At 21K events this projects to ~180 MB RSS — close to Docker's 512 MB limit.

The project uses a small subset of EffectTS (10 features), all of which have direct vanilla TS or lightweight library equivalents.

## Goal

Replace EffectTS with:
- **neverthrow** for type-safe error handling (`Result<T,E>` / `ResultAsync<T,E>`)
- **Plain `AppContext` + `Pick<>`** for compile-time DI
- **SimpleQueue** (vanilla TS) for event queue — eliminates Deferred/LinkedListNode churn
- **AbortController** for structured shutdown (replaces Fiber)

Eliminate both `effect` and `@effect/schema` dependencies entirely.

## Scope

| Area | Files | Lines |
|---|---|---|
| src/effect/ + server.ts | 14 | ~1,530 |
| Tests | 11 | ~3,200 |
| **Total** | **25** | **~4,730** |

Note: includes `src/effect/types.ts` which uses `@effect/schema` for request validation.

## Non-Goals

- Changing the event cascade architecture (handlers return events, not call each other)
- Changing the watcher → HTTP → queue pipeline
- Changing the mirror structure (/data mirrors /books)
- Performance optimization beyond memory leak fix

## Migration Strategy: Strangler Fig (Bottom-Up)

Each step produces a green test suite. Effect and new code coexist until all handlers are migrated.

## Design

### New Infrastructure (parallel to existing Effect code)

#### AppContext (replaces Context.Tag + Layer)

```typescript
// src/context.ts
interface AppContext {
  readonly config: ConfigService;
  readonly logger: LoggerService;
  readonly fs: FileSystemService;
  readonly dedup: DeduplicationService;
  readonly queue: SimpleQueue<EventType>;
  readonly handlers: HandlerRegistry;
}

type HandlerDeps = Pick<AppContext, "config" | "logger" | "fs">;

async function buildContext(): Promise<AppContext> {
  const config = loadConfig();
  const logger = createLogger(config);
  const fs = createFileSystem();
  const dedup = createDeduplication();
  const queue = new SimpleQueue<EventType>();
  const handlers = new HandlerRegistry();
  return { config, logger, fs, dedup, queue, handlers };
}
```

Compile-time safety: `Pick<AppContext, ...>` enforces correct dependencies at every call site. Renaming a service field triggers TS errors across all consumers.

#### Service Interface Changes

**LoggerService** — methods return `void` (fire-and-forget), not `Effect.Effect<void>`:

```typescript
interface LoggerService {
  info(tag: string, msg: string, ctx?: LogContext): void;
  warn(tag: string, msg: string, ctx?: LogContext): void;
  error(tag: string, msg: string, err?: unknown, ctx?: LogContext): void;
  debug(tag: string, msg: string, ctx?: LogContext): void;
}
```

The underlying implementation is already synchronous (`log.info(...)` etc). The Effect wrapper was pure ceremony.

**FileSystemService** — methods return `Promise<T>` (throwing on error), not `Effect.Effect<T, Error>`:

```typescript
interface FileSystemService {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean; size: number }>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  atomicWrite(path: string, content: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
```

Handlers use `try/catch` internally for error recovery (e.g., ENOENT suppression). The handler's return type `Result<EventType[], Error>` captures whether the handler as a whole succeeded or failed — the consumer uses this to decide whether to log an error. Individual fs operations throw normally.

**DeduplicationService** — returns `boolean` (synchronous):

```typescript
interface DeduplicationService {
  shouldProcess(key: string): boolean;
}
```

Already synchronous under the Effect wrapper.

#### Schema Validation (replaces @effect/schema)

`RawBooksEvent` and `RawDataEvent` are trivial structs (3 string fields each). Replace `Schema.decodeUnknownEither()` with inline type guards:

```typescript
function isRawBooksEvent(u: unknown): u is RawBooksEvent {
  return (
    typeof u === "object" && u !== null &&
    "parent" in u && typeof (u as Record<string, unknown>).parent === "string" &&
    "name" in u && typeof (u as Record<string, unknown>).name === "string" &&
    "events" in u && typeof (u as Record<string, unknown>).events === "string"
  );
}
```

#### SimpleQueue (replaces Effect Queue)

```typescript
// src/queue.ts
class SimpleQueue<T> {
  private items: T[] = [];
  private waiters: Array<{
    resolve: (item: T) => void;
    reject: (reason: unknown) => void;
  }> = [];

  enqueue(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
    } else {
      this.items.push(item);
    }
  }

  enqueueMany(items: readonly T[]): void {
    for (const item of items) this.enqueue(item);
  }

  async take(signal?: AbortSignal): Promise<T> {
    if (this.items.length > 0) return this.items.shift()!;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.waiters.push(entry);
      signal?.addEventListener(
        "abort",
        () => {
          const idx = this.waiters.indexOf(entry);
          if (idx !== -1) this.waiters.splice(idx, 1);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  get size(): number {
    return this.items.length;
  }
}
```

Memory impact: One `resolve`/`reject` pair per pending `take()` instead of Effect's `Deferred` + `LinkedListNode`. Uses an array of waiters to safely support multiple concurrent `take()` calls (future-proof), though currently only the consumer calls `take()`.

#### Handler Type (replaces Effect handler signature)

```typescript
// src/effect/handlers/types.ts
import type { Result } from "neverthrow";

type HandlerError = Error;

type AsyncHandler = (
  event: EventType,
  deps: HandlerDeps,
) => Promise<Result<readonly EventType[], HandlerError>>;
```

#### UnifiedHandler Adapter (temporary, during migration)

```typescript
type UnifiedHandler =
  | { kind: "effect"; handler: EffectHandler }
  | { kind: "async"; handler: AsyncHandler };
```

Consumer checks `kind` and dispatches accordingly. Removed once all handlers are async.

### Handler Migration Pattern

Each handler follows the same transformation:

| Effect pattern | Replacement |
|---|---|
| `Effect.gen(function* () { ... })` | `async function` |
| `yield* ConfigService` | `deps.config` |
| `yield* LoggerService` → `yield* logger.info(...)` | `deps.logger.info(...)` (direct call, returns void) |
| `yield* fs.mkdir(...)` | `await deps.fs.mkdir(...)` (returns Promise, throws on error) |
| `yield* Effect.tryPromise({ try, catch })` | `try/catch` or `ResultAsync.fromPromise(try, catch)` |
| `.pipe(Effect.catchAll(() => Effect.succeed(null)))` | `try { ... } catch { return null; }` |
| `Effect.fail(error)` | `return err(error)` |
| `return EventType[]` | `return ok(EventType[])` |

### Handler Migration Order

From simplest to most complex:

| # | Handler | Lines | Complexity |
|---|---|---|---|
| 1 | parent-meta-sync | 27 | Returns cascade event |
| 2 | folder-entry-xml-changed | 33 | Returns two cascade events |
| 3 | folder-sync | 44 | mkdir + return [] |
| 4 | book-cleanup | 36 | rm + cascade |
| 5 | folder-cleanup | 39 | rm + ENOENT handling |
| 6 | folder-meta-sync | 160 | Feed.xml generation, sorting, multiple fs calls |
| 7 | book-sync | 114 | Metadata extraction, cover processing, OPDS entry |

### Adapter Migration

After all handlers:

| Effect pattern | Replacement |
|---|---|
| `Match.value({...}).pipe(Match.when(...), Match.orElse(...))` | `switch` / `if-else` |

`adaptBooksEvent` and `adaptDataEvent` become sync functions that receive `DeduplicationService` as a parameter:

```typescript
function adaptBooksEvent(raw: RawBooksEvent, dedup: DeduplicationService): EventType | null
function adaptDataEvent(raw: RawDataEvent, dedup: DeduplicationService): EventType | null
```

Currently these use `yield* DeduplicationService` via Effect DI. After migration, dedup is passed explicitly. The dedup service is synchronous, so these remain sync functions.

`sync-plan-adapter` has no Effect imports — no changes needed.

Note: `folder-meta-sync` handler uses raw `readdir`/`stat` imports from `node:fs/promises` alongside DI `FileSystemService`. During migration, route all fs calls through `deps.fs` for consistent testability.

### Consumer Migration

```typescript
async function startConsumer(
  ctx: AppContext,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const event = await ctx.queue.take(signal);
    const handler = ctx.handlers.get(event._tag);
    if (!handler) continue;

    const deps = { config: ctx.config, logger: ctx.logger, fs: ctx.fs };
    const result = await handler(event, deps);

    if (result.isOk()) {
      ctx.queue.enqueueMany(result.value);
    } else {
      ctx.logger.error("Consumer", "handler failed", {
        tag: event._tag,
        error: result.error,
      });
    }

    Bun.gc(true);
  }
}
```

Replaces `Effect.gen` + `ManagedRuntime.runFork()` + `Fiber`.

The code above shows the structural pattern. The production consumer preserves all existing event lifecycle logging (`event_id`, `handler_start`/`handler_complete` with `duration_ms`, `cascade_count`, `cascade_tags`) and periodic memory monitoring (`logMemorySnapshot` with heap stats every 50 events). These are direct `ctx.logger.*` calls instead of `yield* logger.*`.

### Server Migration

| Effect pattern | Replacement |
|---|---|
| `ManagedRuntime.make(LiveLayer)` | `await buildContext()` |
| `runtime.runFork(startConsumer)` | `startConsumer(ctx, controller.signal)` |
| `runtime.runFork(periodicReconciliation)` | `startReconciliation(ctx, controller.signal)` |
| `Fiber.interrupt(fiber)` | `controller.abort()` |
| `runtime.dispose()` | `await Promise.allSettled([consumerTask, reconcileTask])` |
| `Effect.ensuring(Effect.sync(() => { isSyncing = false }))` | `try/finally` |
| `Schedule.spaced(interval)` | `setInterval` inside `startReconciliation` |
| `runtime.runPromise(queue.enqueue(event))` | `ctx.queue.enqueue(event)` |
| `runtime.runPromise(registerHandlers)` | `registerHandlers(ctx)` (plain function) |
| `Schema.decodeUnknownEither(RawBooksEvent)(body)` | `isRawBooksEvent(body)` (type guard) |
| `yield* adaptBooksEvent(raw)` | `adaptBooksEvent(raw, ctx.dedup)` (sync, dedup passed explicitly) |
| `yield* adaptDataEvent(raw)` | `adaptDataEvent(raw, ctx.dedup)` (sync, dedup passed explicitly) |

### Cleanup

After server.ts migration:

1. Delete `src/effect/services.ts`
2. Remove `UnifiedHandler` adapter — registry stores `AsyncHandler` only
3. Replace `@effect/schema` validation in `types.ts` with type guards
4. `bun remove effect @effect/schema`
5. `npx knip` — verify no dead code

### Test Migration

| Before | After |
|---|---|
| `Layer.succeed(ConfigService, {...})` | `const deps: HandlerDeps = { config: {...}, ... }` |
| `Effect.runPromise(Effect.provide(handler(event), TestLayer))` | `await handler(event, deps)` |
| Mock logger: `() => Effect.sync(...)` | Mock logger: `() => {}` (void functions) |
| Mock fs: returns `Effect.tryPromise(...)` | Mock fs: returns `Promise<T>` |
| `ManagedRuntime.make(TestLayer)` + `runtime.runFork(...)` | Direct `await startConsumer(ctx, signal)` |

Memory leak tests:
- `memory-leak-runtime.test.ts`: rewrite Queue tests with SimpleQueue, unskip
- `memory-leak-handler.test.ts`: expect RSS growth < 1 KB/event (was 3.4 KB/event)

### Documentation Updates

- `CLAUDE.md`: remove "EffectTS Layers" section, update DI Services table, update Key Patterns
- Memory file: update `project_memory_leak_investigation.md` with results

## Commit Plan

```
 1. feat: add AppContext, SimpleQueue, HandlerDeps, neverthrow dependency
 2. feat: add new service interfaces (LoggerService → void, FileSystemService → Promise)
 3. feat: add UnifiedHandler adapter to registry
 4. refactor: migrate parent-meta-sync handler
 5. refactor: migrate folder-entry-xml-changed handler
 6. refactor: migrate folder-sync handler
 7. refactor: migrate book-cleanup handler
 8. refactor: migrate folder-cleanup handler
 9. refactor: migrate folder-meta-sync handler
10. refactor: migrate book-sync handler
11. refactor: migrate adapters (books, data) to plain TS
12. refactor: migrate consumer to async/AbortController
13. refactor: migrate server.ts — remove ManagedRuntime, registerHandlers, Schema validation
14. chore: remove effect + @effect/schema dependencies, delete services.ts
15. test: update memory leak tests, verify RSS improvement
16. docs: update CLAUDE.md and architecture docs
```

## Success Criteria

- [ ] All existing tests pass (green) after each commit
- [ ] `effect` and `@effect/schema` removed from package.json
- [ ] RSS growth per event < 1 KB (measured by memory-leak-handler.test.ts)
- [ ] No runtime DI — all dependencies injected via function parameters
- [ ] `bun run fix` produces 0 warnings, 0 errors
- [ ] `npx knip` shows no unused exports/deps
