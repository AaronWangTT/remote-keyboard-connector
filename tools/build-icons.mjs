import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../components/web_server/www/icons/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const [name, source] of Object.entries({ shift: "arrow-big-up", backspace: "delete",
  return: "corner-down-left", caps: "arrow-big-up-dash", release: "square" })) {
  await copyFile(new URL(`./node_modules/lucide-static/icons/${source}.svg`, import.meta.url),
                 new URL(`${name}.svg`, destination));
}
await copyFile(new URL("./node_modules/lucide-static/LICENSE", import.meta.url), new URL("LICENSE", destination));
console.log("Copied five pinned Lucide icons and their license");