import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard row escapes the PR or branch label before innerHTML", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /\$\{escape\(prLabel\(stream\)\)\}/);
  assert.doesNotMatch(source, /<span>\$\{prLabel\(stream\)\}<\/span>/);
});

test("dashboard surfaces pre-open MRR reasons without requiring a pull request", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /if \(!pr\) result\.push\(\.\.\.\(review\?\.reasons/);
  assert.doesNotMatch(source, /if \(pr && review\?\.phase === "blocked"\)/);
});
