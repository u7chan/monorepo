import { getHelloMessage } from "demo-greeting-lib";
import { calculate } from "demo-math-lib";

function main() {
  console.log(getHelloMessage());
  console.log(calculate(5, 3));
}

main();
