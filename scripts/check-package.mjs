import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "modern-fetch-stream-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command, args, cwd = temporary) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  // Run prepack too: verify the artifact users install, including its exports.
  run(npm, ["pack", "--pack-destination", temporary], root);
  const tarball = readdirSync(temporary).find((file) => file.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not produce a tarball");
  writeFileSync(join(temporary, "package.json"), JSON.stringify({ private: true }));
  run(npm, ["install", join(temporary, tarball), "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"]);

  for (const format of ["esm", "cjs"]) {
    const imports = format === "esm"
      ? 'import { fetchEventSource } from "modern-fetch-stream";'
      : 'const { fetchEventSource } = require("modern-fetch-stream");';
    const filename = join(temporary, `smoke.${format === "esm" ? "mjs" : "cjs"}`);
    writeFileSync(filename, `${imports}
      async function main() {
        const messages = [];
        await fetchEventSource("http://test", {
          fetch: async () => new Response("data: ok\\n\\n", {
            headers: { "content-type": "text/event-stream" },
          }),
          onMessage(event) { messages.push(event.data); },
        });
        if (messages.join() !== "ok") throw new Error("Packaged SSE client failed");
      }
      main().catch(error => { console.error(error); process.exitCode = 1; });
    `);
    run(process.execPath, [filename]);
  }

  const fixture = `
    import { fetchEventSource, type FetchEventSourceInit } from "modern-fetch-stream";
    const options: FetchEventSourceInit = { headers: new Headers(), signal: null };
    const tuples: FetchEventSourceInit = { headers: [["accept", "text/event-stream"]] };
    const result: Promise<void> = fetchEventSource("http://test", options);
  `;
  for (const extension of ["mts", "cts"]) {
    writeFileSync(join(temporary, `types.${extension}`), fixture);
  }
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--module", "Node16", "--target", "ES2022", "--lib", "ES2022,DOM",
    "types.mts", "types.cts",
  ]);
  console.log("Packed ESM/CJS runtime and TypeScript consumers passed.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
