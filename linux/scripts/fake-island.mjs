// Fake Coucou island: same socket protocol as pipe.rs. Logs every event line,
// answers PermissionRequest with "allow" like a human clicking Allow.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const sock = path.join(dir, "run", "coucou.sock");
const log = path.join(dir, "hook.log");
try { fs.unlinkSync(sock); } catch {}
const server = net.createServer((conn) => {
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    const line = buf.slice(0, nl);
    try {
      const payload = JSON.parse(line);
      fs.appendFileSync(log, `${payload.hook_event_name} agent=${payload.agent} tool=${payload.tool_name ?? "-"} session=${payload.session_id ?? "-"}\n`);
      if (payload.hook_event_name === "PermissionRequest") {
        setTimeout(() => conn.write("allow\n"), 120); // like a human click
      }
    } catch (e) {
      fs.appendFileSync(log, `UNPARSEABLE: ${line.slice(0, 200)}\n`);
    }
    buf = "";
  });
});
server.listen(sock, () => fs.appendFileSync(log, "FAKE_ISLAND_UP\n"));
setTimeout(() => { fs.appendFileSync(log, "FAKE_ISLAND_EXIT\n"); process.exit(0); }, 180_000);
