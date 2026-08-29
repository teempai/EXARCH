#!/bin/zsh
set -euo pipefail

label="com.teempai.exarch.daemon"
plist="${HOME}/Library/LaunchAgents/${label}.plist"
application_root="${HOME}/Library/Application Support/EXARCH"
app="${HOME}/Applications/Exarch Desktop.app"
previous_app="${HOME}/Applications/EXARCH.app"
legacy_label="com.teempai.mobile-remote-agent.daemon"
legacy_plist="${HOME}/Library/LaunchAgents/${legacy_label}.plist"
legacy_application_root="${HOME}/Library/Application Support/MobileRemoteAgent"
legacy_app="${HOME}/Applications/Mobile Remote Agent.app"
trash="${HOME}/.Trash/EXARCH Uninstall $(date +%Y%m%d-%H%M%S)"

/bin/launchctl bootout "gui/${UID}" "${plist}" 2>/dev/null || true
/bin/launchctl bootout "gui/${UID}" "${legacy_plist}" 2>/dev/null || true
mkdir -p "${trash}"
[[ ! -e "${plist}" ]] || mv "${plist}" "${trash}/"
[[ ! -e "${application_root}" ]] || mv "${application_root}" "${trash}/"
[[ ! -e "${app}" ]] || mv "${app}" "${trash}/"
[[ ! -e "${previous_app}" ]] || mv "${previous_app}" "${trash}/previous-exarch-app"
[[ ! -e "${legacy_plist}" ]] || mv "${legacy_plist}" "${trash}/legacy-launch-agent.plist"
[[ ! -e "${legacy_application_root}" ]] || mv "${legacy_application_root}" "${trash}/legacy-application-support"
[[ ! -e "${legacy_app}" ]] || mv "${legacy_app}" "${trash}/legacy-app"
print "EXARCH was moved to: ${trash}"
print "Your context remains recoverable from Trash until you empty it."
