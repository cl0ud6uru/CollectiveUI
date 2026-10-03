import { tool } from "ai";
import { z } from "zod";
import { graphFetch } from "@/lib/auth/entra";
import type { AgentCtx, ToolEntry } from "../types";

type GraphList<T> = { value: T[] };

/** Microsoft 365 connector using the signed-in user's delegated Entra token (acts as the user). */
export function m365Tools(ctx: AgentCtx): ToolEntry[] {
  const uid = ctx.principal.user.id;
  return [
    {
      name: "m365_search_mail",
      key: "m365",
      tool: tool({
        description: "Search the user's Outlook mailbox. Returns subject, sender, date and a preview.",
        inputSchema: z.object({ query: z.string(), top: z.number().int().min(1).max(25).optional() }),
        execute: async ({ query, top }) => {
          const r = await graphFetch<GraphList<{ id: string; subject: string; from?: { emailAddress: { name: string; address: string } }; receivedDateTime: string; bodyPreview: string; webLink: string }>>(
            uid,
            `/me/messages?$search="${encodeURIComponent(query.replace(/"/g, ""))}"&$top=${top ?? 10}&$select=subject,from,receivedDateTime,bodyPreview,webLink`,
          );
          return {
            messages: r.value.map((m) => ({
              subject: m.subject,
              from: m.from?.emailAddress.name,
              received: m.receivedDateTime,
              preview: m.bodyPreview,
              link: m.webLink,
            })),
          };
        },
      }),
    },
    {
      name: "m365_calendar",
      key: "m365",
      tool: tool({
        description: "List the user's calendar events between two ISO date-times.",
        inputSchema: z.object({ start: z.string(), end: z.string() }),
        execute: async ({ start, end }) => {
          const r = await graphFetch<GraphList<{ subject: string; start: { dateTime: string }; end: { dateTime: string }; location?: { displayName: string }; organizer?: { emailAddress: { name: string } }; webLink: string }>>(
            uid,
            `/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=50&$select=subject,start,end,location,organizer,webLink&$orderby=start/dateTime`,
          );
          return {
            events: r.value.map((e) => ({
              subject: e.subject,
              start: e.start.dateTime,
              end: e.end.dateTime,
              location: e.location?.displayName,
              organizer: e.organizer?.emailAddress.name,
              link: e.webLink,
            })),
          };
        },
      }),
    },
    {
      name: "m365_search_files",
      key: "m365",
      tool: tool({
        description: "Search SharePoint and OneDrive files the user can access.",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          const r = await graphFetch<{ value: { hitsContainers: { hits?: { summary: string; resource: { name?: string; webUrl?: string; lastModifiedDateTime?: string } }[] }[] }[] }>(
            uid,
            "/search/query",
            {
              method: "POST",
              body: JSON.stringify({ requests: [{ entityTypes: ["driveItem", "listItem"], query: { queryString: query }, size: 10 }] }),
            },
          );
          const hits = r.value.flatMap((v) => v.hitsContainers.flatMap((c) => c.hits ?? []));
          return {
            files: hits.map((h) => ({ name: h.resource.name, url: h.resource.webUrl, modified: h.resource.lastModifiedDateTime, summary: h.summary })),
          };
        },
      }),
    },
    {
      name: "m365_send_mail",
      key: "m365",
      sensitive: true,
      tool: tool({
        description: "Send an email as the user. Always requires the user's approval.",
        inputSchema: z.object({
          to: z.array(z.string().email()).min(1),
          subject: z.string(),
          body: z.string().describe("Plain text body"),
        }),
        execute: async ({ to, subject, body }) => {
          await graphFetch(uid, "/me/sendMail", {
            method: "POST",
            body: JSON.stringify({
              message: {
                subject,
                body: { contentType: "Text", content: body },
                toRecipients: to.map((address) => ({ emailAddress: { address } })),
              },
            }),
          }).catch((e: Error) => {
            // sendMail returns 202 with an empty body, which graphFetch can't parse as JSON.
            if (!/JSON/.test(e.message)) throw e;
          });
          return { sent: true, to };
        },
      }),
    },
  ];
}
