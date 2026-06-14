import fs from "node:fs/promises";
import path from "node:path";

export async function writeJson(session, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(session, null, 2));
  return target;
}
