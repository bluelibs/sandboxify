import { bufferSize } from "sandboxed-lib";

const values = await bufferSize.batch([
  [Buffer.from("a")],
  [Buffer.from("hello")],
  [Buffer.from("sandbox")],
]);

console.log("BATCH_BUFFER_RESULT", values.join(","));
