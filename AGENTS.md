<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Host-side tests (hostrunner)

When a test cannot run inside this container (Chrome/E2E, real Xvfb, host PHP
setup, host-only services), do **not** try SSH, `docker.sock`, or direct host
networking. Use the `hostrunner` MCP tools instead:

- `hostrunner_run` — submit a whitelisted host command (`e2e_playwright`,
  `e2e_playwright_ui`, `php_test`, `php_lint`, `phpstan`, `composer_test`) with an
  absolute `cwd` inside `/home/maxim/Projects`.
- `hostrunner_status` — state or final result by job `id`. `queued` / `running`
  mean it is still in flight (keep polling); `ok`, `failed`, `timeout`,
  `cancelled`, `rejected`, `spawn_failed` are terminal. `unknown` means no such
  job in this queue — check the `id`.
- `hostrunner_tail` — stream/read the log while it runs. `logAvailable: false`
  means the process has not started producing output yet, not that the log is
  empty.
- `hostrunner_cancel` — stop a hung job.

Pass `waitMs: 0` for long E2E runs, then poll `hostrunner_status` until the
status is terminal, using `hostrunner_tail` in between. Never attempt to bypass
the whitelist with a shell command.
