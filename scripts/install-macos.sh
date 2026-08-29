#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
repo_root="${script_dir:h}"
node_path="$(command -v node)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "EXARCH's desktop service currently requires macOS."
  exit 1
fi

node_major="$(${node_path} -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  print -u2 "Node.js 22 or newer is required."
  exit 1
fi

exec "${node_path}" "${script_dir}/install-macos.mjs" "${repo_root}" "${node_path}"
