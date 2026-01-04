import { describe, test, expect } from "bun:test";
import { Effect } from "effect";

/**
 * Tests for isSyncing flag behavior with Effect.ensuring
 * Validates the pattern used in server.ts for guaranteed flag cleanup
 */
describe("Sync Flag Pattern", () => {
  describe("Effect.ensuring guarantees cleanup", () => {
    test("resets flag on successful completion", async () => {
      let flag = false;

      const operation = Effect.gen(function* () {
        flag = true;
        yield* Effect.succeed("done");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            flag = false;
          }),
        ),
      );

      await Effect.runPromise(operation);

      expect(flag).toBe(false);
    });

    test("resets flag on error", async () => {
      let flag = false;

      const operation = Effect.gen(function* () {
        flag = true;
        yield* Effect.fail(new Error("Simulated failure"));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            flag = false;
          }),
        ),
      );

      // Run and catch the error
      await Effect.runPromise(operation.pipe(Effect.catchAll(() => Effect.succeed("recovered"))));

      expect(flag).toBe(false);
    });

    test("resets flag on thrown exception", async () => {
      let flag = false;

      const operation = Effect.gen(function* () {
        flag = true;
        yield* Effect.tryPromise({
          try: async () => {
            throw new Error("Async failure");
          },
          catch: (e) => e as Error,
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            flag = false;
          }),
        ),
      );

      await Effect.runPromise(operation.pipe(Effect.catchAll(() => Effect.succeed("recovered"))));

      expect(flag).toBe(false);
    });

    test("prevents concurrent operations via flag check", async () => {
      let isSyncing = false;
      const operationResults: string[] = [];

      const syncOperation = Effect.gen(function* () {
        isSyncing = true;
        yield* Effect.sleep("10 millis");
        operationResults.push("completed");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            isSyncing = false;
          }),
        ),
      );

      const trySync = () => {
        if (isSyncing) {
          operationResults.push("blocked");
          return Effect.succeed("already syncing");
        }
        return syncOperation;
      };

      // Start first sync
      const firstSync = Effect.runPromise(trySync());

      // Try second sync immediately (should be blocked)
      await Effect.runPromise(trySync());

      // Wait for first to complete
      await firstSync;

      expect(operationResults).toEqual(["blocked", "completed"]);
    });
  });

  describe("Nested sync pattern (resync calls doSync)", () => {
    test("outer ensuring resets flag even if inner operation fails", async () => {
      let isSyncing = false;

      const doSync = Effect.gen(function* () {
        yield* Effect.fail(new Error("Inner failure"));
      });

      const resync = Effect.gen(function* () {
        isSyncing = true;
        // Some cleanup operations...
        yield* Effect.succeed("cleanup done");
        // Then run inner sync
        yield* doSync;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            isSyncing = false;
          }),
        ),
      );

      await Effect.runPromise(resync.pipe(Effect.catchAll(() => Effect.succeed("recovered"))));

      expect(isSyncing).toBe(false);
    });

    test("flag is set before any async operation", async () => {
      let isSyncing = false;
      let flagWasSetBeforeAsyncOp = false;

      const doSync = Effect.gen(function* () {
        flagWasSetBeforeAsyncOp = isSyncing;
        yield* Effect.sleep("1 millis");
      });

      const resync = Effect.gen(function* () {
        isSyncing = true;
        yield* doSync;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            isSyncing = false;
          }),
        ),
      );

      await Effect.runPromise(resync);

      expect(flagWasSetBeforeAsyncOp).toBe(true);
      expect(isSyncing).toBe(false);
    });
  });

  describe("Error logging pattern", () => {
    test("catch handler is called on promise rejection", async () => {
      let errorLogged = false;
      let errorMessage = "";

      const failingOperation = Effect.gen(function* () {
        yield* Effect.fail(new Error("Operation failed"));
      });

      await Effect.runPromise(failingOperation).catch((error) => {
        errorLogged = true;
        errorMessage = String(error);
      });

      expect(errorLogged).toBe(true);
      expect(errorMessage).toContain("Operation failed");
    });

    test("catch handler receives error even with ensuring", async () => {
      let flag = false;
      let errorLogged = false;

      const operation = Effect.gen(function* () {
        flag = true;
        yield* Effect.fail(new Error("Failed with ensuring"));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            flag = false;
          }),
        ),
      );

      await Effect.runPromise(operation).catch(() => {
        errorLogged = true;
      });

      expect(flag).toBe(false);
      expect(errorLogged).toBe(true);
    });
  });
});
