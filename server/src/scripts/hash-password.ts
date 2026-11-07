// Prints an argon2 hash for OWNER_PASSWORD_HASH. Reads the password from stdin
// so it never appears in shell history or process lists.
import { hash } from "@node-rs/argon2";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
process.stderr.write("Owner password: ");
rl.once("line", async (line) => {
  rl.close();
  const pw = line.trim();
  if (pw.length < 12) {
    process.stderr.write("\nUse at least 12 characters.\n");
    process.exit(1);
  }
  process.stdout.write(`${await hash(pw)}\n`);
});
