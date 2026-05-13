// Convert the ESM reporter to CJS for Cypress compatibility.
//
// Cypress's top-level `reporter:` field loads the module via CJS `require`,
// so we rewrite the ESM output to CJS. Previous versions hardcoded the list
// of stdlib imports; that's a footgun — adding a new named import in
// reporter.ts silently produces a broken .cjs where the new binding is
// undefined and any call-site swallows into a generic `TypeError` that
// the surrounding try/catch eats. Parse the actual imports instead.
//
// Handles all ESM import shapes the reporter currently emits, plus a
// few likely-future ones:
//   - `import { a, b as c } from "mod";`
//   - `import {\n  a,\n  b,\n} from "mod";`             (multi-line)
//   - `import foo from "mod";`                          (default)
//   - `import foo, { a, b } from "mod";`                (default + named)
//   - `import * as foo from "mod";`                     (namespace)
const fs = require("fs");
const code = fs.readFileSync("dist/reporter.js", "utf8");

const requires = [];
// `[\s\S]` instead of `.` so the named-import block can span newlines.
// /m so ^ anchors per-line; the trailing $ is loose because TS sometimes
// emits a CRLF or trailing whitespace.
const importRe =
  /^import\s+(?:([\w$]+)\s*(?:,\s*\{\s*([\s\S]*?)\s*\})?|\*\s+as\s+([\w$]+)|\{\s*([\s\S]*?)\s*\})\s+from\s*["']([^"']+)["'];?\s*$/gm;

let match;
while ((match = importRe.exec(code)) !== null) {
  const [, defaultName, defaultPlusNamed, namespaceName, namedOnly, modulePath] = match;
  const lines = [];
  if (namespaceName) {
    lines.push(`const ${namespaceName} = require(${JSON.stringify(modulePath)});`);
  } else if (defaultName && !defaultPlusNamed) {
    // `import foo from "mod"` — interop with CJS modules whose default
    // export is the module.exports value (Node's default-export rule).
    lines.push(`const ${defaultName} = require(${JSON.stringify(modulePath)}).default ?? require(${JSON.stringify(modulePath)});`);
  } else {
    const namedSrc = defaultPlusNamed ?? namedOnly ?? "";
    const bindings = namedSrc
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((b) => {
        const asMatch = b.match(/^(\S+)\s+as\s+(\S+)$/);
        return asMatch ? `${asMatch[1]}:${asMatch[2]}` : b;
      })
      .join(",");
    if (defaultName) {
      lines.push(`const ${defaultName} = require(${JSON.stringify(modulePath)}).default ?? require(${JSON.stringify(modulePath)});`);
    }
    if (bindings) {
      lines.push(`const{${bindings}}=require(${JSON.stringify(modulePath)});`);
    }
  }
  requires.push(lines.join("\n"));
}

const cjs = requires.join("\n") + "\n" + code.replace(importRe, "");

fs.writeFileSync("dist/reporter.cjs", cjs);
console.log("Built dist/reporter.cjs");
