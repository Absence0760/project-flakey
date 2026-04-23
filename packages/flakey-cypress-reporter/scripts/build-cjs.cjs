// Convert the ESM reporter to CJS for Cypress compatibility.
//
// Cypress's top-level `reporter:` field loads the module via CJS `require`,
// so we rewrite the ESM output to CJS. Previous versions hardcoded the list
// of stdlib imports; that's a footgun — adding a new named import in
// reporter.ts silently produces a broken .cjs where the new binding is
// undefined and any call-site swallows into a generic `TypeError` that
// the surrounding try/catch eats. Parse the actual imports instead.
const fs = require("fs");
const code = fs.readFileSync("dist/reporter.js", "utf8");

const requires = [];
// Match: import { a, b as c } from "mod";
const importRe = /^import\s*\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["'];?\s*$/gm;
let match;
while ((match = importRe.exec(code)) !== null) {
  // Preserve `as` renames in the destructuring: `{ foo as bar }` → `{ foo: bar }`.
  const bindings = match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((b) => {
      const asMatch = b.match(/^(\S+)\s+as\s+(\S+)$/);
      return asMatch ? `${asMatch[1]}:${asMatch[2]}` : b;
    })
    .join(",");
  requires.push(`const{${bindings}}=require(${JSON.stringify(match[2])});`);
}

const cjs = requires.join("\n") + "\n" + code.replace(importRe, "");

fs.writeFileSync("dist/reporter.cjs", cjs);
console.log("Built dist/reporter.cjs");
