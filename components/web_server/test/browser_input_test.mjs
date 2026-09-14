import assert from "node:assert/strict";
import test from "node:test";
import { KeyboardInput, characterKey, physicalKeys, layouts, bottomRow,
  SHIFT_LEFT, SHIFT_RIGHT, CAPS_LOCK } from "../www/keyboard.mjs";

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

test("1000 letter and symbol taps preserve report pairs", () => {
  const keyboard = new KeyboardInput();
  for (let tap = 0; tap < 1000; tap++) {
    const key = characterKey("aZ?9"[tap % 4]);
    assert.deepEqual(keyboard.press("tap", key, tap * 20), [{ modifiers: key.modifiers, keys: [key.usage] }]);
    assert.deepEqual(keyboard.press("tap", key, tap * 20 + 1), []);
    assert.deepEqual(keyboard.release("tap", tap * 20 + 10), [neutral]);
  }
});