import { getHelloMessage } from "example-lib-a";
import { calculate } from "example-lib-b";

function main() {
  console.log(getHelloMessage());
  console.log(calculate(5, 3));
}

main();
