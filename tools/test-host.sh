#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

HOST_CC="${HOST_CC:-/usr/bin/cc}" node tools/test-native.mjs
node --test components/web_server/test/browser_input_test.mjs