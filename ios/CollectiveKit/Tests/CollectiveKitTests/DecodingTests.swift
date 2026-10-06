import XCTest
@testable import CollectiveKit

final class DecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        return try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testTeamBotCompatibilityHintKeepsOlderTargetsCompatible() throws {
        let team = try decode(TargetOption.self, #"{"kind":"bot","id":"team","name":"Team","hermes":true,"hermesTeam":true}"#)
        XCTAssertTrue(team.hermes)
        XCTAssertTrue(team.hermesTeam)
        let personal = try decode(TargetOption.self, #"{"kind":"bot","id":"personal","name":"Personal","hermes":true}"#)
        XCTAssertTrue(personal.hermes)
        XCTAssertFalse(personal.hermesTeam)
        XCTAssertFalse(TargetOption(kind: "bot", id: "native", name: "Native").hermesTeam)
    }

    func testSnapshotDecodingAndThread() throws {
        let json = #"""
        {
          "summary": {"id":"c1","title":"Trip","botId":null,"appId":"app1","isBotHome":false,"isGroup":false,"source":"chat","pinned":true,"folderId":null,"archived":false,"updatedAt":"2026-01-02T03:04:05.678Z"},
          "run": null,
          "conversationId": "c1",
          "isBotHome": false,
          "unavailable": false,
          "unavailableReason": null,
          "target": {"kind":"app","id":"app1","name":"GPT","icon":null,"description":null,"supportsVision":true,"futureField":{"a":1}},
          "initialRows": [
            {"id":"u1","parentId":null,"createdAt":1000,"feedback":null,"message":{"id":"u1","role":"user","parts":[{"type":"text","text":"Hi"},{"type":"file","mediaType":"image/png","filename":"a.png","url":"/api/files/f1"}]}},
            {"id":"a1","parentId":"u1","createdAt":2000,"feedback":1,"message":{"id":"a1","role":"assistant","metadata":{"model":"gpt"},"parts":[
              {"type":"step-start"},
              {"type":"reasoning","text":"hmm","state":"done"},
              {"type":"tool-web_search","toolCallId":"t1","state":"output-available","input":{"q":"x"},"output":[1,2,3]},
              {"type":"dynamic-tool","toolName":"mcp__x__y","toolCallId":"t2","state":"approval-requested","input":{},"approval":{"id":"ap1"}},
              {"type":"source-url","sourceId":"s1","url":"https://example.com","title":"Ex"},
              {"type":"source-document","sourceId":"s2","mediaType":"application/pdf","title":"Doc"},
              {"type":"data-speaker","data":{"botId":"b","name":"Moss","avatar":"blob:egg:teal"}},
              {"type":"holographic-projection","beam":42},
              {"type":"text","text":"Hello!","state":"done","providerMetadata":{"x":1}}
            ]}},
            {"id":"a2","parentId":"u1","createdAt":3000,"feedback":null,"message":{"id":"a2","role":"assistant","parts":[{"type":"text","text":"Alt"}]}}
          ],
          "initialLeafId": "a1",
          "skills": [{"name":"x"}],
          "resume": true,
          "task": null
        }
        """#
        let snapshot = try decode(ConversationSnapshot.self, json)
        XCTAssertEqual(snapshot.summary?.title, "Trip")
        XCTAssertEqual(snapshot.summary?.pinned, true)
        XCTAssertNotNil(snapshot.summary?.updatedAt)
        XCTAssertNil(snapshot.run)
        XCTAssertTrue(snapshot.resume)
        XCTAssertEqual(snapshot.target?.name, "GPT")
        XCTAssertEqual(snapshot.target?.supportsVision, true)
        XCTAssertEqual(snapshot.initialRows.count, 3)

        let thread = snapshot.displayedThread()
        XCTAssertEqual(thread.map { $0.id }, ["u1", "a1"])

        let user = thread[0]
        XCTAssertEqual(user.role, .user)
        XCTAssertEqual(user.plainText, "Hi")
        XCTAssertEqual(user.files.first?.filename, "a.png")

        let assistant = thread[1]
        XCTAssertEqual(assistant.parts.count, 9)
        XCTAssertEqual(assistant.metadata?["model"]?.stringValue, "gpt")
        if case .stepStart = assistant.parts[0] {} else { XCTFail("step-start") }
        if case .reasoning(let reasoning) = assistant.parts[1] {
            XCTAssertEqual(reasoning.text, "hmm")
        } else {
            XCTFail("reasoning")
        }
        if case .tool(let tool) = assistant.parts[2] {
            XCTAssertEqual(tool.toolName, "web_search")
            XCTAssertEqual(tool.output?.arrayValue?.count, 3)
            XCTAssertFalse(tool.isDynamic)
        } else {
            XCTFail("tool")
        }
        if case .tool(let tool) = assistant.parts[3] {
            XCTAssertTrue(tool.isDynamic)
            XCTAssertEqual(tool.toolName, "mcp__x__y")
            XCTAssertEqual(tool.approval?.id, "ap1")
        } else {
            XCTFail("dynamic tool")
        }
        if case .sourceURL(let source) = assistant.parts[4] {
            XCTAssertEqual(source.title, "Ex")
        } else {
            XCTFail("source-url")
        }
        if case .sourceDocument(let document) = assistant.parts[5] {
            XCTAssertEqual(document.title, "Doc")
        } else {
            XCTFail("source-document")
        }
        if case .data(let data) = assistant.parts[6] {
            XCTAssertEqual(data.name, "speaker")
            XCTAssertEqual(data.data["name"]?.stringValue, "Moss")
        } else {
            XCTFail("data-speaker")
        }
        if case .unknown(let raw) = assistant.parts[7] {
            XCTAssertEqual(raw["beam"]?.intValue, 42)
        } else {
            XCTFail("unknown part must decode to .unknown")
        }
        XCTAssertEqual(assistant.plainText, "Hello!")
        XCTAssertEqual(assistant.pendingApprovals.count, 1)
    }

    func testThreadFallsBackToNewestRowWithoutLeaf() {
        let rows = [
            MessageRow(id: "a", parentId: nil, createdAt: 1, message: UIMessage(id: "a", role: .user)),
            MessageRow(id: "b", parentId: "a", createdAt: 2, message: UIMessage(id: "b", role: .assistant)),
        ]
        XCTAssertEqual(MessageThread.path(rows: rows, leafId: nil).map { $0.id }, ["a", "b"])
        XCTAssertEqual(MessageThread.path(rows: rows, leafId: "missing").map { $0.id }, ["a", "b"])
        XCTAssertEqual(MessageThread.path(rows: rows, leafId: "a").map { $0.id }, ["a"])
        XCTAssertEqual(MessageThread.path(rows: [], leafId: nil).count, 0)
    }

    func testUnknownPartNeverFailsAndRoundTrips() throws {
        let json = #"{"id":"m","role":"assistant","parts":[{"type":"brand-new","x":[1,{"y":null}]},{"nope":true},"weird"]}"#
        let message = try decode(UIMessage.self, json)
        XCTAssertEqual(message.parts.count, 3)
        for part in message.parts {
            if case .unknown = part {} else { XCTFail("Expected unknown, got \(part)") }
        }
        let encoded = try JSONEncoder().encode(message)
        let again = try JSONDecoder().decode(UIMessage.self, from: encoded)
        XCTAssertEqual(again, message)
    }

    func testUserMessageEncoding() throws {
        let message = UIMessage(id: "abc", role: .user, parts: [
            .text(TextPart(text: "Hello")),
            .file(FilePart(mediaType: "image/jpeg", filename: "photo.jpg", url: "/api/files/f1")),
        ])
        let json = message.toJSON()
        XCTAssertEqual(json["role"]?.stringValue, "user")
        XCTAssertEqual(json["parts"]?.arrayValue?.count, 2)
        XCTAssertEqual(json["parts"]?.arrayValue?.first?["type"]?.stringValue, "text")
        XCTAssertEqual(json["parts"]?.arrayValue?.last?["url"]?.stringValue, "/api/files/f1")
    }

    func testShellDecodingIsLenient() throws {
        let json = #"""
        {
          "user": {"id":"u","name":"Ada","email":null,"isAdmin":true,"canCreateBots":false},
          "branding": {"appName":"Portal","welcomeText":"Hi","logoEmoji":"🐝","logoUrl":null},
          "conversations": [
            {"id":"c1","title":"One","pinned":false,"folderId":null,"botId":null,"appId":"a","source":"chat","updatedAt":"2026-03-01T10:00:00Z"},
            {"id":"c2","title":null,"pinned":true,"source":"routine","isBotHome":true,"updatedAt":"2026-03-01T10:00:00.123Z","taskActivity":{"status":"done","unread":true}}
          ],
          "folders": [{"id":"f","name":"Work"}],
          "apps": [{"kind":"app","id":"a","name":"Model A"}],
          "bots": [{"kind":"bot","id":"b","name":"Moss","icon":"blob:ghost:purple","description":null,"starters":["Hi"],"status":"working","members":null,"personalPlan":{"x":1},"lastAt":null}],
          "inboxUnread": 3,
          "extra": "ignored"
        }
        """#
        let shell = try decode(ShellResponse.self, json)
        XCTAssertEqual(shell.user?.name, "Ada")
        XCTAssertEqual(shell.branding.logoEmoji, "🐝")
        XCTAssertEqual(shell.conversations.count, 2)
        XCTAssertEqual(shell.conversations[1].title, "")
        XCTAssertTrue(shell.conversations[1].isBotHome)
        XCTAssertEqual(shell.conversations[1].taskActivity?.unread, true)
        XCTAssertNotNil(shell.conversations[0].updatedAt)
        XCTAssertNotNil(shell.conversations[1].updatedAt)
        XCTAssertEqual(shell.bots.first?.starters, ["Hi"])
        XCTAssertEqual(shell.bots.first?.status, "working")
        XCTAssertEqual(shell.bots.first?.members.count, 0)
        XCTAssertEqual(shell.inboxUnread, 3)
    }

    func testMobileInfoAndErrors() throws {
        let info = try decode(MobileInfo.self, #"{"enabled":false,"appName":"X","logoEmoji":"🤖","apiVersion":1}"#)
        XCTAssertFalse(info.enabled)
        XCTAssertThrowsError(try decode(MobileInfo.self, #"{"hello":"world"}"#))

        let error = APIError.from(status: 400, data: Data(#"{"error":"Too long","unsavedMessageId":"m1"}"#.utf8))
        XCTAssertEqual(error, .server(status: 400, message: "Too long", unsavedMessageId: "m1"))
        XCTAssertEqual(error.errorDescription, "Too long")
        XCTAssertTrue(APIError.unauthorized.isUnauthorized)
        XCTAssertTrue(CancellationError().isCancellation)
    }

    func testInboxSearchAndUpload() throws {
        let inbox = try decode(InboxResponse.self, #"{"items":[{"id":"i","kind":"approval","title":"Approve","body":null,"conversationId":"c","createdAt":"2026-03-01T10:00:00Z","read":false}]}"#)
        XCTAssertEqual(inbox.items.first?.kind, "approval")
        let search = try decode(SearchResponse.self, #"{"results":[{"conversationId":"c","title":"T","snippet":"a <mark>b</mark> &amp; c","updatedAt":"2026-03-01T10:00:00Z"}]}"#)
        XCTAssertEqual(TextUtilities.stripHTML(search.results[0].snippet ?? ""), "a b & c")
        let file = try decode(UploadedFile.self, #"{"id":"f","url":"/api/files/f","filename":"a.txt","mediaType":"text/plain","readable":true}"#)
        XCTAssertEqual(file.url, "/api/files/f")
    }

    func testChunkParsing() {
        XCTAssertEqual(UIMessageChunk.parse(#"{"type":"tool-approval-request","approvalId":"a","toolCallId":"t"}"#), .toolApprovalRequest(approvalId: "a", toolCallId: "t"))
        XCTAssertEqual(UIMessageChunk.parse(#"{"type":"data-title","data":{"title":"T"}}"#), .data(name: "title", id: nil, data: ["title": "T"], transient: false))
        XCTAssertEqual(UIMessageChunk.parse(#"{"type":"mystery"}"#), .unknown(type: "mystery"))
        XCTAssertNil(UIMessageChunk.parse("not json"))
        XCTAssertNil(UIMessageChunk.parse("[1,2]"))
    }

    func testJSONValuePrettyPrinting() {
        let value: JSONValue = ["b": 1, "a": [true, .null, 2.5], "url": "https://x/y"]
        XCTAssertEqual(value.compactString(), #"{"a":[true,null,2.5],"b":1,"url":"https://x/y"}"#)
        XCTAssertEqual(JSONValue.string("plain").prettyPrinted(), "plain")
        XCTAssertTrue(value.prettyPrinted().contains("\n"))
    }

    func testGrouping() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? TimeZone.current
        let now = ISODate.parse("2026-03-10T12:00:00Z") ?? Date()
        let conversations = [
            ConversationSummary(id: "p", title: "P", pinned: true, updatedAt: ISODate.parse("2020-01-01T00:00:00Z")),
            ConversationSummary(id: "t", title: "T", updatedAt: ISODate.parse("2026-03-10T08:00:00Z")),
            ConversationSummary(id: "y", title: "Y", updatedAt: ISODate.parse("2026-03-09T08:00:00Z")),
            ConversationSummary(id: "w", title: "W", updatedAt: ISODate.parse("2026-03-05T08:00:00Z")),
            ConversationSummary(id: "o", title: "O", updatedAt: ISODate.parse("2026-01-01T08:00:00Z")),
        ]
        let sections = ConversationGrouping.sections(for: conversations, now: now, calendar: calendar)
        XCTAssertEqual(sections.map { $0.title }, ["Pinned", "Today", "Yesterday", "Previous 7 Days", "Older"])
        XCTAssertEqual(sections.map { $0.conversations.first?.id ?? "" }, ["p", "t", "y", "w", "o"])
    }
}
