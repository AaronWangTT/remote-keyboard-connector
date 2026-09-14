#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p .cache/tests
"${HOST_CC:-/usr/bin/cc}" -B/usr/bin/ -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -g \
    -I components/usb_keyboard -I components/usb_keyboard/include -I components/usb_keyboard/test \
    -I managed_components/espressif__tinyusb/src \
    components/usb_keyboard/keyboard_state.c \
    components/usb_keyboard/test/keyboard_state_test.c \
    -o .cache/tests/keyboard_state_test
.cache/tests/keyboard_state_test

"${HOST_CC:-/usr/bin/cc}" -B/usr/bin/ -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -g \
    -DCJSON_NESTING_LIMIT=4 -I managed_components/espressif__cjson/cJSON \
    -I components/web_server -I components/usb_keyboard -I components/usb_keyboard/include \
    -I components/usb_keyboard/test -I managed_components/espressif__tinyusb/src \
    managed_components/espressif__cjson/cJSON/cJSON.c components/usb_keyboard/keyboard_state.c \
    components/web_server/input_protocol.c \
    components/web_server/test/input_protocol_test.c \
    -lm -o .cache/tests/input_protocol_test
.cache/tests/input_protocol_test

node --test components/web_server/test/browser_input_test.mjs