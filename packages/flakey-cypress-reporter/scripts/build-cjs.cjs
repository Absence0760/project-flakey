// Convert the ESM reporter to CJS for Cypress compatibility
const fs = require("fs");
const code = fs.readFileSync("dist/reporter.js", "utf8");

// Add require statements for Node built-ins
const requires = [
  'const{readFileSync,writeFileSync,mkdirSync,readdirSync,statSync,existsSync}=require("fs");',
  'const{join,basename}=require("path");',
  'const{tmpdir}=require("os");',
  'const{execSync}=require("child_process");',
].join("\n") + "\n";

// Strip ESM imports and convert export
const cjs = requires + code.replace(/^import .+ from .+;$/gm, "");

fs.writeFileSync("dist/reporter.cjs", cjs);
console.log("Built dist/reporter.cjs");
