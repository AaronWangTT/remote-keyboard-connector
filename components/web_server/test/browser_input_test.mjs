import assert from "node:assert/strict";
import test from "node:test";
import { KeyboardInput, characterKey, physicalKeys, layouts, bottomRow,
  SHIFT_LEFT, SHIFT_RIGHT, CAPS_LOCK, DEFAULT_HOST_PROFILE, validHostProfile,
  utilityKeys, updateLocalEcho } from "../www/keyboard.mjs";

const neutral = { modifiers: 0, keys: [] };
const shift = layouts.letters[2][0];

test("all printable US-ANSI characters have an allowed HID mapping", () => {
  for (let code = 32; code < 127; code++) {
    const key = characterKey(String.fromCharCode(code));
    assert.ok(key, `Unmapped character ${code}`);
    assert.ok(key.usage >= 4 && key.usage <= 56 && key.usage !== 50);
    assert.ok(key.modifiers === 0 || key.modifiers === SHIFT_LEFT);
  }
  for (const code of ["Escape", "Tab", "ArrowLeft", "F1", "ControlLeft", "MetaLeft", "AltRight"]) {
    assert.equal(physicalKeys.has(code), false);
  }
});

test("iPhone pages contain all base printable keys", () => {
  assert.equal(layouts.letters[0].map(key => key.label).join(""), "qwertyuiop");
  assert.equal(layouts.letters[1].map(key => key.label).join(""), "asdfghjkl");
  assert.equal(layouts.numbers[0].map(key => key.label).join(""), "1234567890");
  const labels = new Set(Object.values(layouts).flat(2).map(key => key.label));
  for (let code = 33; code < 127; code++) {
    if (code >= 65 && code <= 90) continue;
    assert.ok(labels.has(String.fromCharCode(code)), `Missing layout character ${code}`);
  }
  assert.deepEqual(bottomRow("letters").map(key => key.label), ["123", "space", "return"]);
  assert.equal(bottomRow("symbols")[0].label, "ABC");
});

test("overlapping physical and pointer holds release independently", () => {
  const keyboard = new KeyboardInput();
  keyboard.press("physical:a", characterKey("a"), 0);
  keyboard.press("pointer:1", characterKey("a"), 1);
  keyboard.press("pointer:2", characterKey("s"), 2);
  assert.deepEqual(keyboard.release("physical:a", 3), [{ modifiers: 0, keys: [4, 22] }]);
  assert.deepEqual(keyboard.release("pointer:1", 4), [{ modifiers: 0, keys: [22] }]);
  assert.deepEqual(keyboard.release("pointer:2", 5), [neutral]);
});

test("Shift tap latches for one chord and releases after its last key", () => {
  const keyboard = new KeyboardInput();
  keyboard.press("shift", shift, 0);
  assert.deepEqual(keyboard.release("shift", 50), [neutral]);
  assert.equal(keyboard.shiftLatched, true);
  keyboard.press("a", characterKey("a"), 100);
  keyboard.press("s", characterKey("s"), 110);
  assert.equal(keyboard.shiftLatched, false);
  assert.deepEqual(keyboard.release("a", 120), [{ modifiers: SHIFT_LEFT, keys: [22] }]);
  assert.deepEqual(keyboard.release("s", 130), [neutral]);
  assert.equal(keyboard.shiftActive, false);
});

test("held Shift chords and long holds do not leave a latch", () => {
  const keyboard = new KeyboardInput();
  keyboard.press("shift", shift, 0);
  keyboard.press("a", characterKey("a"), 10);
  assert.deepEqual(keyboard.report, { modifiers: SHIFT_LEFT, keys: [4] });
  keyboard.release("a", 20);
  keyboard.release("shift", 30);
  assert.equal(keyboard.shiftLatched, false);
  keyboard.press("shift", shift, 50);
  keyboard.release("shift", 600);
  assert.equal(keyboard.shiftLatched, false);
});

