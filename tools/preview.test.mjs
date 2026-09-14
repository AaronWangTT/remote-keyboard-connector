import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect } from "@playwright/test";
import { WebSocket } from "ws";

async function startPreview(context, environment = {}) {
  const processHandle = fork(new URL("./preview.mjs", import.meta.url), {
    env: { ...process.env, PORT: "0", PREVIEW_USB_READY: "1", PREVIEW_CAPS_LOCK: "0", ...environment },
    silent: true,
  });
  const exited = once(processHandle, "exit");
  context.after(async () => {
    processHandle.kill("SIGTERM");
    await exited;
  });
  const [address] = await once(processHandle, "message", { signal: AbortSignal.timeout(5000) });
  assert.equal(address.type, "listening");
  return address.url;
}

test("mock backend records received states, acknowledgements, and stop", { timeout: 10000 }, async (context) => {
  const url = await startPreview(context);
  const endpoint = new URL("/api/v1/keyboard", url);
  endpoint.protocol = "ws:";
  const connection = new WebSocket(endpoint);
  context.after(() => connection.terminate());
  await once(connection, "open");

  async function exchange(message) {
    const reply = once(connection, "message");
    connection.send(JSON.stringify(message));
    return JSON.parse(String((await reply)[0]));
  }

  assert.equal((await exchange({ v: 1, type: "ping" })).usb_ready, true);
  assert.equal((await exchange({ v: 1, type: "state", seq: 1, modifiers: 0, keys: [4] })).type, "queued");
  assert.equal((await exchange({ v: 1, type: "state", seq: 2, modifiers: 0, keys: [] })).type, "queued");
  let response = await fetch(new URL("/__test__/input", url));
  assert.deepEqual(await response.json(), {
    down: 1, up: 1, stop: 0, queued: 2, forced_release: 0,
    connected: true, pressed: false,
    report: { modifiers: 0, keys: [] }, caps_lock: false,
  });

  assert.equal((await exchange({ v: 1, type: "state", seq: 3, modifiers: 0, keys: [4] })).type, "queued");
  const closed = once(connection, "close");
  connection.send(JSON.stringify({ v: 1, type: "stop" }));
  await closed;
  response = await fetch(new URL("/__test__/input", url));
  const receipts = await response.json();
  assert.equal(receipts.down, 2);
  assert.equal(receipts.up, 1);
  assert.equal(receipts.stop, 1);
  assert.equal(receipts.queued, 3);
  assert.equal(receipts.pressed, false);
});

test("real browser keyboard, mouse, and touch reach the backend once per tap", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 1366, height: 768 } });
  const externalRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== url) externalRequests.push(request.url());
  });
  await page.goto(url);
  const key = page.getByRole("button", { name: "A", exact: true });
  await expect(key).toBeEnabled();
  assert.deepEqual(await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus() })),
                   { hidden: false, focused: true });
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();

  await key.focus();
  await page.keyboard.down("a");
  await page.keyboard.down("a");
  await expect.poll(counters).toMatchObject({ down: 1, up: 0, queued: 1, pressed: true });
  await page.keyboard.up("a");
  await expect.poll(counters).toMatchObject({ down: 1, up: 1, queued: 2, pressed: false });

  await key.click();
  await expect.poll(counters).toMatchObject({ down: 2, up: 2, queued: 4, pressed: false });

  const box = await key.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(counters).toMatchObject({ down: 3, up: 3, queued: 6, pressed: false });
  assert.equal(await key.evaluate(element => getComputedStyle(element).webkitTapHighlightColor), "rgba(0, 0, 0, 0)");

  const screenshots = new URL("../.cache/tests/", import.meta.url);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("keyboard-desktop.png", screenshots)) });
  for (const viewport of [{ width: 375, height: 667 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const key = document.querySelector("#a-key").getBoundingClientRect();
      const header = document.querySelector("header").getBoundingClientRect();
      const footer = document.querySelector("footer").getBoundingClientRect();
      return { width: key.width, height: key.height,
        overflow: document.documentElement.scrollWidth > innerWidth,
        overlap: key.top < header.bottom || key.bottom > footer.top };
    });
    assert.ok(layout.width >= 27 && layout.height >= 44);
    assert.equal(layout.overflow, false);
    assert.equal(layout.overlap, false);
    await page.screenshot({ path: fileURLToPath(new URL(`keyboard-${viewport.width}.png`, screenshots)) });
  }
  assert.deepEqual(externalRequests, []);
  console.log("Browser receipt totals:", JSON.stringify(await counters()));
});

