import { listAvailable, SOURCES } from "../lib/paths.mjs";
import { log } from "../lib/log.mjs";
import chalk from "chalk";

export async function sourcesCommand() {
  log.title("Available sources");
  const avail = listAvailable();
  for (const [id, def] of Object.entries(SOURCES)) {
    const isAvail = avail.find((a) => a.id === id);
    const marker = isAvail ? chalk.green("●") : chalk.gray("○");
    const paths = def.defaultPaths();
    console.log(`  ${marker} ${chalk.bold(id.padEnd(10))} ${def.label}`);
    for (const p of paths) {
      console.log(`     ${chalk.gray(p)}`);
    }
  }
  console.log("");
  log.dim(`Green = detected on this machine. Gray = not found.`);
}
