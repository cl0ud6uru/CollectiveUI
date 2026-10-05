#if DEBUG
import Foundation

/// Fictional demo content. Times use tokens that `DemoServer` expands at launch:
/// `"@today:N"` is N seconds ago (but never before today) and `"@dayago:D"` is noon D days ago.
enum DemoFixtures {
    static let user = ##"""
    {"id":"user-demo","name":"Jordan Lee","email":"jordan@example.com","isAdmin":true,"canCreateBots":true}
    """##

    static let branding = ##"""
    {"appName":"CollectiveUI","welcomeText":"Welcome back, Jordan.","logoEmoji":"✨","logoUrl":null}
    """##

    static let apps = ##"""
    [
      {"kind":"app","id":"app-fast","name":"Fast model","icon":null,"description":"Quick answers for everyday questions.","supportsVision":true,"starters":[]},
      {"kind":"app","id":"app-reasoning","name":"Reasoning model","icon":null,"description":"Thinks step by step on harder problems.","supportsVision":true,"starters":[]}
    ]
    """##

    static let bots = ##"""
    [
      {"kind":"bot","id":"bot-atlas","name":"Atlas","icon":"blob:hexagon:purple","description":"Your starting point. Routes questions to the right specialist.","coordinator":true,"pinned":true,"preview":"Morning! Two things need your attention today.","lastAt":"@today:600","status":null,"starters":["What needs my attention today?","Summarise this week's updates","Who can help with a security review?"]},
      {"kind":"bot","id":"bot-research","name":"Research Assistant","icon":"blob:circle:blue","description":"Finds sources, compares options and writes short briefs.","preview":"Comparing pgvector, Qdrant and Weaviate…","lastAt":"@today:60","status":"working","starters":["Compare two tools for me","Summarise a long article"]},
      {"kind":"bot","id":"bot-helpdesk","name":"IT Helpdesk","icon":"blob:ghost:teal","description":"Troubleshoots devices and opens tickets with your approval.","preview":"Waiting for your approval to open a ticket","lastAt":"@today:300","status":"waiting","starters":["My laptop is slow","Reset my VPN profile"]},
      {"kind":"bot","id":"bot-analyst","name":"Data Analyst","icon":"blob:egg:orange","description":"Charts CSV exports and explains what changed.","preview":"Sign-ups grew 18% compared with Q2.","lastAt":"@today:7200","status":null,"starters":["Chart this CSV","What changed this week?"]},
      {"kind":"bot","id":"bot-release","name":"Release Notes Writer","icon":"blob:drop:pink","description":"Turns merged changes into clear release notes.","preview":"The v2.4 draft is ready for review.","lastAt":"@dayago:1","status":null,"starters":["Draft notes for the next release"]},
      {"kind":"bot","id":"bot-travel","name":"Travel Planner","icon":"🧭","description":"Plans team trips within travel policy.","preview":"Found three hotels near the venue.","lastAt":"@dayago:1","status":null,"starters":["Plan a two-day offsite"]}
    ]
    """##

    static let conversations = ##"""
    [
      {"id":"demo-approval","title":"Laptop won't connect to VPN","pinned":false,"folderId":null,"botId":"bot-helpdesk","appId":null,"source":"chat","isGroup":false,"isBotHome":false,"archived":false,"updatedAt":"@today:300"},
      {"id":"demo-research","title":"Comparing vector databases","pinned":true,"folderId":null,"botId":"bot-research","appId":null,"source":"chat","isGroup":false,"isBotHome":false,"archived":false,"updatedAt":"@today:1500"},
      {"id":"demo-image","title":"Q3 sign-up trends","pinned":false,"folderId":null,"botId":"bot-analyst","appId":null,"source":"chat","isGroup":false,"isBotHome":false,"archived":false,"updatedAt":"@today:7200"},
      {"id":"demo-routine","title":"Weekly metrics digest","pinned":false,"folderId":null,"botId":"bot-analyst","appId":null,"source":"routine","isGroup":false,"isBotHome":false,"archived":false,"updatedAt":"@today:10800","taskActivity":{"status":"done","unread":true}},
      {"id":"demo-release","title":"Release notes for v2.4","pinned":false,"folderId":null,"botId":"bot-release","appId":null,"source":"chat","isGroup":false,"isBotHome":false,"archived":false,"updatedAt":"@dayago:1"},
      {"id":"demo-trip","title":"Lisbon offsite itinerary","pinned":false,"folderId":null,"botId":"bot-travel","appId":null,"source":"chat","isGroup":false,"isBotHome":false,"archived":false,"updatedAt":"@dayago:1"},
      {"id":"demo-regex","title":"Regex for invoice numbers","pinned":false,"folderId":null,"botId":null,"appId":"app-fast","source":"chat","isGroup":false,"isBotHome":false,"archived":false,"updatedAt":"@dayago:3"},
      {"id":"demo-sql","title":"Speeding up a slow SQL query","pinned":false,"folderId":null,"botId":null,"appId":"app-reasoning","source":"chat","isGroup":false,"isBotHome":false,"archived":false,"updatedAt":"@dayago:5"},
      {"id":"demo-onboarding","title":"New starter checklist","pinned":false,"folderId":null,"botId":"bot-atlas","appId":null,"source":"chat","isGroup":false,"isBotHome":false,"archived":false,"updatedAt":"@dayago:12"},
      {"id":"demo-naming","title":"Names for the design system","pinned":false,"folderId":null,"botId":null,"appId":"app-fast","source":"chat","isGroup":false,"isBotHome":false,"archived":false,"updatedAt":"@dayago:30"}
    ]
    """##

    static let inbox = ##"""
    [
      {"id":"inbox-1","kind":"approval","title":"IT Helpdesk needs your approval","body":"Create ticket: VPN fails after OS update","conversationId":"demo-approval","createdAt":"@today:300","read":false},
      {"id":"inbox-2","kind":"routine_result","title":"Weekly metrics digest is ready","body":"Sign-ups up 18%, churn steady at 2.1%.","conversationId":"demo-routine","createdAt":"@today:10800","read":false},
      {"id":"inbox-3","kind":"task_error","title":"Release Notes Writer couldn't finish","body":"The changelog source was unavailable. Try again later.","conversationId":"demo-release","createdAt":"@dayago:1","read":true},
      {"id":"inbox-4","kind":"task_result","title":"Travel Planner finished a task","body":"Shortlisted three hotels within policy near the venue.","conversationId":"demo-trip","createdAt":"@dayago:2","read":true}
    ]
    """##

    /// Message rows for the richer conversations, keyed by conversation ID.
    static let threads = ##"""
    {
      "demo-research": [
        {"id":"r-u1","parentId":null,"message":{"id":"r-u1","role":"user","parts":[{"type":"text","text":"We need a vector store for about 2M support articles. Can you compare pgvector, Qdrant and Weaviate?"}]}},
        {"id":"r-a1","parentId":"r-u1","message":{"id":"r-a1","role":"assistant","metadata":{"model":"Reasoning model"},"parts":[
          {"type":"step-start"},
          {"type":"reasoning","state":"done","text":"Compare the three at about 2M vectors: index types, metadata filtering, hybrid search and hosting. Check current docs first, then keep the answer short with a table and an index example."},
          {"type":"tool-web_search","toolCallId":"call-search-1","state":"output-available","input":{"query":"pgvector vs Qdrant vs Weaviate filtering hybrid search","maxResults":3},"output":{"results":[{"title":"pgvector: HNSW and IVFFlat indexes","url":"https://example.com/docs/pgvector-indexes"},{"title":"Qdrant: payload filtering","url":"https://example.com/docs/qdrant-filtering"},{"title":"Weaviate: hybrid search","url":"https://example.com/docs/weaviate-hybrid"}]}},
          {"type":"step-start"},
          {"type":"text","state":"done","text":"\u0023# Short answer\n\nAt 2M vectors all three are comfortable, so choose by where your data already lives:\n\n- **pgvector**: simplest if you already run Postgres. Filters are plain SQL.\n- **Qdrant**: strong filtered search with payload indexes.\n- **Weaviate**: hybrid keyword and vector search built in.\n\n| Option   | Hosting       | Hybrid search  |\n|----------|---------------|----------------|\n| pgvector | Your Postgres | Via SQL        |\n| Qdrant   | Self or cloud | Sparse vectors |\n| Weaviate | Self or cloud | Built in       |\n\nWith pgvector, start with an HNSW index:\n\n```sql\nCREATE INDEX articles_embedding_idx\n  ON articles USING hnsw (embedding vector_cosine_ops);\n```"}
        ]}}
      ],
      "demo-approval": [
        {"id":"h-u1","parentId":null,"message":{"id":"h-u1","role":"user","parts":[{"type":"text","text":"My laptop stopped connecting to the VPN after this morning's update."}]}},
        {"id":"h-a1","parentId":"h-u1","message":{"id":"h-a1","role":"assistant","parts":[
          {"type":"step-start"},
          {"type":"tool-lookup_device","toolCallId":"call-device-1","state":"output-available","input":{"user":"jordan@example.com"},"output":{"device":"LT-0420","os":"Updated today","vpnClient":"4.2.0"}},
          {"type":"step-start"},
          {"type":"text","state":"done","text":"Your laptop is on VPN client **4.2.0**, which has a known issue after today's update. Resetting the profile usually fixes it:\n\n1. Quit the VPN client.\n2. Delete the *Corporate* profile in **Settings → VPN**.\n3. Reopen the client and sign in again."}
        ]}},
        {"id":"h-u2","parentId":"h-a1","message":{"id":"h-u2","role":"user","parts":[{"type":"text","text":"Tried that, still failing. Can you open a ticket?"}]}},
        {"id":"h-a2","parentId":"h-u2","message":{"id":"h-a2","role":"assistant","parts":[
          {"type":"step-start"},
          {"type":"text","state":"done","text":"I'll open a high-priority ticket for the network team. Please approve so I can submit it."},
          {"type":"tool-create_ticket","toolCallId":"call-ticket-1","state":"approval-requested","input":{"title":"VPN fails after OS update","priority":"high","device":"LT-0420","requester":"jordan@example.com","notes":"Profile reset did not help."},"approval":{"id":"approval-ticket-1"}}
        ]}}
      ],
      "demo-image": [
        {"id":"d-u1","parentId":null,"message":{"id":"d-u1","role":"user","parts":[
          {"type":"file","mediaType":"text/csv","filename":"q3-signups.csv","url":"/api/files/demo-csv"},
          {"type":"text","text":"Here's the Q3 export. Can you chart weekly sign-ups and call out anything unusual?"}
        ]}},
        {"id":"d-a1","parentId":"d-u1","message":{"id":"d-a1","role":"assistant","parts":[
          {"type":"step-start"},
          {"type":"tool-run_python","toolCallId":"call-python-1","state":"output-available","input":{"code":"df = pd.read_csv('q3-signups.csv', parse_dates=['date'])\nweekly = df.resample('W', on='date').size()\nweekly.plot(kind='bar')"},"output":{"weeks":13,"total":10075,"chart":"/api/files/demo-image"}},
          {"type":"step-start"},
          {"type":"file","mediaType":"image/png","filename":"weekly-signups.png","url":"/api/files/demo-image"},
          {"type":"text","state":"done","text":"**Sign-ups grew 18% compared with Q2.**\n\n- Week 7 jumped to **1,240** after the pricing page refresh.\n- Weeks 10 and 11 dipped during the holiday period.\n- The last three weeks were the strongest of the quarter."}
        ]}}
      ]
    }
    """##

    /// Short one-question conversations.
    static let exchanges = ##"""
    [
      {"id":"demo-routine","question":"Run the weekly metrics digest.","answer":"\u0023# Weekly metrics\n\n- Sign-ups: **2,310** (up 18%)\n- Churn: **2.1%** (steady)\n- Support tickets: **142** (down 9%)\n\nNothing needs action this week."},
      {"id":"demo-release","question":"Draft release notes for v2.4 from the merged changes.","answer":"\u0023# v2.4\n\n### New\n- Bots can ask for approval before sending email.\n- Search highlights matching words.\n\n### Fixed\n- Long code blocks no longer overflow on small screens."},
      {"id":"demo-trip","question":"Plan a two-day offsite in Lisbon for 12 people in May.","answer":"Here's a first draft:\n\n1. **Day 1**: arrive by noon, afternoon workshop, team dinner.\n2. **Day 2**: planning sessions in the morning, walking tour after lunch.\n\nI found three hotels within policy near the venue. Want me to compare them?"},
      {"id":"demo-regex","question":"What's a regex for invoice numbers like INV-2026-00042?","answer":"Use this pattern:\n\n```regex\n^INV-\\d{4}-\\d{5}$\n```\n\nIt matches `INV-`, a four-digit year, a dash and exactly five digits."},
      {"id":"demo-sql","question":"This query takes 9 seconds. How can I speed it up?","answer":"The planner scans the whole `orders` table. Add an index that matches the filter and the sort:\n\n```sql\nCREATE INDEX orders_customer_created_idx\n  ON orders (customer_id, created_at DESC);\n```\n\nThen run `EXPLAIN ANALYZE` again to confirm it uses an index scan."},
      {"id":"demo-onboarding","question":"What should a new starter do in their first week?","answer":"\u0023# First week checklist\n\n- Set up your laptop and VPN\n- Meet your onboarding buddy\n- Read the team handbook\n- Ship a small first change"},
      {"id":"demo-naming","question":"Suggest names for our new design system.","answer":"A few ideas:\n\n1. **Keystone**: the piece that holds everything together.\n2. **Loom**: weaves components into products.\n3. **Tessera**: small tiles that make up a mosaic."}
    ]
    """##

    static let csv = """
    date,signups
    2026-07-05,610
    2026-07-12,655
    2026-07-19,640
    2026-07-26,700
    2026-08-02,735
    2026-08-09,760
    2026-08-16,1240
    2026-08-23,790
    2026-08-30,820
    2026-09-06,690
    2026-09-13,670
    2026-09-20,860
    2026-09-27,905
    """
}

/// A canned streamed answer.
struct DemoAnswer {
    let title: String
    let reasoning: String
    let markdown: String

    static func answer(for question: String) -> DemoAnswer {
        let lowered = question.lowercased()
        if lowered.contains("ios") || lowered.contains("mobile") || lowered.contains("iphone") {
            return DemoAnswer(
                title: "Turning on the iOS app",
                reasoning: "They want to turn on the mobile app. Explain the server setting, the restart and how sign-in works on the phone.",
                markdown: """
                ## Turn on the iOS app

                Mobile sign-in is off until an administrator enables it on the server.

                1. Add this to the server environment:

                ```sh
                MOBILE_APP_ENABLED=true
                ```

                2. Restart CollectiveUI.
                3. In the app, enter your server address and tap **Sign in**.

                You'll approve the device in your browser. It then appears in your active sessions, where you can revoke it at any time.
                """
            )
        }
        let words = question.split(separator: " ").prefix(5).joined(separator: " ")
        return DemoAnswer(
            title: words.isEmpty ? "New chat" : words,
            reasoning: "Break the request into steps and keep the answer short and actionable.",
            markdown: """
            ## Here's a plan

            1. **Clarify the goal**: what does done look like?
            2. **Gather what we know**: links, files and earlier decisions.
            3. **Draft and review**: I'll write a first version for you to edit.

            ```text
            Next step: share any files or links you'd like me to use.
            ```
            """
        )
    }
}
#endif
