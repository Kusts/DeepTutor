import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const WEB = process.cwd();
const tokens = fs.readFileSync(
  path.join(WEB, "features/classroom/classroom-tokens.css"),
  "utf8",
);
const globals = fs.readFileSync(path.join(WEB, "app/globals.css"), "utf8");

const aliases = [...tokens.matchAll(/--sala-[a-z-]+\s*:\s*var\((--[a-z-]+)\)/g)].map(
  (match) => ({ alias: match[0].split(":")[0].trim(), host: match[1] }),
);

test("every --sala alias resolves to a host semantic token, never a literal", () => {
  assert.ok(aliases.length >= 10, `expected the alias layer, found ${aliases.length}`);
  for (const { alias, host } of aliases) {
    assert.match(alias, /^--sala-/);
    assert.match(globals, new RegExp(`${host}\\s*:`), `${alias} points at undefined ${host}`);
  }
  assert.doesNotMatch(tokens, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
});

test("the aliases inherit all four shipped themes", () => {
  const themed = aliases.filter(({ host }) => host !== "--motion-fast");
  for (const selector of [":root", ".dark", ".theme-snow", ".theme-glass"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = globals.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
    assert.ok(block, `missing theme block ${selector}`);
    for (const { alias, host } of themed) {
      assert.match(block, new RegExp(`${host}\\s*:`), `${selector} is missing ${host} for ${alias}`);
    }
  }
  assert.match(globals, /html\s*\{[^}]*--motion-fast\s*:/);
});

test("the connecting animation is disabled by reduced-motion", () => {
  assert.match(tokens, /prefers-reduced-motion:\s*reduce/);
  // The stylesheet has two reduced-motion blocks (voice meter and avatar).
  // Inspect every block - a single non-greedy match would stop at the first
  // block and never see the animation override.
  const reducedBlocks = [
    ...tokens.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}/g),
  ].map((match) => match[1]);
  assert.ok(
    reducedBlocks.length >= 2,
    `expected both reduced-motion blocks, found ${reducedBlocks.length}`,
  );
  assert.ok(
    reducedBlocks.some((block) => /animation:\s*none/.test(block)),
    "no reduced-motion block disables the connecting animation",
  );
});
