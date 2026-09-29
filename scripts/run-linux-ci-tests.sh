#!/usr/bin/env bash
set -euo pipefail

# Run inside dbus-run-session and Xvfb on the disposable Linux CI runner.
# Electron requires an encrypted Secret Service backend at App startup.
export XDG_CURRENT_DESKTOP=GNOME
ci_keyring_password="$(openssl rand -hex 32)"
printf '%s' "$ci_keyring_password" | gnome-keyring-daemon --unlock --components=secrets
unset ci_keyring_password

npm run test:ci
