// Bundles our existing web avatar and voice protocol into an offline, credential-free iOS resource.
import { build } from "esbuild";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "ios/CollectiveUI/Voice/Resources/voice-engine.html");
const result = await build({ entryPoints: [path.join(root, "ios/VoiceEngine/index.tsx")], bundle: true,
  write: false, outdir: "voice-engine-bundle", minify: true, format: "iife", target: "safari17", jsx: "automatic", legalComments: "inline",
  define: { "process.env.NODE_ENV": '"production"' }, tsconfig: path.join(root, "tsconfig.json") });
const js = result.outputFiles.find(file => file.path.endsWith(".js")).text;
const css = result.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src blob: data:; media-src blob:; worker-src blob:"><style>html,body,#root{width:100%;height:100%;margin:0;background:transparent;overflow:hidden;color:#cbd5e1;font:13px system-ui}.relative{position:relative}.h-full{height:100%}.w-full{width:100%}.absolute{position:absolute}.inset-x-4{left:16px;right:16px}.bottom-2{bottom:8px}.text-center{text-align:center}canvas{display:block}${css}</style></head><body><div id="root"></div><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`;
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8") !== html) throw new Error("Run node ios/scripts/build-voice-engine.mjs to refresh the bundled voice engine.");
} else await writeFile(output, html);
console.log("iOS voice engine " + (process.argv.includes("--check") ? "verified" : "bundled"));