test("mixed holds, touch cancellation, editable focus, and navigation release input", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 375, height: 667 } });
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  await page.goto(url);
  const key = page.getByRole("button", { name: "A", exact: true });
  await expect(key).toBeEnabled();

  await key.focus();
  await page.keyboard.down("a");
  const box = await key.boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.keyboard.up("a");
  await expect(key).toHaveAttribute("aria-pressed", "true");
  await expect.poll(counters).toMatchObject({ down: 1, up: 0, pressed: true });
  await page.mouse.up();
  await expect.poll(counters).toMatchObject({ down: 1, up: 1, pressed: false });

  const touchSession = await page.context().newCDPSession(page);
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: center.x - 6, y: center.y, id: 1 }, { x: center.x + 6, y: center.y, id: 2 }],
  });
  await expect.poll(counters).toMatchObject({ down: 2, up: 1, pressed: true });
  await touchSession.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await expect.poll(counters).toMatchObject({ down: 2, up: 1, stop: 1, pressed: false });

  await expect(key).toBeEnabled();
  await key.focus();
  await page.keyboard.down("a");
  await expect.poll(counters).toMatchObject({ down: 3, pressed: true });
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "local-field";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.up("a");
  await expect.poll(counters).toMatchObject({ down: 3, stop: 2, pressed: false });
  await expect(key).toBeEnabled();
  await page.locator("#local-field").press("a");
  await page.locator("#local-field").press("Control+a");
  assert.equal((await counters()).down, 3);

  await key.focus();
  await page.keyboard.down("a");
  await expect.poll(counters).toMatchObject({ down: 4, pressed: true });
  await page.goto("about:blank");
  await expect.poll(counters).toMatchObject({ down: 4, up: 1, pressed: false });
  const final = await counters();
  assert.ok(final.stop + final.forced_release >= 3);
});

test("a lost WebSocket clears a held key without an explicit up", { timeout: 10000 }, async (context) => {
  const url = await startPreview(context);
  const endpoint = new URL("/api/v1/keyboard", url);
  endpoint.protocol = "ws:";
  const connection = new WebSocket(endpoint);
  context.after(() => connection.terminate());
  await once(connection, "open");
  const queued = once(connection, "message");
  connection.send(JSON.stringify({ v: 1, type: "state", seq: 1, modifiers: 0, keys: [4] }));
  assert.equal(JSON.parse(String((await queued)[0])).type, "queued");
  const closed = once(connection, "close");
  connection.terminate();
  await closed;
  await expect.poll(async () => (await fetch(new URL("/__test__/input", url))).json())
    .toMatchObject({ down: 1, up: 0, stop: 0, forced_release: 1, pressed: false });
});

test("iPhone Shift, Caps feedback, symbols and typing controls send the expected reports", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  const report = async () => (await counters()).report;
  const neutral = { modifiers: 0, keys: [] };
  await page.goto(url);
  await expect(page.getByRole("button", { name: "A", exact: true })).toBeEnabled();

  async function hold(label, expected) {
    const button = page.getByRole("button", { name: label, exact: true });
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(report).toEqual(expected);
    await page.mouse.up();
    await expect.poll(report).toEqual(neutral);
  }

  const shift = page.getByRole("button", { name: "Shift", exact: true });
  await shift.click();
  await expect(shift).toHaveAttribute("data-shift", "latched");
  await hold("Q", { modifiers: 2, keys: [20] });
  await expect(shift).toHaveAttribute("data-shift", "off");
  await shift.dblclick({ delay: 60 });
  await expect(page.locator("#caps-status")).toHaveText("Caps on");
  await expect(page.getByRole("button", { name: "A", exact: true })).toHaveText("A");
  await hold("A", { modifiers: 0, keys: [4] });
  await shift.click();
  await expect(page.locator("#caps-status")).toHaveText("Caps off");

  await page.getByRole("button", { name: "123", exact: true }).click();
  await hold("@", { modifiers: 2, keys: [31] });
  await hold("9", { modifiers: 0, keys: [38] });
  await page.getByRole("button", { name: "#+=", exact: true }).click();
  await hold("~", { modifiers: 2, keys: [53] });
  await hold("\\", { modifiers: 0, keys: [49] });
  await hold("=", { modifiers: 0, keys: [46] });
  for (const [label, usage] of [["Backspace", 42], ["Space", 44], ["Return", 40]]) {
    await hold(label, { modifiers: 0, keys: [usage] });
  }
  await page.keyboard.down("x");
  await expect.poll(report).toEqual({ modifiers: 0, keys: [27] });
  await page.getByRole("button", { name: "ABC", exact: true }).click();
  await expect.poll(report).toEqual(neutral);
  await page.keyboard.up("x");

  const shiftBox = await shift.boundingBox();
  const letterBox = await page.getByRole("button", { name: "A", exact: true }).boundingBox();
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
    { x: shiftBox.x + shiftBox.width / 2, y: shiftBox.y + shiftBox.height / 2, id: 1 },
    { x: letterBox.x + letterBox.width / 2, y: letterBox.y + letterBox.height / 2, id: 2 },
  ] });
  await expect.poll(report).toEqual({ modifiers: 2, keys: [4] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(report).toEqual(neutral);
  await expect(shift).toHaveAttribute("data-shift", "off");
  await page.keyboard.down("ShiftRight");
  await page.keyboard.down("z");
  await expect.poll(report).toEqual({ modifiers: 32, keys: [29] });
  await page.keyboard.up("z");
  await page.keyboard.up("ShiftRight");
  await expect.poll(report).toEqual(neutral);
});

