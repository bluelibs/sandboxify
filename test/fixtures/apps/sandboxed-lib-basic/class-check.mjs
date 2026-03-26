import { Counter } from "sandboxed-lib";

const counter = await new Counter(2);
console.log("CLASS_VALUE", counter.value);
console.log("CLASS_INC", await counter.increment(3));
console.log("CLASS_VALUE_AFTER", counter.value);
console.log("CLASS_DESC", await counter.describe());