test("Windows touch Shift taps stay local and capitalize the next chord", () => {
  const keyboard = new KeyboardInput();
  assert.deepEqual(keyboard.press("shift", shift, 0, "windows"), [neutral]);
  assert.equal(keyboard.shiftActive, true);
  assert.deepEqual(keyboard.release("shift", 50), [neutral]);
  assert.equal(keyboard.shiftLatched, true);
  assert.deepEqual(keyboard.press("a", characterKey("a"), 100, "windows"),
    [{ modifiers: SHIFT_LEFT, keys: [4] }]);
  assert.equal(keyboard.shiftLatched, false);
  assert.deepEqual(keyboard.release("a", 150), [neutral]);
  assert.equal(keyboard.shiftActive, false);
  assert.deepEqual(keyboard.press("shift", shift, 500, "windows"), [neutral]);
  assert.deepEqual(keyboard.release("shift", 550), [neutral]);
  assert.deepEqual(keyboard.press("shift", shift, 1000, "windows"), [neutral]);
  assert.deepEqual(keyboard.release("shift", 1050), [neutral]);
  assert.equal(keyboard.shiftLatched, false);
});

test("Windows held touch Shift has no standalone report in either release order", () => {
  for (const releaseShiftFirst of [false, true]) {
    const keyboard = new KeyboardInput();
    assert.deepEqual(keyboard.press("shift", shift, 0, "windows"), [neutral]);
    assert.deepEqual(keyboard.press("a", characterKey("a"), 50, "windows"),
      [{ modifiers: SHIFT_LEFT, keys: [4] }]);
    if (releaseShiftFirst) {
      assert.deepEqual(keyboard.release("shift", 1500), [{ modifiers: 0, keys: [4] }]);
      assert.deepEqual(keyboard.release("a", 1550), [neutral]);
    } else {
      assert.deepEqual(keyboard.release("a", 1500), [neutral]);
      assert.equal(keyboard.shiftActive, true);
      assert.deepEqual(keyboard.release("shift", 1550), [neutral]);
    }
    assert.equal(keyboard.shiftLatched, false);
    assert.deepEqual(keyboard.press("shift", shift, 2000, "windows"), [neutral]);
    assert.deepEqual(keyboard.release("shift", 2500), [neutral]);
    assert.equal(keyboard.shiftActive, false);
  }
});

test("Windows long Shift holds toggle IME once on release without a capitalization latch", () => {
  for (const duration of [999, 1000, 2500]) {
    const keyboard = new KeyboardInput();
    assert.deepEqual(keyboard.press("shift", shift, 0, "windows"), [neutral]);
    assert.deepEqual(keyboard.release("shift", duration), duration >= 1000 ?
      [neutral, { modifiers: SHIFT_LEFT, keys: [] }, neutral] : [neutral]);
    assert.equal(keyboard.shiftLatched, false);
    assert.equal(keyboard.shiftActive, false);
    assert.deepEqual(keyboard.release("shift", duration + 10), []);
    assert.deepEqual(keyboard.press("a", characterKey("a"), duration + 20, "windows"),
      [{ modifiers: 0, keys: [4] }]);
  }
  const keyboard = new KeyboardInput();
  keyboard.press("shift", shift, 0, "windows");
  keyboard.release("shift", 40);
  assert.equal(keyboard.shiftLatched, true);
  keyboard.press("shift", shift, 500, "windows");
  assert.deepEqual(keyboard.release("shift", 1500),
    [neutral, { modifiers: SHIFT_LEFT, keys: [] }, neutral]);
  assert.equal(keyboard.shiftLatched, false);
  keyboard.press("shift", shift, 1600, "windows");
  assert.deepEqual(keyboard.release("shift", 1640), [neutral]);
  assert.equal(keyboard.shiftLatched, true);
  assert.equal(keyboard.capsPending, false);
});

