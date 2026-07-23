# Architecture (shared)

Cross-domain reference under `docs/shared/`. The `web`, `design-system`, and
`billing` agents may READ this (declared read.allow), but only `docs` owns and
may write it. Owned writes here route to the `docs` agent.

The monorepo splits into an application tier (`apps/`), a services tier
(`services/`), and infrastructure (`infra/`).
