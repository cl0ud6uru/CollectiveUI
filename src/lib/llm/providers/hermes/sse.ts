/** Minimal server-sent events reader: yields each event's `data` (and `id` when the server sends one). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let id: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line === "") {
          if (data.length) yield { ...(id !== undefined ? { id } : {}), data: data.join("\n") };
          data = [];
          id = undefined;
        } else if (line.startsWith(":")) {
          // comment (": keepalive", ": stream closed")
        } else {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          else if (field === "id") id = value;
        }
      }
    }
    if (data.length) yield { ...(id !== undefined ? { id } : {}), data: data.join("\n") };
  } finally {
    // Also closes the connection when the consumer stops early.
    await reader.cancel().catch(() => {});
  }
}
