import chalk from "chalk";

const isTTY = process.stdout.isTTY;
const c = (fn) => (isTTY ? fn : (s) => s);

export const log = {
  info: (msg) => console.log(c(chalk.blue)("ℹ"), msg),
  ok: (msg) => console.log(c(chalk.green)("✔"), msg),
  warn: (msg) => console.log(c(chalk.yellow)("!"), msg),
  err: (msg) => console.log(c(chalk.red)("✘"), msg),
  step: (msg) => console.log(c(chalk.magenta)("→"), msg),
  dim: (msg) => console.log(c(chalk.gray)(msg)),
  title: (msg) => console.log("\n" + c(chalk.bold)(msg) + "\n"),
  kv: (k, v) => console.log(`  ${c(chalk.gray)(k.padEnd(16))} ${v}`),
};

export function fatal(msg, code = 1) {
  log.err(msg);
  process.exit(code);
}
