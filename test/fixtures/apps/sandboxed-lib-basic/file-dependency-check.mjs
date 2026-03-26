import { multiply, tryChild } from "./local-libs/file-sandboxed-lib.mjs";

console.log("FILE_DEP_RESULT", await multiply(3, 4));

try {
  console.log("FILE_DEP_CHILD", await tryChild());
} catch (error) {
  console.log("FILE_DEP_CHILD_ERR", error?.code ?? error?.name ?? "unknown");
}
