import type { NormalizedRun } from "../types.js";
import { parseMochawesome } from "./mochawesome.js";
import { parseJUnit } from "./junit.js";
import { parsePlaywright } from "./playwright.js";

type Parser = (raw: unknown, meta: NormalizedRun["meta"]) => NormalizedRun;

const parsers: Record<string, Parser> = {
  mochawesome: parseMochawesome as Parser,
  junit: parseJUnit as Parser,
  playwright: parsePlaywright as Parser,
};

export function normalize(
  reporter: string,
  raw: unknown,
  meta: NormalizedRun["meta"]
): NormalizedRun {
  const parser = parsers[reporter];
  if (!parser) {
    throw new Error(`Unsupported reporter: ${reporter}. Supported: ${Object.keys(parsers).join(", ")}`);
  }
  return parser(raw, meta);
}
