import http from "node:http";

// SSE chat streaming organ: forwards live orchestrator deltas to browsers as
// text/event-stream frames. Pure/injectable so tests exercise it without a
// network or the running fleet host. SECURITY: request headers are never
// read, logged, or echoed - authorization material cannot leak through here.

export function sseFormat(event, data) {
  return `event: ${String(event)}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

const clients = new Set();

export function broadcastEvent(type, payload) {
  let frame;
  try { frame = sseFormat(type, payload); } catch { return 0; }
  let delivered = 0;
  for (const res of [...clients]) {
    try { res.write(frame); delivered++; }
    catch { clients.delete(res); }
  }
  return delivered;
}

export function clientCount() { return clients.size; }

// Line-ending-agnostic path match on req.url (CRLF gotcha defense).
function routeOf(url) {
  return String(url || "").split("?")[0].replace(/\r/g, "");
}

export function createStreamHandler() {
  return function handleChatStream(req, res) {
    if (routeOf(req.url) !== "/api/chat/stream") {
      res.statusCode = 404; res.end(); return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => { clients.delete(res); });
    req.on("error", () => { clients.delete(res); });
  };
}

// Pump an async iterable of upstream deltas into an SSE response as
// incremental `delta` frames, terminating with a `done` frame.
export async function pumpDeltasToResponse(res, iterator) {
  try {
    for await (const d of iterator) {
      const text = typeof d === "string" ? d : (d && typeof d.text === "string" ? d.text : "");
      if (!text) continue;
      res.write(sseFormat("delta", { text }));
    }
  } catch (error) {
    try { res.write(sseFormat("error", { reason: String(error?.message || error).slice(0, 300) })); } catch {}
  } finally {
    try { res.write(sseFormat("done", {})); res.end(); } catch {}
  }
}

export function startChatStreamServer({ port } = {}) {
  const p = Number(port ?? process.env.ATLAS_SSE_PORT ?? 0);
  if (!p) return null;
  const server = http.createServer(createStreamHandler());
  try { server.listen(p, "127.0.0.1"); } catch { return null; }
  return server;
}