test("Windows long Shift holds cannot toggle IME after cancellation or other input", () => {
  const keyboard = new KeyboardInput();
  keyboard.press("shift", shift, 0, "windows");
  keyboard.clear();
  assert.deepEqual(keyboard.release("shift", 2000), []);
  for (const key of [physicalKeys.get("CapsLock"), physicalKeys.get("ShiftRight"), shift]) {
    keyboard.clear();
    keyboard.press("shift", shift, 0, "windows");
    keyboard.press("other", key, 500, "windows");
    keyboard.release("other", 550);
    assert.deepEqual(keyboard.release("shift", 2000), [neutral]);
    assert.equal(keyboard.shiftLatched, false);
    keyboard.press("other", key, 2500, "windows");
    keyboard.press("shift", shift, 2600, "windows");
    keyboard.release("other", 2700);
    assert.deepEqual(keyboard.release("shift", 4000), [neutral]);
  }
});

test("Windows touch Shift preserves Caps Lock and physical Shift reports", () => {
  const keyboard = new KeyboardInput();
  keyboard.setCapsLock(false);
  assert.deepEqual(keyboard.press("shift", shift, 0, "windows"), [neutral]);
  assert.deepEqual(keyboard.release("shift", 40), [neutral]);
  assert.deepEqual(keyboard.press("shift", shift, 100, "windows"), [neutral]);
  assert.deepEqual(keyboard.release("shift", 140),
    [neutral, { modifiers: 0, keys: [CAPS_LOCK] }, neutral]);
  keyboard.setCapsLock(true);
  assert.equal(keyboard.uppercase, true);
  assert.deepEqual(keyboard.press("shift", shift, 500, "windows"), [neutral]);
  assert.equal(keyboard.uppercase, false);
  assert.deepEqual(keyboard.release("shift", 540),
    [neutral, { modifiers: 0, keys: [CAPS_LOCK] }, neutral]);
  for (const code of ["ShiftLeft", "ShiftRight"]) {
    assert.deepEqual(keyboard.press(code, physicalKeys.get(code), 1000, "windows"),
      [{ modifiers: physicalKeys.get(code).modifiers, keys: [] }]);
    assert.deepEqual(keyboard.release(code, 1050), [neutral]);
    assert.equal(keyboard.shiftLatched, false);
  }
});

test("left and right physical Shift stay independent", () => {
  const keyboard = new KeyboardInput();
  keyboard.press("left", physicalKeys.get("ShiftLeft"), 0);
  keyboard.press("right", physicalKeys.get("ShiftRight"), 0);
  keyboard.press("letter", physicalKeys.get("KeyQ"), 1);
  assert.deepEqual(keyboard.report, { modifiers: SHIFT_LEFT | SHIFT_RIGHT, keys: [20] });
  assert.deepEqual(keyboard.release("left", 2), [{ modifiers: SHIFT_RIGHT, keys: [20] }]);
  keyboard.release("right", 3);
  assert.deepEqual(keyboard.release("letter", 4), [neutral]);
});

test("symbol keys express Shift through HID, not text values", () => {
  const keyboard = new KeyboardInput();
  for (const [character, usage, modifiers] of [["@", 31, 2], ["?", 56, 2], ["~", 53, 2], ["[", 47, 0], ["\\", 49, 0]]) {
    assert.deepEqual(keyboard.press("symbol", characterKey(character), 0), [{ modifiers, keys: [usage] }]);
    assert.deepEqual(keyboard.release("symbol", 1), [neutral]);
  }
});

test("double-tap Shift requests Caps but waits for LED confirmation", () => {
  const keyboard = new KeyboardInput();
  keyboard.setCapsLock(false);
  keyboard.press("shift", shift, 0);
  keyboard.release("shift", 40);
  keyboard.press("shift", shift, 100);
  assert.deepEqual(keyboard.release("shift", 140), [neutral, { modifiers: 0, keys: [CAPS_LOCK] }, neutral]);
  assert.equal(keyboard.capsLock, false);
  assert.equal(keyboard.capsPending, true);
  keyboard.setCapsLock(false);
  assert.equal(keyboard.capsPending, true);
  keyboard.setCapsLock(true);
  assert.equal(keyboard.capsPending, false);
  assert.equal(keyboard.uppercase, true);
  keyboard.press("shift", shift, 200);
  assert.equal(keyboard.uppercase, false);
  keyboard.release("shift", 240);
  keyboard.setCapsLock(false);
  assert.equal(keyboard.uppercase, false);
});

