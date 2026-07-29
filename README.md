# Orca for Pi

Orca for Pi is an OrcaSpec-powered Pi extension. It governs the parent
session as the repository steward, routes writable work to structurally
determined owners, and enforces delegated authority at the tool boundary.

## Development

```bash
npm ci
npm run check
```

Pi discovers the extension through the `pi.extensions` entry in
`package.json`. The dotfiles repository consumes this repository as a pinned
submodule and links it into `~/.pi/agent/extensions/orca-pi`.
