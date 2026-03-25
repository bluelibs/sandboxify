import { tryNet } from "sandboxed-lib";

const port = Number(process.env.TEST_PORT);

try {
  const out = await tryNet(port);
  console.log("IMPORTER_OPEN_NET_OK", out);
} catch (error) {
  console.log("IMPORTER_OPEN_NET_ERR", error.code || error.name);
}
