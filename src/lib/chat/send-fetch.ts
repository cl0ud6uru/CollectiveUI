/** Refresh server-derived navigation as soon as a new send returns, before reading its reply stream.
 * Failed sends also re-read storage: admission failures have no message; queue failures can have a saved prompt.
 */
export function chatSendFetch(refresh: () => void, request: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await request(input, init);
    if (init?.method?.toUpperCase() === "POST" && typeof init.body === "string") {
      let send = false;
      try {
        const body = JSON.parse(init.body);
        send = !body.regenerate && body.message?.role === "user";
      } catch { /* A malformed request cannot establish a send. */ }
      if (send) refresh();
    }
    return response;
  };
}
