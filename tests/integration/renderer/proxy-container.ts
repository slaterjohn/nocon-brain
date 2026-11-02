// Entry point bundled into the proxy container of the docker test (docker.test.ts). It is the server's forward proxy and
// nothing else: the same GuardedProxy and the same SSRF guard, with a private-host allowlist taken from the environment
// (the fixture site on the Docker host). Events are written as JSON lines so the test can read them from `docker logs`.
import { createSsrfGuard } from "../../../packages/fetch/src";
import { GuardedProxy } from "../../../apps/server/src/renderer/proxy";

const proxy = new GuardedProxy({
  guard: createSsrfGuard({ allow: process.env.ALLOW ?? "" }),
  token: process.env.TOKEN,
  host: "0.0.0.0",
  port: 3128,
  onEvent: (e) => console.log(JSON.stringify(e)),
});
await proxy.listen();
console.log(JSON.stringify({ type: "listening" }));
setInterval(() => console.log(JSON.stringify({ type: "stats", ...proxy.stats })), 2000).unref();
