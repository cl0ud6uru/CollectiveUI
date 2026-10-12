import { HttpError } from "@/lib/authz";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { agentBrowserStatus } from "@/lib/agent-browser/viewer";
import { browserViewForConversation } from "@/lib/agent-browser/session-source";
import type { AgentBrowserStatus } from "@/lib/agent-browser/contracts";

const json = (value: AgentBrowserStatus) => Response.json(value, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
const disconnected: AgentBrowserStatus = { state: "disconnected", viewOnly: true, lastFrameAt: null };

/** Returns state for the signed-in owner's conversation; it never starts a run or browser. */
export async function GET(req: Request) {
  try {
    const principal = await requirePrincipal();
    const query = new URL(req.url).searchParams;
    if ([...query.keys()].some(key => key !== "conversationId") || query.getAll("conversationId").length !== 1)
      throw new HttpError(400, "Invalid browser-view request");
    const conversationId = query.get("conversationId")!;
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(conversationId)) throw new HttpError(400, "Invalid browser-view request");
    const view = await browserViewForConversation(principal, conversationId, req.signal);
    if (!view) return json(disconnected);
    await view.authorize();
    return json(await agentBrowserStatus(view.source, req.signal));
  } catch (err) { return errorResponse(err); }
}
