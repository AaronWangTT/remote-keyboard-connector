export const SHIFT_LEFT = 2;
export const SHIFT_RIGHT = 32;
export const CAPS_LOCK = 57;
export const DEFAULT_HOST_PROFILE = "ios";

const WINDOWS_IME_HOLD_MS = 1000;
const hostCommands = Object.freeze({
  ios: Object.freeze({ modifiers: 1, keys: Object.freeze([44]) }),
  windows: Object.freeze({ modifiers: 8, keys: Object.freeze([44]) }),
});
const cancelCommand = Object.freeze({ modifiers: 0, keys: Object.freeze([41]) });

export function validHostProfile(profile) {
  return Object.hasOwn(hostCommands, profile);
}

export const physicalKeys = new Map();
const characters = new Map();
const usageKeys = new Map();

function register(code, usage, lower, upper = lower) {
  const key = Object.freeze({ code, usage, label: lower, upper, modifiers: 0 });
  physicalKeys.set(code, key);
  usageKeys.set(usage, key);
  if (lower.length === 1) characters.set(lower, key);
  if (upper !== lower) characters.set(upper, Object.freeze({ ...key, label: upper, modifiers: SHIFT_LEFT }));
}

for (let index = 0; index < 26; index++) {
  const upper = String.fromCharCode(65 + index);
  register(`Key${upper}`, 4 + index, upper.toLowerCase(), upper);
}
for (let index = 0; index < 10; index++) {
  register(`Digit${"1234567890"[index]}`, 30 + index, "1234567890"[index], "!@#$%^&*()"[index]);
}
for (const [code, usage, lower, upper] of [
  ["Minus", 45, "-", "_"], ["Equal", 46, "=", "+"],
  ["BracketLeft", 47, "[", "{"], ["BracketRight", 48, "]", "}"],
  ["Backslash", 49, "\\", "|"], ["Semicolon", 51, ";", ":"],
  ["Quote", 52, "'", '"'], ["Backquote", 53, "`", "~"],
  ["Comma", 54, ",", "<"], ["Period", 55, ".", ">"], ["Slash", 56, "/", "?"],
]) register(code, usage, lower, upper);
register("Space", 44, " ");
register("Enter", 40, "return");
register("Backspace", 42, "delete");
register("CapsLock", CAPS_LOCK, "caps lock");
physicalKeys.set("ShiftLeft", Object.freeze({ code: "ShiftLeft", modifiers: SHIFT_LEFT }));
physicalKeys.set("ShiftRight", Object.freeze({ code: "ShiftRight", modifiers: SHIFT_RIGHT }));

export function characterKey(character) {
  return characters.get(character);
}

const row = text => [...text].map(characterKey);
const shift = Object.freeze({ action: "shift", label: "Shift", icon: "shift" });
const backspace = Object.freeze({ ...physicalKeys.get("Backspace"), icon: "backspace" });
const mode = (page, label) => Object.freeze({ action: "page", page, label });

export const layouts = {
  letters: [row("qwertyuiop"), row("asdfghjkl"), [shift, ...row("zxcvbnm"), backspace]],
  numbers: [row("1234567890"), row('-/:;()$&@"'), [mode("symbols", "#+="), ...row(".,?!'"), backspace]],
  symbols: [row("[]{}#%^*+="), row("_\\|~<>$&@`"), [mode("numbers", "123"), ...row(".,?!'"), backspace]],
};

export function bottomRow(page) {
  return [mode(page === "letters" ? "numbers" : "letters", page === "letters" ? "123" : "ABC"),
    { ...physicalKeys.get("Space"), label: "space" },
    { ...physicalKeys.get("Enter"), icon: "return" }];
}

export const utilityKeys = Object.freeze([
  Object.freeze({ action: "globe", label: "Switch input source", icon: "globe" }),
  Object.freeze({ action: "cancel", label: "Cancel (Escape)", icon: "x" }),
]);

export function updateLocalEcho(text, previous, report, capsLock) {
  if (report.modifiers & ~(SHIFT_LEFT | SHIFT_RIGHT)) return text;
  const shifted = (report.modifiers & (SHIFT_LEFT | SHIFT_RIGHT)) !== 0;
  for (const usage of report.keys) {
    if (previous.keys.includes(usage)) continue;
    const key = usageKeys.get(usage);
    if (key?.code === "Enter") return "";
    else if (key?.code === "Backspace") text = text.slice(0, -1);
    else if (key?.label.length === 1) {
      const uppercase = key.code.startsWith("Key") ? shifted !== (capsLock === true) : shifted;
      text += uppercase ? key.upper : key.label;
    }
  }
  return text.slice(-256);
}

