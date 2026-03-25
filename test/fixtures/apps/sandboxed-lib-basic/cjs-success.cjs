const sandboxed = require("sandboxed-lib");

(async () => {
  const add = sandboxed.add || (sandboxed.default && sandboxed.default.add);
  if (typeof add !== "function") {
    throw new Error("add export not available through CJS proxy");
  }

  const value = await add(2, 3);
  console.log("CJS_RESULT", value);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
