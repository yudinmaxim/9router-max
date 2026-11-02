import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath, extname } from "node:path";
import { existsSync, statSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));

function resolveProjectPath(file) {
  if (extname(file)) return file;
  if (existsSync(file) && statSync(file).isDirectory() && existsSync(`${file}/index.js`)) return `${file}/index.js`;
  if (existsSync(file)) return file;
  return existsSync(`${file}.js`) ? `${file}.js` : file;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const file = resolveProjectPath(resolvePath(root, "src", specifier.slice(2)));
    return nextResolve(pathToFileURL(file).href, context);
  }
  if (specifier === "open-sse" || specifier.startsWith("open-sse/")) {
    const file = resolveProjectPath(resolvePath(root, specifier));
    return nextResolve(pathToFileURL(file).href, context);
  }
  return nextResolve(specifier, context);
}
