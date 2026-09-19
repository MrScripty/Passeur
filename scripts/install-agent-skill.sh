#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
source_dir="$repo_root/skills/muse-bridge"
target_dir="${MUSE_BRIDGE_SKILL_TARGET:-$repo_root/.agents/skills/muse-bridge}"

mkdir -p "$(dirname "$target_dir")"
cp -R "$source_dir" "$target_dir"
printf 'Installed repository skill at %s\n' "$target_dir"
