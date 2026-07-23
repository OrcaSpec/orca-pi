#!/usr/bin/env bash
# Seed / re-sync the standalone dogfood repository from the canonical template.
#
# The canonical managed test repository lives IN orca-pi at test/fixture-repo/
# (committed, so the deterministic suite is hermetic). The standalone dogfood
# instance at ~/Documents/orca-dogfood is a working copy of that same template
# with its own git history plus a DOGFOOD.md playbook. Running this script keeps
# the two in lockstep so they can never drift: everything under the template is
# mirrored into the dogfood repo, while the dogfood-only .git/ and DOGFOOD.md are
# preserved.
#
# Usage:  scripts/sync-dogfood.sh [dest]
#   dest defaults to ~/Documents/orca-dogfood
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$script_dir/../test/fixture-repo"
dest="${1:-$HOME/Documents/orca-dogfood}"

if [[ ! -d "$template/.orca" ]]; then
  echo "error: template not found at $template" >&2
  exit 1
fi

mkdir -p "$dest"
# --delete keeps the mirror exact (files removed from the template are removed
# here too); the excludes protect the dogfood repo's own git history and playbook.
rsync -a --delete \
  --exclude='.git/' \
  --exclude='DOGFOOD.md' \
  "$template/" "$dest/"

echo "synced template -> $dest"
