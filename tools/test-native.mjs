import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const portable = resolve(".cache/toolchains/zig-x86_64-windows-0.15.2/zig.exe");
const compiler = process.env.HOST_CC ?? (process.platform === "win32" && existsSync(portable) ? portable : "cc");
const prefix = basename(compiler).startsWith("zig") ? ["cc"] : [];
const flags = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-g"];
if (process.platform === "linux") flags.push("-B/usr/bin/");
if (process.platform !== "win32") flags.push("-fsanitize=address,undefined");
const usbIncludes = ["components/usb_keyboard", "components/usb_keyboard/include",
  "components/usb_keyboard/test", "managed_components/espressif__tinyusb/src"];
const boardDriver = {
  includes: [".cache/tests/board-stubs", "components/board/include", "components/board/test"],
  sources: ["components/board/board_status_logic.c", "components/board/board_status.c", "components/board/test/board_driver_test.c"],
};
const suites = {
  board_status: { includes: ["components/board/include"],
    sources: ["components/board/board_status_logic.c", "components/board/test/board_status_test.c"] },
  board_driver: { ...boardDriver, flags: ["-DCONFIG_BOARD_XINLUCITY_ESP32S3_NANO=1", "-DCONFIG_IDF_TARGET_ESP32S3=1"] },
  board_disabled: { ...boardDriver, flags: ["-DCONFIG_IDF_TARGET_ESP32S3=1"] },
  board_unsupported: { ...boardDriver, flags: ["-DCONFIG_BOARD_XINLUCITY_ESP32S3_NANO=1"] },
  runtime_status: {
    includes: [...boardDriver.includes, ".cache/tests", "components/web_server", "components/web_server/include",
      "components/network/include", "components/usb_keyboard/include", "managed_components/espressif__cjson/cJSON"],
    sources: ["managed_components/espressif__cjson/cJSON/cJSON.c", "components/web_server/access_control.c",
      "components/board/board_status_logic.c", "components/board/test/runtime_status_test.c"],
    flags: ["-DCJSON_NESTING_LIMIT=4"], linkFlags: ["-lm"] },
  owner_store: { includes: ["components/device_identity"],
    sources: ["components/device_identity/owner_store.c", "components/device_identity/test/owner_store_test.c"] },
  network_state: { includes: ["components/network", "components/network/include", "managed_components/espressif__cjson/cJSON"],
    sources: ["managed_components/espressif__cjson/cJSON/cJSON.c", "components/network/network_state.c", "components/network/test/network_state_test.c"],
    flags: ["-DCJSON_NESTING_LIMIT=4"], linkFlags: ["-lm"] },
  access_control: { includes: ["components/web_server", "components/network/include", "managed_components/espressif__cjson/cJSON"],
    sources: ["managed_components/espressif__cjson/cJSON/cJSON.c", "components/web_server/access_control.c", "components/web_server/test/access_control_test.c"],
    flags: ["-DCJSON_NESTING_LIMIT=4"], linkFlags: ["-lm"] },
  keyboard_state: { includes: usbIncludes, sources: ["components/usb_keyboard/keyboard_state.c", "components/usb_keyboard/test/keyboard_state_test.c"] },
  input_protocol: { includes: [...usbIncludes, "components/web_server", "managed_components/espressif__cjson/cJSON"],
    sources: ["managed_components/espressif__cjson/cJSON/cJSON.c", "components/usb_keyboard/keyboard_state.c", "components/web_server/input_protocol.c", "components/web_server/test/input_protocol_test.c"],
    flags: ["-DCJSON_NESTING_LIMIT=4"], linkFlags: ["-lm"] },
};
const compilerArguments = suite => [...prefix, ...flags, ...suite.includes.map(path => `-I${path}`),
  ...(suite.flags ?? [])];
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(suites);
await mkdir(".cache/tests", { recursive: true });
const compilationDatabase = Object.entries(suites).flatMap(([name, suite]) =>
  suite.sources.map(source => {
    const output = resolve(`.cache/tests/${name}-${basename(source)}.o`);
    return {
      directory: root,
      file: resolve(source),
      output,
      arguments: [compiler, ...compilerArguments(suite), "-c", source, "-o", output],
    };
  }));
for (const header of ["sdkconfig.h", "esp_err.h", "esp_log.h", "esp_timer.h", "driver/gpio.h", "freertos/FreeRTOS.h", "freertos/task.h"]) {
  const path = resolve(".cache/tests/board-stubs", header);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#include "idf_stubs.h"\n');
}
const section = (source, start, end) => {
  const first = source.indexOf(start);
  assert.ok(first >= 0 && first === source.lastIndexOf(start), `Expected unique source anchor: ${start}`);
  const last = source.indexOf(end, first + start.length);
  assert.ok(last > first, `Missing source boundary: ${end}`);
  return source.slice(first, last);
};
const network = await readFile("components/network/network.c", "utf8");
const web = await readFile("components/web_server/web_server.c", "utf8");
await writeFile(".cache/tests/network_observer.inc",
  section(network, "network_control_status_t network_control_status(uint32_t generation)", "\nvoid network_management_touch") +
  section(network, "bool network_control_begin(uint32_t local_address, uint32_t generation)", "\nstatic bool recovery_held"));
await writeFile(".cache/tests/input_client.inc",
  section(web, "typedef struct {\n    int socket;", "\nstatic input_client_t *active_client;"));
await writeFile(".cache/tests/web_observer.inc",
  section(web, "web_server_status_t web_server_status(void)", "\nstatic esp_err_t problem"));
await writeFile(".cache/tests/compile_commands.json", `${JSON.stringify(compilationDatabase, null, 2)}\n`);
for (const name of selected) {
  assert.ok(Object.hasOwn(suites, name), `Unknown native suite: ${name}`);
  const suite = suites[name];
  const output = resolve(`.cache/tests/${name}_test${process.platform === "win32" ? ".exe" : ""}`);
  execFileSync(compiler, [...compilerArguments(suite), ...suite.sources, ...(suite.linkFlags ?? []), "-o", output],
    { stdio: "inherit" });
  execFileSync(output, [], { stdio: "inherit" });
}
console.log(`PASS: ${selected.length} native suite(s) executed${process.platform === "win32" ? " (Windows, without sanitizers)" : " with ASan/UBSan"}.`);