export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { stampPeerIp } = await import("./instrumentation-node");
  stampPeerIp();
}
