#!/bin/bash
# Record successful interactive apt changes as reproducible workspace intent.
real="/usr/bin/$(basename "$0")"
"$real" "$@"
status=$?

if [ "$status" -eq 0 ] && [ -e /run/agena-runtime ]; then
  for arg in "$@"; do
    case "$arg" in
      install|remove|purge|autoremove)
        python3 /opt/agena/environment_manifest.py record \
          /opt/agena/base-manual-packages \
          /workspace/.agena/environment.toml \
          || echo "agena: package installed, but environment.toml could not be updated" >&2
        break
        ;;
    esac
  done
fi

exit "$status"
