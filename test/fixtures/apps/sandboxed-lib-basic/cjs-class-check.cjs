const { Counter } = require("sandboxed-lib");

(async () => {
  const counter = await new Counter(4);
  console.log("CJS_CLASS_VALUE", counter.value);
  console.log("CJS_CLASS_INC", await counter.increment(2));
  console.log("CJS_CLASS_VALUE_AFTER", counter.value);
  console.log("CJS_CLASS_DESC", await counter.describe());
})();
