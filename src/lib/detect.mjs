import net from "node:net";

const COMMON_PORTS = {
  opencode: [34515, 38045, 4096, 34845],
  t3: [3773],
  synara: [3773],
};

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

export async function detectRunning(tool) {
  const ports = COMMON_PORTS[tool];
  if (!ports) return false;
  for (const p of ports) {
    if (await isPortListening(p)) return true;
  }
  return false;
}
