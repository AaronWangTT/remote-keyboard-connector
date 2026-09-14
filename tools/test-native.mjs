import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
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
const suites = {
  network_state: { includes: ["components/network", "managed_components/espressif__cjson/cJSON"],
    sources: ["managed_components/espressif__cjson/cJSON/cJSON.c", "components/network/network_state.c", "components/network/test/network_state_test.c"], flags: ["-DCJSON_NESTING_LIMIT=4", "-lm"] },
  access_control: { includes: ["components/web_server", "managed_components/espressif__cjson/cJSON"],
    sources: ["managed_components/espressif__cjson/cJSON/cJSON.c", "components/web_server/access_control.c", "components/web_server/test/access_control_test.c"], flags: ["-DCJSON_NESTING_LIMIT=4", "-lm"] },
  keyboard_state: { includes: usbIncludes, sources: ["components/usb_keyboard/keyboard_state.c", "components/usb_keyboard/test/keyboard_state_test.c"] },
  input_protocol: { includes: [...usbIncludes, "components/web_server", "managed_components/espressif__cjson/cJSON"],
    sources: ["managed_components/espressif__cjson/cJSON/cJSON.c", "components/usb_keyboard/keyboard_state.c", "components/web_server/input_protocol.c", "components/web_server/test/input_protocol_test.c"], flags: ["-DCJSON_NESTING_LIMIT=4", "-lm"] },
};
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(suites);
await mkdir(".cache/tests", { recursive: true });
for (const name of selected) {
  assert.ok(Object.hasOwn(suites, name), `Unknown native suite: ${name}`);
  const suite = suites[name];
  const output = resolve(`.cache/tests/${name}_test${process.platform === "win32" ? ".exe" : ""}`);
  execFileSync(compiler, [...prefix, ...flags, ...suite.includes.map(path => `-I${path}`), ...suite.sources,
    ...(suite.flags ?? []), "-o", output], { stdio: "inherit" });
  execFileSync(output, [], { stdio: "inherit" });
}
console.log(`PASS: ${selected.length} native suite(s) executed${process.platform === "win32" ? " (Windows, without sanitizers)" : " with ASan/UBSan"}.`);