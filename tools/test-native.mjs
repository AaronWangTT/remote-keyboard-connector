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
const boardPower = {
  includes: [...boardDriver.includes, ".cache/tests"],
  sources: ["components/board/board_power_policy.c", "components/board/board_power.c", "components/board/test/board_power_test.c"],
};
const suites = {
  wakeup_policy: { includes: ["components/web_server"],
    sources: ["components/web_server/wakeup_policy.c", "components/web_server/test/wakeup_policy_test.c"] },
  wakeup_http: { includes: [".cache/tests/board-stubs", ".cache/tests", "components/board/test",
      "components/usb_keyboard/include", "components/web_server"],
    sources: ["components/web_server/wakeup_policy.c", "components/web_server/test/wakeup_http_test.c"] },
  power_control: { includes: [...boardDriver.includes, "components/web_server", "components/network/include",
      "components/firmware_update/include", "components/usb_keyboard/include", "managed_components/espressif__cjson/cJSON", ".cache/tests"],
    sources: ["managed_components/espressif__cjson/cJSON/cJSON.c", "components/board/board_power_policy.c", "components/web_server/test/power_control_test.c"],
    flags: ["-DCJSON_NESTING_LIMIT=4"], linkFlags: ["-lm"] },
  usb_power: { includes: [...usbIncludes, ...boardDriver.includes, ".cache/tests"],
    sources: ["components/usb_keyboard/keyboard_state.c", "components/usb_keyboard/test/usb_power_test.c"] },
  board_power_policy: { includes: ["components/board/include"],
    sources: ["components/board/board_power_policy.c", "components/board/test/board_power_policy_test.c"] },
  board_power: { ...boardPower, flags: ["-DCONFIG_BOARD_POWER_MANAGEMENT=1", "-DCONFIG_BOARD_XINLUCITY_ESP32S3_NANO=1", "-DCONFIG_IDF_TARGET_ESP32S3=1",
    ...(process.env.IDF_PATH ? ["-DBOARD_POWER_TEST_SDK_SLEEP=1",
      `-I${resolve(process.env.IDF_PATH, "components/soc/esp32s3/include")}`,
      `-I${resolve(process.env.IDF_PATH, "components/soc/include")}`] : [])] },
  board_power_disabled: { ...boardPower, flags: ["-DCONFIG_BOARD_XINLUCITY_ESP32S3_NANO=1", "-DCONFIG_IDF_TARGET_ESP32S3=1"] },
  board_power_unsupported: { ...boardPower, flags: ["-DCONFIG_BOARD_POWER_MANAGEMENT=1", "-DCONFIG_BOARD_XINLUCITY_ESP32S3_NANO=1"] },
  update_service: { includes: [".cache/tests/update-stubs", ".cache/tests", "components/firmware_update/test", "components/firmware_update/include",
      "components/network/include", "components/usb_keyboard/include"],
    sources: ["components/firmware_update/update_policy.c", "components/firmware_update/test/update_service_test.c"] },
  update_policy: { includes: ["components/firmware_update/include"],
    sources: ["components/firmware_update/update_policy.c", "components/firmware_update/test/update_policy_test.c"] },
  board_status: { includes: ["components/board/include"],
    sources: ["components/board/board_status_logic.c", "components/board/test/board_status_test.c"] },
  board_driver: { ...boardDriver, flags: ["-DCONFIG_BOARD_POWER_MANAGEMENT=1", "-DCONFIG_BOARD_XINLUCITY_ESP32S3_NANO=1", "-DCONFIG_IDF_TARGET_ESP32S3=1"] },
  board_disabled: { ...boardDriver, flags: ["-DCONFIG_IDF_TARGET_ESP32S3=1"] },
  board_unsupported: { ...boardDriver, flags: ["-DCONFIG_BOARD_XINLUCITY_ESP32S3_NANO=1"] },
  runtime_status: {
    includes: [...boardDriver.includes, ".cache/tests", "components/web_server", "components/web_server/include",
      "components/network", "components/network/include", "components/firmware_update/include", "components/usb_keyboard/include", "managed_components/espressif__cjson/cJSON"],
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
for (const header of ["sdkconfig.h", "esp_err.h", "esp_log.h", "esp_timer.h", "esp_sleep.h", "nvs.h", "driver/gpio.h", "driver/rtc_io.h", "freertos/FreeRTOS.h", "freertos/task.h"]) {
  const path = resolve(".cache/tests/board-stubs", header);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#include "idf_stubs.h"\n');
}
for (const header of ["sdkconfig.h", "esp_err.h", "esp_log.h", "esp_timer.h", "esp_flash.h", "esp_ota_ops.h", "esp_system.h", "esp_image_format.h",
  "freertos/FreeRTOS.h", "freertos/task.h", "hal/wdt_hal.h", "psa/crypto.h"]) {
  const path = resolve(".cache/tests/update-stubs", header);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#include "update_stubs.h"\n');
}
const section = (source, start, end) => {
  const first = source.indexOf(start);
  assert.ok(first >= 0 && first === source.lastIndexOf(start), `Expected unique source anchor: ${start}`);
  const last = source.indexOf(end, first + start.length);
  assert.ok(last > first, `Missing source boundary: ${end}`);
  return source.slice(first, last);
};
const normalizedSource = async path => (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
const network = await normalizedSource("components/network/network.c");
const web = await normalizedSource("components/web_server/web_server.c");
await writeFile(".cache/tests/power_http.inc",
  section(web, "static cJSON *power_json(void)\n{", "\nstatic cJSON *network_json(void)\n{"));
await writeFile(".cache/tests/wakeup_http.inc",
  section(web, "static bool wakeup_peer_allowed(", "\nstatic cJSON *power_json(void)\n{"));
const usb = await normalizedSource("components/usb_keyboard/usb_keyboard.c");
await writeFile(".cache/tests/usb_power.inc",
  section(usb, "#define USB_KEYBOARD_WAKE_TIMEOUT_US", "\nconst uint8_t *tud_hid_descriptor_report_cb") +
  section(usb, "void tud_hid_report_complete_cb(", "\nbool usb_keyboard_service_healthy"));
const skippedSdkBootloader = selected.includes("update_service") && !process.env.IDF_PATH;
let bootloaderFixture = "";
let signatureFixture = "";
let sleepFixture = "";
if (process.env.IDF_PATH) {
  const sleep = await readFile(resolve(process.env.IDF_PATH, "components/esp_hw_support/sleep_modes.c"), "utf8");
  assert.match(sleep, /if \(s_config\.wakeup_triggers & RTC_EXT1_TRIG_EN\) \{\s*ext1_wakeup_prepare\(\);/);
  assert.ok(sleep.includes("esp_sleep_start(sleep_flags, ESP_SLEEP_MODE_DEEP_SLEEP, allow_sleep_rejection)"));
  sleepFixture = '#include "soc/soc_caps.h"\n' +
    section(sleep, "static void ext1_wakeup_prepare(void)\n{", "\nuint64_t esp_sleep_get_ext1_wakeup_status(void)");
  const bootloader = await readFile(resolve(process.env.IDF_PATH, "components/bootloader_support/src/bootloader_utility.c"), "utf8");
  bootloaderFixture = "#define UPDATE_TEST_SDK_BOOTLOADER 1\nstatic bool ota_has_initial_contents;\n" +
    section(bootloader, "int bootloader_utility_get_selected_boot_partition(const bootloader_state_t *bs)", "\n}\n") + "\n}\n" +
    section(bootloader, "static void set_actual_ota_seq(const bootloader_state_t *bs, int index)", "\n}\n") + "\n}\n";
  assert.equal(bootloader.match(/set_actual_ota_seq\(bs, index\);\s*load_image\(&image_data\);/g)?.length, 2,
    "SDK must initialize selected OTA metadata before both normal and fallback image entry paths");
  const signatures = await readFile(resolve(process.env.IDF_PATH,
    "components/bootloader_support/src/secure_boot_v2/secure_boot_signatures_app.c"), "utf8");
  signatureFixture = "#define UPDATE_TEST_SDK_SIGNATURE 1\n" + [
    "esp_err_t esp_secure_boot_get_signature_blocks_for_running_app(bool digest_public_keys, esp_image_sig_public_key_digests_t *public_key_digests)",
    "static esp_err_t get_secure_boot_key_digests(esp_image_sig_public_key_digests_t *public_key_digests)",
    "esp_err_t esp_secure_boot_verify_sbv2_signature_block(const ets_secure_boot_signature_t *sig_block, const uint8_t *image_digest, uint8_t *verified_digest)",
  ].map(anchor => section(signatures, anchor, "\n}\n") + "\n}\n").join("");
}
await writeFile(".cache/tests/sdk_bootloader.inc", bootloaderFixture);
await writeFile(".cache/tests/sdk_sleep_prepare.inc", sleepFixture);
await writeFile(".cache/tests/sdk_signature_verifier.inc", signatureFixture);
await writeFile(".cache/tests/network_observer.inc",
  section(network, "network_control_status_t network_control_status(uint32_t generation)", "\nbool network_control_begin") +
  section(network, "bool network_control_begin(uint32_t local_address, uint32_t generation)", "\nstatic bool recovery_held") +
  section(network, "bool network_service_healthy(void)", "\nesp_err_t network_submit"));
await writeFile(".cache/tests/network_effect_decision.inc",
  `static network_effect_t network_test_effect(int64_t now)\n{\n${
    section(network, "        bool was_testing = testing;", "\n        if (effect == NETWORK_OPEN_AP)")
  }\n    (void)was_testing;\n    return effect;\n}\n`);
await writeFile(".cache/tests/network_sleep_worker.inc", section(network, "static bool sleep_step(void)", "\nstatic void network_worker"));
await writeFile(".cache/tests/input_client.inc",
  section(web, "typedef struct {\n    int socket;", "\nstatic input_client_t *active_client;"));
await writeFile(".cache/tests/web_observer.inc",
  section(web, "web_server_status_t web_server_status(void)", "\nstatic esp_err_t problem"));
await writeFile(".cache/tests/update_owner_expiry.inc",
  `static void expire_update_owner_for_test(int64_t now)\n{\n${section(
    section(web, "static void expire_control(void *argument)", "\nstatic void control_tick"),
    "    firmware_update_tick();", "\n    if (pending_owner != NULL")
  }\n}\n`);
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
if (skippedSdkBootloader) {
  console.warn("SKIP: SDK erased-otadata first-boot and running-image trust-key checks (IDF_PATH unset). Run from an activated ESP-IDF terminal for this coverage.");
}
if (selected.includes("board_power") && !process.env.IDF_PATH) {
  console.warn("SKIP: SDK EXT1 RTC mux/input/hold preparation (IDF_PATH unset). Run from an activated ESP-IDF terminal for this coverage.");
}