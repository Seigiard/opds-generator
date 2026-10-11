# Development and finishing gates

## Commands

Use `git submodule update --init` on the first checkout. It fetches foliate-js for `build:ui`.

| Command                                                                   | Purpose                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `bun run dev`                                                             | Start the Docker development server at `http://localhost:8080` with hot reload. |
| `docker compose -f docker-compose.dev.yml logs -f`                        | Follow development-server logs.                                                 |
| `curl -u admin:secret http://localhost:8080/resync[?force=1]`             | Resync in development. `force=1` rebuilds every book.                           |
| `bun run rebuild:dev` / `bun run rebuild:test`                            | Rebuild development or test images.                                             |
| `bun run test`                                                            | Run unit and integration tests in Docker.                                       |
| `docker compose -f docker-compose.test.yml run --rm test bun test <file>` | Run one test file in Docker.                                                    |
| `bun run test:e2e`                                                        | Run nginx and event-logging end-to-end tests.                                   |
| `STARTUP_PORT=<port> bun test test/e2e/startup-readiness.test.ts`         | Run the startup-readiness test, which owns its Compose projects.                |
| `bun run test:all`                                                        | Run UI freshness, renderer checks, Docker tests, and e2e tests.                 |
| `bun run build:ui` / `bun run build:ui:check`                             | Regenerate `static/` / check that committed artifacts are fresh.                |
| `bun run render:golden` / `bun run render:check`                          | Regenerate `test/golden/*.html` / check goldens and untracked files.            |
| `bun run dev:ui`                                                          | Start the Vite renderer and reader preview at `http://localhost:5173`.          |
| `bun run fixtures:pull`                                                   | Refresh renderer cassettes.                                                     |

Other script entry points are in `package.json`.

Run `build:ui` and `build:ui:check` with the `bun-version` pinned in `.github/workflows/docker.yml`. Minified output changes between Bun versions and otherwise fails the freshness check.

The application and its tests run in Docker. Shut down Compose resources that this task owns gracefully when work ends. Integration tests use `poppler-utils` and `djvulibre` from the test image.

## Dependencies

After any runtime dependency change, run `bun run rebuild:test` before tests. `hono` is a runtime dependency because the renderer runs in production, and it remains browser-importable. `sharp` ships its types; `detect-libc` is transitive through sharp. Update `oxlint` and `@oxlint/plugins` together at matching exact versions. The vendored anti-slop plugin is outside application typechecking and formatting; Knip discovers both Oxlint plugins through the lint configuration.

## Finishing a task

Run these checks and fix failures before committing:

1. `bun run fix` must end with 0 warnings and 0 errors.
2. `bun --bun tsc --noEmit` must pass.
3. `bun run test` runs in Docker and must have 0 failures before every commit.
4. `npx knip` must pass.
5. For `ui/` or `src/render` changes, run `bun run build:ui`. For `src/render` markup changes, follow `viewer.md`: bump the folder processing version when needed, run `bun run render:golden`, and commit generated output. For extractor metadata, cover handling, or book entry/link changes, bump `PROCESSING_VERSIONS.book`.
6. Confirm `git status` includes any changed `static/` and `test/golden/` outputs.

The pre-commit hook is configured in `lefthook.yml`. It formats and lints staged files, re-stages its fixes, and typechecks staged TypeScript. It does not replace the Docker test or Knip gates. A clone with `.git` installs it through `bun install`; Docker installs skip it.

CI runs these quality gates separately, then the full e2e suite.
