#!/bin/sh
set -eu
trap '' HUP
mode=$1
repo_dir=$2
transaction_dir=$3
bundle_dir=$4
companions_stopped() {
  if ! running_count=$(/usr/bin/osascript -l JavaScript -e '
    ObjC.import("AppKit");
    let total = 0;
    for (const identifier of ["io.github.codex-router.tray", "io.github.codex-router.control-center"]) {
      total += Number(ObjC.unwrap(
        $.NSRunningApplication.runningApplicationsWithBundleIdentifier(identifier).count
      ));
    }
    String(total);
  '); then
    exit 0
  fi
  case "$running_count" in *[!0-9]*|'') exit 0 ;; esac
  [ "$running_count" -eq 0 ]
}
case "$mode" in
  wait)
    while ! companions_stopped; do sleep 1; done
    exec node "$repo_dir/src/tray-update-owner.mjs" macos-restore "$transaction_dir" "$bundle_dir"
    ;;
  settle)
    # Recheck after acquiring the kernel owner: a new updater may have
    # committed a new GUI between the old wait and this acquisition.
    companions_stopped || exit 0
if [ -e "$transaction_dir" ]; then
  recovery_fields=$(node "$repo_dir/src/macos-tray-transaction.mjs" \
    plan "$transaction_dir" "$bundle_dir") || exit 0
  # shellcheck disable=SC2086
  set -- $recovery_fields
  [ "$#" -eq 2 ] && [ "$1" = keep-live ] || exit 0
  rm -rf "$transaction_dir" || exit 0
fi
node "$repo_dir/src/tray-service.mjs" restart >/dev/null 2>&1 || true
    ;;
  *) exit 2 ;;
esac