export class KeyboardInput {
  constructor() {
    this.capsLock = null;
    this.clear();
  }

  clear() {
    this.sources = new Map();
    this.shiftLatched = false;
    this.chordShift = false;
    this.lastShiftTap = -Infinity;
    this.capsPending = false;
    this.capsRequestedAt = 0;
    this.capsExpected = null;
  }

  setCapsLock(value) {
    this.capsLock = value;
    if (this.capsPending && typeof value === "boolean" &&
        (this.capsExpected === null || this.capsExpected === value)) this.capsPending = false;
  }

  expireCapsRequest(now) {
    if (this.capsPending && now - this.capsRequestedAt >= 1500) this.capsPending = false;
  }

  get report() {
    let modifiers = this.chordShift ? SHIFT_LEFT : 0;
    let deferredModifiers = 0;
    const keys = new Set();
    for (const source of this.sources.values()) {
      if (source.deferStandalone) deferredModifiers |= source.modifiers ?? 0;
      else modifiers |= source.modifiers ?? 0;
      if (source.usage !== undefined) keys.add(source.usage);
    }
    if (keys.size) modifiers |= deferredModifiers;
    if (keys.size > 6) throw new Error("key_capacity");
    return { modifiers, keys: [...keys].sort((left, right) => left - right) };
  }

  get shiftActive() {
    return this.shiftLatched || [...this.sources.values()].some(source => source.controlShift) ||
      (this.report.modifiers & (SHIFT_LEFT | SHIFT_RIGHT)) !== 0;
  }

  get uppercase() {
    return (this.capsLock === true) !== this.shiftActive;
  }

  requestCaps(now) {
    if (this.capsPending) return [];
    const base = this.report;
    if (base.keys.includes(CAPS_LOCK)) return [];
    if (base.keys.length === 6) throw new Error("key_capacity");
    this.capsPending = true;
    this.capsRequestedAt = now;
    this.capsExpected = this.capsLock === null ? null : !this.capsLock;
    return [{ ...base, keys: [...base.keys, CAPS_LOCK].sort((left, right) => left - right) }, base];
  }

  activateCommand(action, hostProfile) {
    const command = action === "globe" && validHostProfile(hostProfile) ? hostCommands[hostProfile] :
      action === "cancel" ? cancelCommand : undefined;
    if (!command) return [];
    this.clear();
    return [this.report, { modifiers: command.modifiers, keys: [...command.keys] }, this.report];
  }

  press(sourceId, key, now, hostProfile = DEFAULT_HOST_PROFILE) {
    if (this.sources.has(sourceId)) return [];
    for (const source of this.sources.values()) {
      if (source.deferStandalone) source.used = true;
    }
    if (key.action === "shift") {
      this.sources.set(sourceId, { modifiers: SHIFT_LEFT, controlShift: true, started: now,
        deferStandalone: hostProfile === "windows",
        initialLatch: this.shiftLatched,
        used: this.report.keys.length > 0 || (hostProfile === "windows" && this.sources.size > 0) });
    } else {
      if (key.usage !== undefined && key.usage !== CAPS_LOCK) {
        for (const source of this.sources.values()) if (source.controlShift) source.used = true;
        if (this.shiftLatched) {
          this.chordShift = true;
          this.shiftLatched = false;
        }
        this.lastShiftTap = -Infinity;
      }
      this.sources.set(sourceId, key);
    }
    return [this.report];
  }

  release(sourceId, now) {
    const source = this.sources.get(sourceId);
    if (!source) return [];
    this.sources.delete(sourceId);
    if (![...this.sources.values()].some(held => held.usage !== undefined && held.usage !== CAPS_LOCK)) {
      this.chordShift = false;
    }
    if (source.deferStandalone && !source.used && this.sources.size === 0 &&
        now - source.started >= WINDOWS_IME_HOLD_MS) {
      this.shiftLatched = false;
      this.lastShiftTap = -Infinity;
      return [this.report, { modifiers: SHIFT_LEFT, keys: [] }, this.report];
    }
    if (source.controlShift && !source.used && now - source.started <= 400) {
      if (this.capsLock === true || now - this.lastShiftTap <= 300) {
        this.shiftLatched = false;
        this.lastShiftTap = -Infinity;
        return [this.report, ...this.requestCaps(now)];
      }
      this.shiftLatched = !source.initialLatch;
      this.lastShiftTap = now;
    }
    return [this.report];
  }
}