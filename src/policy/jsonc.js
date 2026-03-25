export function parseJsonc(input) {
  const withoutComments = stripComments(input);
  const withoutTrailingCommas = withoutComments.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

function stripComments(input) {
  let output = "";
  let index = 0;
  let inString = false;
  let stringQuote = "";

  while (index < input.length) {
    const char = input[index];
    const next = input[index + 1];

    if (inString) {
      output += char;
      if (char === "\\\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (char === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      output += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < input.length &&
        !(input[index] === "*" && input[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}