test("six-key overflow releases without sending a partial seventh-key chord", { timeout: 10000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  const states = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === "state") states.push(message);
  }));
  await page.goto(url);
  await expect(page.getByRole("button", { name: "A", exact: true })).toBeEnabled();
  for (const letter of "abcdef") await page.keyboard.down(letter);
  await expect.poll(async () => (await (await fetch(new URL("/__test__/input", url))).json()).report.keys.length).toBe(6);
  await page.keyboard.down("g");
  await expect.poll(async () => (await fetch(new URL("/__test__/input", url))).json())
    .toMatchObject({ pressed: false, stop: 1, down: 6 });
  assert.ok(states.every(state => state.keys.length <= 6 && !state.keys.includes(10)));
  await expect(page.getByRole("button", { name: "A", exact: true })).toBeEnabled();
  await page.keyboard.down("a");
  for (const letter of "abcdefg") await page.keyboard.up(letter);
  const final = await (await fetch(new URL("/__test__/input", url))).json();
  assert.equal(final.down, 6);
  assert.equal(final.pressed, false);
});

test("unknown Caps feedback is not replaced by a guessed lock state", { timeout: 10000 }, async (context) => {
  const url = await startPreview(context, { PREVIEW_CAPS_LOCK: "unknown" });
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  const shift = page.getByRole("button", { name: "Shift", exact: true });
  await expect(shift).toBeEnabled();
  await shift.dblclick({ delay: 60 });
  await expect(page.locator("#caps-status")).toHaveText("Caps pending");
  await expect(page.locator("#caps-status")).toHaveText("Caps unknown");
  assert.equal((await (await fetch(new URL("/__test__/input", url))).json()).caps_lock, null);
});

