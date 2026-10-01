import { createSecretMasker } from "./src/redact";
import { toolArgsSummary } from "./src/session-projection";
console.log(toolArgsSummary({ command: process.argv[2] }, createSecretMasker([]), process.argv[3]).slice(2));
