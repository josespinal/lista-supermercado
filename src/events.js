// Server-sent events: every open phone gets a nudge when the list or the
// spending changes, and refetches. Nothing else travels over this channel.
export function createEventHub({ pingMs = 25_000 } = {}) {
  const clients = new Set();

  return {
    subscribe(req, res) {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // nginx (Ploi, Forge…) buffers responses by default, which would hold events back.
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      res.write("retry: 3000\n\n");
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), pingMs);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
    },

    // event: { topic: "items" | "purchases", by: user name, text?: what happened }
    broadcast(event) {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of clients) res.write(frame);
    },

    close() {
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