test("all keyboard pages fit phone, tablet and desktop viewports without overlapping keys", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true });
  const errors = [];
  const external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).origin !== url) external.push(request.url()); });
  await page.goto(url);
  await expect(page.getByRole("button", { name: "A", exact: true })).toBeEnabled();
  const screenshots = new URL("../.cache/tests/", import.meta.url);
  await mkdir(screenshots, { recursive: true });
  for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320],
    [844, 390], [768, 1024], [1024, 768], [1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    for (const mode of ["letters", "numbers", "symbols"]) {
      if (mode === "letters" && await page.locator("#key-rows").getAttribute("data-page") !== "letters") {
        await page.getByRole("button", { name: "ABC", exact: true }).click();
      } else if (mode === "numbers") {
        await page.getByRole("button", { name: "123", exact: true }).click();
      } else if (mode === "symbols") {
        await page.getByRole("button", { name: "#+=", exact: true }).click();
      }
      const layout = await page.evaluate(() => {
        const keys = [...document.querySelectorAll("#key-rows button")];
        const header = document.querySelector("header").getBoundingClientRect();
        const footer = document.querySelector("footer").getBoundingClientRect();
        const problems = [];
        const bounds = keys.map(button => button.getBoundingClientRect());
        keys.forEach((button, index) => {
          const box = bounds[index];
          if (box.width < 27 || box.height < 44) problems.push(`target:${button.getAttribute("aria-label")}`);
          if (box.left < 0 || box.right > innerWidth || box.top < header.bottom || box.bottom > footer.top) problems.push("bounds");
          if (button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1) problems.push("label overflow");
          for (let other = index + 1; other < bounds.length; other++) {
            const next = bounds[other];
            if (box.left < next.right && box.right > next.left && box.top < next.bottom && box.bottom > next.top) problems.push("overlap");
          }
        });
        return { problems, width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight, viewportHeight: innerHeight };
      });
      assert.deepEqual(layout.problems, [], `${width}x${height} ${mode}`);
      assert.ok(layout.width <= width, `Horizontal scrolling at ${width}x${height} ${mode}`);
      assert.ok(layout.height <= layout.viewportHeight + 1, `Vertical scrolling at ${width}x${height} ${mode}: ${layout.height}`);
      if ([320, 390, 568, 768, 1366].includes(width)) {
        await page.screenshot({ path: fileURLToPath(new URL(`keyboard-${width}-${mode}.png`, screenshots)) });
      }
    }
  }
  for (const icon of ["shift", "caps", "backspace", "return", "release"]) {
    const response = await fetch(new URL(`/icons/${icon}.svg`, url));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await response.text(), /<svg/);
  }
  for (const [width, height, top, right, bottom, left] of [[390, 844, 59, 0, 34, 0], [844, 390, 0, 59, 21, 59]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(insets => {
      for (const [side, value] of Object.entries(insets)) document.documentElement.style.setProperty(`--safe-${side}`, `${value}px`);
    }, { top, right, bottom, left });
    const safeLayout = await page.evaluate(() => {
      const header = document.querySelector("header").getBoundingClientRect();
      const footer = document.querySelector("footer").getBoundingClientRect();
      const keys = document.querySelector("#key-rows").getBoundingClientRect();
      return { top: header.top, bottom: footer.bottom, left: keys.left, right: keys.right,
        keyBottom: keys.bottom, footerTop: footer.top, height: document.documentElement.scrollHeight };
    });
    assert.ok(safeLayout.top >= top && safeLayout.bottom <= height - bottom);
    assert.ok(safeLayout.left >= left && safeLayout.right <= width - right);
    assert.ok(safeLayout.keyBottom <= safeLayout.footerTop && safeLayout.height <= height + 1);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

test("buffered sockets, dropped acknowledgements and send errors release and recover without replay", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.transportFault = null;
    const send = WebSocket.prototype.send;
    const listen = WebSocket.prototype.addEventListener;
    const buffered = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount");
    Object.defineProperty(WebSocket.prototype, "bufferedAmount", {
      get() { return window.transportFault === "buffered" ? 2048 : buffered.get.call(this); },
    });
    WebSocket.prototype.send = function (data) {
      if (window.transportFault === "send") throw new Error("Simulated socket send failure");
      return send.call(this, data);
    };
    WebSocket.prototype.addEventListener = function (type, callback, options) {
      if (type !== "message") return listen.call(this, type, callback, options);
      return listen.call(this, type, event => {
        if (window.transportFault === "ack" && JSON.parse(event.data).type === "queued") return;
        callback.call(this, event);
      }, options);
    };
  });
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  await page.goto(url);
  const key = page.getByRole("button", { name: "A", exact: true });
  await expect(key).toBeEnabled();
  for (const fault of ["buffered", "ack", "send"]) {
    const baseline = await counters();
    await page.locator("#keyboard").focus();
    await page.evaluate(fault => { window.transportFault = fault; }, fault);
    await page.keyboard.down("a");
    await expect(key).toBeDisabled();
    await expect.poll(async () => (await counters()).pressed).toBe(false);
    await page.evaluate(() => { window.transportFault = null; });
    await expect(key).toBeEnabled();
    await page.keyboard.down("a");
    await page.keyboard.up("a");
    const received = await counters();
    assert.equal(received.down - baseline.down, fault === "ack" ? 1 : 0, fault);
    assert.equal(received.pressed, false);
  }
  assert.deepEqual(pageErrors, []);
});

test("WebKit loads and types across the iPhone pages with touch and physical keys", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await webkit.launch({ executablePath: process.env.WEBKIT_EXECUTABLE_PATH });
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  await page.goto(url);
  await page.bringToFront();
  const letter = page.getByRole("button", { name: "A", exact: true });
  await expect(letter).toBeEnabled();
  await letter.tap();
  await expect.poll(counters).toMatchObject({ down: 1, up: 1, queued: 2, pressed: false });
  const shift = page.getByRole("button", { name: "Shift", exact: true });
  await shift.tap();
  await expect(shift).toHaveAttribute("data-shift", "latched");
  await page.keyboard.down("b");
  await expect.poll(counters).toMatchObject({ report: { modifiers: 2, keys: [5] } });
  await page.keyboard.up("b");
  await expect.poll(counters).toMatchObject({ pressed: false });
  await page.getByRole("button", { name: "123", exact: true }).tap();
  await page.getByRole("button", { name: "@", exact: true }).tap();
  await page.getByRole("button", { name: "#+=", exact: true }).tap();
  await page.getByRole("button", { name: "~", exact: true }).tap();
  await expect.poll(counters).toMatchObject({ down: 4, up: 4, pressed: false });
  assert.ok(await page.locator('[data-code="Backspace"] .icon').evaluate(element => getComputedStyle(element).maskImage !== "none"));
  await page.screenshot({ path: fileURLToPath(new URL("../.cache/tests/keyboard-webkit-phone.png", import.meta.url)) });
  await page.setViewportSize({ width: 844, height: 390 });
  const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  assert.ok(layout.width <= 844 && layout.height <= 390);
  await page.getByRole("button", { name: "Return", exact: true }).tap();
  await expect.poll(counters).toMatchObject({ down: 5, up: 5, pressed: false });
  assert.deepEqual(errors, []);
});