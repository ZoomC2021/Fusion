#!/usr/bin/env bash
# Launch the fork-built Fusion desktop shell attached to the systemd
# dashboard service on port 4321 (external-cli mode: the Electron shell
# does NOT start its own engine, so only one engine runs the board).
# Auth: first launch prompts for the dashboard token (diagtok123).
export FUSION_SERVER_PORT=4321
exec /home/zoomcharts/Repos/Fusion/packages/cli/node_modules/electron/dist/electron \
  --enable-source-maps \
  /home/zoomcharts/Repos/Fusion/packages/cli/dist/desktop/main.js "$@"
