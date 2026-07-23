# orca-dogfood

A deliberately small but real TypeScript monorepo that a repository-aware agent
orchestrator can be pointed at. Its `.orca/orca.yaml` declares seven domain
agents with nested and adjacent ownership, agent and protected denies, edit
shorthand, and a steward discovery scope narrower than the whole tree.

```
apps/
  web/            # owned by `web`
    components/   #   nested: owned by `design-system`
  web-admin/      # owned by `web-admin` (adjacent to web)
services/
  billing/        # owned by `billing` (generated/ is a write-deny)
  api/            # owned by `api` (adjacent to billing)
infra/            # owned by `infra` (production/ is a protected write-deny)
docs/             # owned by `docs`; docs/shared is cross-domain read
secrets/          # protected read-deny; owned by no agent
```

Run `pi` inside this directory with the Orca for pi extension active, then
`/orca` to see governance status. See `DOGFOOD.md` for the interactive playbook.
