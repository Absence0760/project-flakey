import type { NormalizedRun } from "../types.js";
import { parseMochawesome } from "./mochawesome.js";
import { parseJUnit } from "./junit.js";
import { parsePlaywright } from "./playwright.js";
import { parseJest } from "./jest.js";
import { parseWebdriverIO } from "./webdriverio.js";

type Parser = (raw: unknown, meta: NormalizedRun["meta"]) => NormalizedRun;

const parsers: Record<string, Parser> = {
  mochawesome: parseMochawesome as Parser,
  junit: parseJUnit as Parser,
  playwright: parsePlaywright as Parser,
  jest: parseJest as Parser,
  webdriverio: parseWebdriverIO as Parser,
};

export function normalize(
  reporter: string,
  raw: unknown,
  meta: NormalizedRun["meta"]
): NormalizedRun {
  // hasOwn guard: a plain `parsers[reporter]` lookup would also pick up
  // inherited Object.prototype members (toString, hasOwnProperty, etc.)
  // and dispatch to them. CodeQL js/unvalidated-dynamic-method-call
  // flagged the broader pattern; the own-property check tightens it.
  if (!Object.hasOwn(parsers, reporter)) {
    throw new Error(`Unsupported reporter: ${reporter}. Supported: ${Object.keys(parsers).join(", ")}`);
  }
  return parsers[reporter](raw, meta);
}
