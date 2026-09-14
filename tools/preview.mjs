import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";

const usbReady = process.env.PREVIEW_USB_READY !== "0";
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 });
let capsLock = process.env.PREVIEW_CAPS_LOCK === "unknown" ? null : process.env.PREVIEW_CAPS_LOCK === "1";
let controller = null;
const receipts = { down: 0, up: 0, stop: 0, queued: 0, forced_release: 0 };

function inputSnapshot() {
  return {
    ...receipts,
    connected: controller?.readyState === WebSocket.OPEN,
    pressed: controller?.pressed ?? false,
    report: controller?.report ?? { modifiers: 0, keys: [] },
    caps_lock: capsLock,
  };
}

function usbStatus() {
  return { v: 1, type: "status", usb_ready: usbReady, caps_lock: capsLock };
}

function validReport(message) {
  return Number.isInteger(message.seq) && message.seq > 0 && message.seq <= 2147483647 &&
    Number.isInteger(message.modifiers) && message.modifiers >= 0 && message.modifiers <= 255 &&
    (message.modifiers & ~0x22) === 0 && Array.isArray(message.keys) && message.keys.length <= 6 &&
    new Set(message.keys).size === message.keys.length && message.keys.every(usage =>
      Number.isInteger(usage) && ((usage >= 4 && usage <= 40) || usage === 42 ||
        (usage >= 44 && usage <= 57 && usage !== 50)));
}

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/keyboard.mjs", ["keyboard.mjs", "text/javascript; charset=utf-8"]],
  ...["shift", "caps", "backspace", "return", "release"].map(icon =>
    [`/icons/${icon}.svg`, [`icons/${icon}.svg`, "image/svg+xml"]]),
]);

const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  if (request.url === "/api/v1/status") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(usbStatus()));
    return;
  }
  if (request.url === "/__test__/input") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(inputSnapshot()));
    return;
  }
  const asset = assets.get(request.url);
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  try {
    const contents = await readFile(new URL(`../components/web_server/www/${asset[0]}`, import.meta.url));
    response.setHeader("Content-Type", asset[1]);
    response.end(contents);
  } catch {
    response.writeHead(500).end();
  }
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/api/v1/keyboard") {
    socket.destroy();
    return;
  }
  if (controller !== null && controller.readyState === WebSocket.OPEN) {
    if (performance.now() - controller.lastSeen < 1000) {
      socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
      return;
    }
    controller.terminate();
  }
  websocketServer.handleUpgrade(request, socket, head, (connection) => {
    controller = connection;
    connection.pressed = false;
    connection.report = { modifiers: 0, keys: [] };
    connection.sequence = 0;
    connection.lastSeen = performance.now();
    connection.on("error", () => connection.terminate());
    connection.on("close", () => {
      if (connection.pressed) receipts.forced_release++;
      connection.pressed = false;
      connection.report = { modifiers: 0, keys: [] };
      if (controller === connection) controller = null;
    });
    connection.on("message", (data, binary) => {
      if (connection !== controller || binary || performance.now() - connection.lastSeen >= 1000) {
        connection.close(1008);
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        connection.close(1008);
        return;
      }
      const fields = message?.type === "state" ? ["v", "type", "seq", "modifiers", "keys"] : ["v", "type"];
      if (message?.v !== 1 || Object.keys(message).length !== fields.length ||
          !Object.keys(message).every(field => fields.includes(field))) {
        connection.close(1008);
        return;
      }
      connection.lastSeen = performance.now();
      if (message.type === "ping") connection.send(JSON.stringify(usbStatus()));
      else if (message.type === "state" && usbReady && validReport(message) && message.seq === connection.sequence + 1) {
        receipts.down += message.keys.filter(usage => !connection.report.keys.includes(usage)).length;
        receipts.up += connection.report.keys.filter(usage => !message.keys.includes(usage)).length;
        if (message.keys.includes(57) && !connection.report.keys.includes(57) && capsLock !== null) capsLock = !capsLock;
        connection.report = { modifiers: message.modifiers, keys: [...message.keys].sort((left, right) => left - right) };
        connection.sequence = message.seq;
        connection.pressed = message.keys.length > 0 || message.modifiers !== 0;
        connection.send(JSON.stringify({ v: 1, type: "queued", seq: message.seq }), (error) => {
          if (!error) receipts.queued++;
        });
      }
      else if (message.type === "stop") {
        receipts.stop++;
        connection.pressed = false;
        connection.report = { modifiers: 0, keys: [] };
        connection.close(1000);
      }
      else connection.close(1008);
    });
  });
});

setInterval(() => {
  if (controller !== null && performance.now() - controller.lastSeen >= 1000) controller.terminate();
}, 250).unref();

const port = Number(process.env.PORT || 8080);
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`UI preview: ${url}/ (USB mocked, no keystrokes leave this server)`);
  console.log(`Receipt counters: ${url}/__test__/input`);
  process.send?.({ type: "listening", url });
});

function shutdown() {
  console.log("Preview receipts:", JSON.stringify(inputSnapshot()));
  for (const connection of websocketServer.clients) connection.terminate();
  websocketServer.close();
  server.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);