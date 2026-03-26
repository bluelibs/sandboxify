import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonc } from "../src/policy/jsonc.js";

test("parseJsonc strips comments and trailing commas while preserving strings", () => {
  const input = String.raw`
    {
      // line comment
      "url": "https://example.com//still-a-string",
      "block": "/* not a comment */",
      "escaped": "quote: \" and slash: \\",
      /* block comment */
      "nested": {
        "value": 1,
      },
      "list": [1, 2, 3,],
    }
  `;

  const parsed = parseJsonc(input);
  assert.equal(parsed.url, "https://example.com//still-a-string");
  assert.equal(parsed.block, "/* not a comment */");
  assert.equal(parsed.escaped, 'quote: " and slash: \\');
  assert.deepEqual(parsed.nested, { value: 1 });
  assert.deepEqual(parsed.list, [1, 2, 3]);
});

test("parseJsonc does not reinterpret single-quoted input as valid JSON", () => {
  assert.throws(
    () =>
      parseJsonc(`
        {
          'text': 'this // stays in the string'
        }
      `),
    /JSON/,
  );
});
