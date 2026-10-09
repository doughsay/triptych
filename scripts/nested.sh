#!/bin/sh
# Runs a nested GNOME Shell in a window with only Triptych enabled.
# Needs the mutter-devkit package. Uses a throwaway config dir so the real
# session's settings (and its enabled extensions, e.g. Forge) are untouched.
# 4 static workspaces and no edge-tiling, a typical setup for tiling.
#
#   SIZE=3840x1080 scripts/nested.sh      # default: 32:9 super-ultrawide, half size
set -eu

uuid=triptych@doughsay.github.io
size=${SIZE:-3840x1080}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export XDG_CONFIG_HOME="$tmp/config"
mkdir -p "$XDG_CONFIG_HOME"

dbus-run-session -- sh -c "
  gsettings set org.gnome.shell enabled-extensions \"['$uuid']\"
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
  gsettings set org.gnome.mutter dynamic-workspaces false
  gsettings set org.gnome.desktop.wm.preferences num-workspaces 4
  gsettings set org.gnome.mutter edge-tiling false
  gnome-shell --wayland --devkit --devkit-args \"--monitor-size $size\"
"
