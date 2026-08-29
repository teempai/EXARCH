#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
project="${script_dir:h}/native/EXARCH.xcodeproj"

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "Installing the native iPhone app requires Xcode on macOS."
  exit 1
fi

open -a Xcode "${project}"
print "In Xcode: select EXARCH, choose your Development Team, select your iPhone, then press Run."
