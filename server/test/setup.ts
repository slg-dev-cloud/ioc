import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (!process.env.CI && existsSync(envFile)) process.loadEnvFile(envFile);