test("missing LED feedback never claims Caps success", () => {
  const keyboard = new KeyboardInput();
  keyboard.requestCaps(0);
  assert.equal(keyboard.capsLock, null);
  keyboard.expireCapsRequest(1500);
  assert.equal(keyboard.capsPending, false);
  assert.equal(keyboard.capsLock, null);
});

test("six unique keys fit, seventh key and capacity-breaking Caps fail", () => {
  const keyboard = new KeyboardInput();
  for (const character of "abcdef") keyboard.press(character, characterKey(character), 0);
  assert.equal(keyboard.report.keys.length, 6);
  assert.throws(() => keyboard.requestCaps(1), /key_capacity/);
  assert.throws(() => keyboard.press("g", characterKey("g"), 2), /key_capacity/);
  keyboard.clear();
  assert.deepEqual(keyboard.report, neutral);
});

test("clear cancels held keys, latches, and requests without replay", () => {
  const keyboard = new KeyboardInput();
  keyboard.press("shift", shift, 0);
  keyboard.release("shift", 10);
  keyboard.press("a", characterKey("a"), 20);
  keyboard.clear();
  assert.deepEqual(keyboard.report, neutral);
  assert.equal(keyboard.shiftLatched, false);
  assert.deepEqual(keyboard.release("a", 30), []);
});

test("Globe commands clear input and use exact configured host chords", () => {
  const keyboard = new KeyboardInput();
  keyboard.press("shift", shift, 0);
  keyboard.release("shift", 10);
  keyboard.press("a", characterKey("a"), 20);
  assert.equal(DEFAULT_HOST_PROFILE, "ios");
  assert.deepEqual(keyboard.activateCommand("globe", "ios"), [
    neutral, { modifiers: 1, keys: [44] }, neutral,
  ]);
  assert.deepEqual(keyboard.report, neutral);
  assert.equal(keyboard.shiftLatched, false);
  assert.deepEqual(keyboard.release("a", 30), []);
  assert.deepEqual(keyboard.activateCommand("globe", "windows"), [
    neutral, { modifiers: 8, keys: [44] }, neutral,
  ]);
});

test("unsupported Globe profiles emit nothing and preserve current input", () => {
  const keyboard = new KeyboardInput();
  keyboard.press("a", characterKey("a"), 0);
  assert.equal(validHostProfile("ios"), true);
  assert.equal(validHostProfile("windows"), true);
  for (const profile of ["", "macos", "linux", "constructor", "toString", "__proto__", null, undefined]) {
    assert.equal(validHostProfile(profile), false);
    assert.deepEqual(keyboard.activateCommand("globe", profile), []);
    assert.deepEqual(keyboard.report, { modifiers: 0, keys: [4] });
  }
});

test("Cancel is one isolated Escape tap and never becomes a physical key", () => {
  const keyboard = new KeyboardInput();
  keyboard.press("shift", shift, 0);
  keyboard.press("a", characterKey("a"), 1);
  assert.deepEqual(keyboard.activateCommand("cancel", "windows"), [
    neutral, { modifiers: 0, keys: [41] }, neutral,
  ]);
  assert.deepEqual(keyboard.activateCommand("unknown", "ios"), []);
  assert.deepEqual(utilityKeys.map(key => [key.action, key.label]), [
    ["globe", "Switch input source"], ["cancel", "Cancel (Escape)"],
  ]);
  for (const code of ["Escape", "ControlLeft", "ControlRight", "MetaLeft", "MetaRight"]) {
    assert.equal(physicalKeys.has(code), false);
  }
});

