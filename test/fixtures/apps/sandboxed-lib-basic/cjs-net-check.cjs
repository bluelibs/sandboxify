const sandboxed = require("sandboxed-lib");

(async () => {
  const tryNet =
    sandboxed.tryNet || (sandboxed.default && sandboxed.default.tryNet);
  const port = Number(process.env.TEST_PORT);

  try {
    const out = await tryNet(port);
    console.log("CJS_NET_OK", out);
  } catch (error) {
    console.log("CJS_NET_ERR", error.code || error.name);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
