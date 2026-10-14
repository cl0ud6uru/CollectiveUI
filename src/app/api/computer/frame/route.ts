import { errorResponse, requirePrincipal } from "@/lib/session";
import { computerViewForConversation } from "@/lib/computer/access";
import { computerFrameForView } from "@/lib/computer/viewer";
import { queryConversationId } from "@/lib/computer/http";

export async function GET(request: Request) {
  try {
    const principal = await requirePrincipal();
    const view = await computerViewForConversation(principal, queryConversationId(request));
    const frame = await computerFrameForView(view, request.signal);
    await view.authorize();
    const body = frame.bytes.buffer.slice(frame.bytes.byteOffset, frame.bytes.byteOffset + frame.bytes.byteLength) as ArrayBuffer;
    return new Response(body, { headers: {
      "Content-Type": "image/jpeg", "Content-Length": String(frame.bytes.byteLength),
      "x-computer-captured-at": frame.capturedAt, "x-computer-sequence": String(frame.sequence),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie",
    } });
  } catch (error) { return errorResponse(error); }
}