test("1000 letter and symbol taps preserve report pairs", () => {
  const keyboard = new KeyboardInput();
  for (let tap = 0; tap < 1000; tap++) {
    const key = characterKey("aZ?9"[tap % 4]);
    assert.deepEqual(keyboard.press("tap", key, tap * 20), [{ modifiers: key.modifiers, keys: [key.usage] }]);
    assert.deepEqual(keyboard.press("tap", key, tap * 20 + 1), []);
    assert.deepEqual(keyboard.release("tap", tap * 20 + 10), [neutral]);
  }
});

test("local echo derives every printable character from US-ANSI reports", () => {
  for (let code = 32; code < 127; code++) {
    const character = String.fromCharCode(code);
    const key = characterKey(character);
    const report = { modifiers: key.modifiers, keys: [key.usage] };
    assert.equal(updateLocalEcho("", neutral, report, false), character);
  }
  assert.equal(updateLocalEcho("", neutral, { modifiers: 0, keys: [4] }, true), "A");
  assert.equal(updateLocalEcho("", neutral, { modifiers: SHIFT_RIGHT, keys: [4] }, true), "a");
  assert.equal(updateLocalEcho("", neutral, { modifiers: 0, keys: [30] }, true), "1");
  assert.equal(updateLocalEcho("", neutral, { modifiers: SHIFT_LEFT, keys: [30] }, true), "!");
  assert.equal(updateLocalEcho("", neutral, { modifiers: 0, keys: [4] }, null), "a");
});

test("local echo counts new usages only, not releases, holds or modifier changes", () => {
  const held = { modifiers: 0, keys: [4] };
  assert.equal(updateLocalEcho("a", held, held, false), "a");
  assert.equal(updateLocalEcho("a", held, neutral, false), "a");
  assert.equal(updateLocalEcho("a", held, { modifiers: SHIFT_LEFT, keys: [4] }, false), "a");
  assert.equal(updateLocalEcho("a", held, { modifiers: SHIFT_LEFT, keys: [4, 5] }, false), "aB");
  assert.equal(updateLocalEcho("a", neutral, held, false), "aa");
  const keyboard = new KeyboardInput();
  for (const action of ["globe", "cancel"]) {
    let previous = neutral;
    for (const report of keyboard.activateCommand(action, "ios")) {
      assert.equal(updateLocalEcho("existing", previous, report, false), "existing");
      previous = report;
    }
  }
  assert.equal(updateLocalEcho("existing", neutral, { modifiers: 8, keys: [44] }, false), "existing");
  assert.equal(updateLocalEcho("existing", neutral, { modifiers: 0, keys: [CAPS_LOCK] }, false), "existing");
});

test("local echo Backspace and Return edit only the bounded local tail", () => {
  const backspace = { modifiers: 0, keys: [42] };
  const enter = { modifiers: 0, keys: [40] };
  assert.equal(updateLocalEcho("hello ", neutral, backspace, false), "hello");
  assert.equal(updateLocalEcho("", neutral, backspace, false), "");
  assert.equal(updateLocalEcho("hello", backspace, backspace, false), "hello");
  assert.equal(updateLocalEcho("hello", neutral, enter, false), "");
  assert.equal(updateLocalEcho("hello", enter, neutral, false), "hello");
  assert.equal(updateLocalEcho("a".repeat(256), neutral, { modifiers: 0, keys: [5] }, false), `${"a".repeat(255)}b`);
});

test("new Return clears the whole local echo report even with simultaneous printable keys", () => {
  for (const modifiers of [0, SHIFT_LEFT, SHIFT_RIGHT]) {
    for (const keys of [[40, 44], [40, 56], [4, 40, 42, 44, 56]]) {
      assert.equal(updateLocalEcho("existing", neutral, { modifiers, keys }, false), "");
    }
  }
  assert.equal(updateLocalEcho("existing ", { modifiers: 0, keys: [44] },
    { modifiers: 0, keys: [40, 44] }, false), "");
  assert.equal(updateLocalEcho("next", { modifiers: 0, keys: [40] },
    { modifiers: 0, keys: [40, 56] }, false), "next/");
});