#if DEBUG
import Foundation
import CollectiveKit

/// In-memory stand-in for the CollectiveUI mobile API, used only in demo mode.
/// It is stateful, so sent messages, renames and approvals survive a snapshot reload.
final class DemoServer: @unchecked Sendable {
    static let shared = DemoServer()

    private struct StoredFile {
        let data: Data
        let mediaType: String
        let filename: String
    }

    private let lock = NSLock()
    private var userJSON: JSONValue = .null
    private var brandingJSON: JSONValue = .null
    private var apps: [JSONValue] = []
    private var bots: [JSONValue] = []
    /// Conversation summaries, newest first.
    private var conversations: [JSONValue] = []
    private var rows: [String: [MessageRow]] = [:]
    private var leaves: [String: String] = [:]
    private var inbox: [JSONValue] = []
    private var files: [String: StoredFile] = [:]
    private var chartPNG = Data()
    private var counter = 0

    private init() {
        let now = Date()
        userJSON = DemoServer.parseFixture(DemoFixtures.user, now: now)
        brandingJSON = DemoServer.parseFixture(DemoFixtures.branding, now: now)
        apps = DemoServer.parseFixture(DemoFixtures.apps, now: now).arrayValue ?? []
        bots = DemoServer.parseFixture(DemoFixtures.bots, now: now).arrayValue ?? []
        conversations = DemoServer.parseFixture(DemoFixtures.conversations, now: now).arrayValue ?? []
        inbox = DemoServer.parseFixture(DemoFixtures.inbox, now: now).arrayValue ?? []

        let threads = DemoServer.parseFixture(DemoFixtures.threads, now: now).objectValue ?? [:]
        for (conversationId, value) in threads {
            let decoded = DemoServer.decodeRows(value)
            rows[conversationId] = decoded
            if let last = decoded.last {
                leaves[conversationId] = last.id
            }
        }

        let exchanges = DemoServer.parseFixture(DemoFixtures.exchanges, now: now).arrayValue ?? []
        for exchange in exchanges {
            guard let conversationId = exchange["id"]?.stringValue,
                  let question = exchange["question"]?.stringValue,
                  let answer = exchange["answer"]?.stringValue
            else {
                continue
            }
            let userId = "x-\(conversationId)-u"
            let assistantId = "x-\(conversationId)-a"
            let userMessage = UIMessage(id: userId, role: .user, parts: [.text(TextPart(text: question))])
            let assistantMessage = UIMessage(id: assistantId, role: .assistant, parts: [
                .stepStart,
                .text(TextPart(text: answer, state: "done")),
            ])
            rows[conversationId] = [
                MessageRow(id: userId, parentId: nil, message: userMessage),
                MessageRow(id: assistantId, parentId: userId, message: assistantMessage),
            ]
            leaves[conversationId] = assistantId
        }
    }

    /// Called once on the main actor with the rendered chart image.
    func install(chartPNG data: Data) {
        lock.lock()
        chartPNG = data
        lock.unlock()
    }

    // MARK: - Routing

    func handle(_ request: URLRequest) -> DemoResponse {
        let body = DemoServer.bodyData(of: request)
        lock.lock()
        defer { lock.unlock() }

        let method = (request.httpMethod ?? "GET").uppercased()
        let path = request.url?.path ?? "/"
        let parts = path.split(separator: "/").map { String($0) }
        let query = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems ?? []

        if method == "GET", DemoServer.match(parts, ["api", "mobile", "info"]) != nil {
            return json(.object([
                "enabled": .bool(true),
                "appName": .string("CollectiveUI"),
                "logoEmoji": .string("✨"),
                "apiVersion": .number(1),
            ]))
        }
        if method == "POST", DemoServer.match(parts, ["api", "mobile", "auth", "token"]) != nil {
            return json(.object([
                "token": .string(DemoMode.token),
                "expiresAt": .string(DemoServer.iso(Date().addingTimeInterval(89 * 86_400))),
                "user": userJSON,
            ]))
        }
        if DemoServer.match(parts, ["api", "mobile", "v1", "session"]) != nil {
            if method == "DELETE" {
                return noContent()
            }
            return json(.object([
                "user": userJSON,
                "deviceName": .string("Jordan's iPhone"),
                "expiresAt": .string(DemoServer.iso(Date().addingTimeInterval(89 * 86_400))),
            ]))
        }
        if method == "GET", DemoServer.match(parts, ["api", "mobile", "v1", "shell"]) != nil {
            return shell()
        }
        if method == "POST", let captures = DemoServer.match(parts, ["api", "mobile", "v1", "bots", "*", "chat"]) {
            let kind = DemoServer.jsonBody(body)?["kind"]?.stringValue ?? "home"
            return openBotChat(botId: captures[0], kind: kind)
        }
        if let captures = DemoServer.match(parts, ["api", "mobile", "v1", "conversations", "*"]) {
            if method == "DELETE" {
                conversations.removeAll(where: { $0["id"]?.stringValue == captures[0] })
                return noContent()
            }
            if method == "PATCH" {
                let changes = DemoServer.jsonBody(body) ?? .object([:])
                updateSummary(captures[0]) { summary in
                    if let title = changes["title"]?.stringValue {
                        summary["title"] = .string(title)
                    }
                    if let pinned = changes["pinned"]?.boolValue {
                        summary["pinned"] = .bool(pinned)
                    }
                    if let archived = changes["archived"]?.boolValue {
                        summary["archived"] = .bool(archived)
                    }
                }
                return noContent()
            }
        }
        if method == "GET", DemoServer.match(parts, ["api", "mobile", "v1", "inbox"]) != nil {
            return json(.object(["items": .array(inbox)]))
        }
        if method == "POST", DemoServer.match(parts, ["api", "mobile", "v1", "inbox", "read"]) != nil {
            let readId = DemoServer.jsonBody(body)?["id"]?.stringValue
            inbox = inbox.map { (item: JSONValue) -> JSONValue in
                guard readId == nil || item["id"]?.stringValue == readId, case .object(var fields) = item else {
                    return item
                }
                fields["read"] = .bool(true)
                return .object(fields)
            }
            return noContent()
        }
        if method == "GET", DemoServer.match(parts, ["api", "search"]) != nil {
            let text = query.first(where: { $0.name == "q" })?.value ?? ""
            return search(text)
        }
        if method == "POST", DemoServer.match(parts, ["api", "files"]) != nil {
            return upload(body)
        }
        if method == "GET", let captures = DemoServer.match(parts, ["api", "files", "*"]) {
            return file(captures[0])
        }
        if method == "POST", DemoServer.match(parts, ["api", "chat"]) != nil {
            return chat(DemoServer.jsonBody(body) ?? .object([:]))
        }
        if method == "GET", let captures = DemoServer.match(parts, ["api", "chat", "*"]) {
            return snapshot(captures[0])
        }
        if method == "GET", DemoServer.match(parts, ["api", "chat", "*", "stream"]) != nil {
            return noContent()
        }
        if method == "POST", DemoServer.match(parts, ["api", "chat", "*", "stop"]) != nil {
            return json(.object([:]))
        }
        return failure("Not available in demo mode", status: 404)
    }

    // MARK: - Endpoints

    private func shell() -> DemoResponse {
        let visible = conversations.filter { $0["archived"]?.boolValue != true }
        let unread = inbox.filter { $0["read"]?.boolValue != true }.count
        return json(.object([
            "user": userJSON,
            "branding": brandingJSON,
            "conversations": .array(visible),
            "folders": .array([]),
            "apps": .array(apps),
            "bots": .array(bots),
            "inboxUnread": .number(Double(unread)),
        ]))
    }

    private func openBotChat(botId: String, kind: String) -> DemoResponse {
        guard let bot = bots.first(where: { $0["id"]?.stringValue == botId }) else {
            return failure("Bot not found", status: 404)
        }
        let botName = bot["name"]?.stringValue ?? "Bot"
        if kind == "side" {
            counter += 1
            let conversationId = "side-\(botId)-\(counter)"
            insertSummary(id: conversationId, title: "New chat with \(botName)", botId: botId, appId: nil, isBotHome: false)
            return json(.object(["conversationId": .string(conversationId)]))
        }
        let conversationId = "home-\(botId)"
        ensureHome(conversationId)
        return json(.object(["conversationId": .string(conversationId)]))
    }

    private func search(_ text: String) -> DemoResponse {
        let term = text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        let mark = "<mark>\(term)</mark>"
        let results: [JSONValue] = [
            .object([
                "conversationId": .string("demo-research"),
                "title": .string("Comparing vector databases"),
                "snippet": .string("…we compared \(mark) stores for about 2M support articles…"),
                "updatedAt": .string(DemoServer.iso(Date().addingTimeInterval(-1500))),
            ]),
            .object([
                "conversationId": .string("demo-sql"),
                "title": .string("Speeding up a slow SQL query"),
                "snippet": .string("…add an index so \(mark) lookups use an index scan…"),
                "updatedAt": .string(DemoServer.iso(Date().addingTimeInterval(-5 * 86_400))),
            ]),
            .object([
                "conversationId": .string("demo-onboarding"),
                "title": .string("New starter checklist"),
                "snippet": .string("…read the handbook section on \(mark) before your first change…"),
                "updatedAt": .string(DemoServer.iso(Date().addingTimeInterval(-12 * 86_400))),
            ]),
        ]
        return json(.object(["results": .array(text.isEmpty ? [] : results)]))
    }

    private func upload(_ body: Data?) -> DemoResponse {
        counter += 1
        let fileId = "demo-upload-\(counter)"
        var filename = "attachment"
        var mediaType = "application/octet-stream"
        var payload = Data()
        if let body, let parsed = DemoServer.parseMultipart(body) {
            filename = parsed.filename
            mediaType = parsed.mediaType
            payload = parsed.payload
        }
        files[fileId] = StoredFile(data: payload, mediaType: mediaType, filename: filename)
        return json(.object([
            "id": .string(fileId),
            "url": .string("/api/files/\(fileId)"),
            "filename": .string(filename),
            "mediaType": .string(mediaType),
            "readable": .bool(true),
        ]))
    }

    private func file(_ fileId: String) -> DemoResponse {
        switch fileId {
        case "demo-image":
            return .immediate(status: 200, contentType: "image/png", body: chartPNG)
        case "demo-csv":
            return .immediate(status: 200, contentType: "text/csv", body: Data(DemoFixtures.csv.utf8))
        default:
            if let stored = files[fileId] {
                return .immediate(status: 200, contentType: stored.mediaType, body: stored.data)
            }
            return failure("File not found", status: 404)
        }
    }

    private func snapshot(_ conversationId: String) -> DemoResponse {
        if summary(for: conversationId) == nil {
            if conversationId.hasPrefix("home-") {
                ensureHome(conversationId)
            } else {
                return failure("Conversation not found", status: 404)
            }
        }
        guard let summaryJSON = summary(for: conversationId) else {
            return failure("Conversation not found", status: 404)
        }
        let threadRows = rows[conversationId] ?? []
        let leaf: JSONValue
        if let leafId = leaves[conversationId] {
            leaf = .string(leafId)
        } else {
            leaf = .null
        }
        return json(.object([
            "summary": summaryJSON,
            "run": .null,
            "conversationId": .string(conversationId),
            "isBotHome": .bool(summaryJSON["isBotHome"]?.boolValue ?? false),
            "unavailable": .bool(false),
            "unavailableReason": .null,
            "target": target(for: summaryJSON),
            "initialRows": .array(threadRows.map { DemoServer.rowJSON($0) }),
            "initialLeafId": leaf,
            "skills": .array([]),
            "resume": .bool(false),
            "task": .null,
        ]))
    }

    // MARK: - Chat streaming

    private func chat(_ body: JSONValue) -> DemoResponse {
        guard let conversationId = body["conversationId"]?.stringValue else {
            return failure("conversationId is required", status: 400)
        }
        if body["regenerate"]?.boolValue == true, let parentId = body["parentId"]?.stringValue {
            let question = rows[conversationId]?.first(where: { $0.id == parentId })?.message.plainText ?? ""
            return streamAnswer(conversationId: conversationId, parentId: parentId, question: question, newTitle: nil)
        }
        guard let messageJSON = body["message"], let message = DemoServer.decodeMessage(messageJSON) else {
            return failure("message is required", status: 400)
        }
        if message.role == .assistant {
            return continueAfterApproval(conversationId: conversationId, answered: message)
        }

        let question = message.plainText
        var newTitle: String? = nil
        if summary(for: conversationId) == nil {
            let answer = DemoAnswer.answer(for: question)
            newTitle = answer.title
            insertSummary(
                id: conversationId,
                title: answer.title,
                botId: body["botId"]?.stringValue,
                appId: body["appId"]?.stringValue,
                isBotHome: false
            )
        }
        let parentId = body["parentId"]?.stringValue
        appendRow(conversationId, MessageRow(id: message.id, parentId: parentId, createdAt: DemoServer.nowMillis(), message: message))
        return streamAnswer(conversationId: conversationId, parentId: message.id, question: question, newTitle: newTitle)
    }

    private func streamAnswer(conversationId: String, parentId: String, question: String, newTitle: String?) -> DemoResponse {
        counter += 1
        let messageId = "demo-reply-\(counter)"
        let answer = DemoAnswer.answer(for: question)
        var chunks: [(JSONValue, TimeInterval)] = []
        chunks.append((.object(["type": .string("start"), "messageId": .string(messageId)]), 0.35))
        chunks.append((.object(["type": .string("start-step")]), 0.05))
        chunks.append((.object(["type": .string("reasoning-start"), "id": .string("r1")]), 0.05))
        for (index, piece) in DemoServer.pieces(answer.reasoning).enumerated() {
            chunks.append((.object(["type": .string("reasoning-delta"), "id": .string("r1"), "delta": .string(piece)]), DemoServer.delay(index)))
        }
        chunks.append((.object(["type": .string("reasoning-end"), "id": .string("r1")]), 0.2))
        chunks.append((.object(["type": .string("text-start"), "id": .string("t1")]), 0.05))
        for (index, piece) in DemoServer.pieces(answer.markdown).enumerated() {
            chunks.append((.object(["type": .string("text-delta"), "id": .string("t1"), "delta": .string(piece)]), DemoServer.delay(index)))
        }
        chunks.append((.object(["type": .string("text-end"), "id": .string("t1")]), 0.05))
        if let newTitle {
            chunks.append((.object([
                "type": .string("data-title"),
                "data": .object(["title": .string(newTitle)]),
                "transient": .bool(true),
            ]), 0.05))
        }
        chunks.append((.object(["type": .string("finish-step")]), 0.05))
        chunks.append((.object(["type": .string("finish"), "finishReason": .string("stop")]), 0.05))

        var reducer = UIMessageStreamReducer(messageId: messageId)
        for (chunk, _) in chunks {
            reducer.apply(UIMessageChunk(json: chunk))
        }
        appendRow(conversationId, MessageRow(id: messageId, parentId: parentId, createdAt: DemoServer.nowMillis(), message: reducer.message))
        touchSummary(conversationId)
        return .stream(DemoServer.events(chunks))
    }

    private func continueAfterApproval(conversationId: String, answered: UIMessage) -> DemoResponse {
        guard var threadRows = rows[conversationId],
              let rowIndex = threadRows.firstIndex(where: { $0.id == answered.id })
        else {
            return failure("Message not found", status: 404)
        }
        var stored = threadRows[rowIndex].message
        var approvedAll = true
        var chunks: [(JSONValue, TimeInterval)] = []
        chunks.append((.object(["type": .string("start"), "messageId": .string(stored.id)]), 0.35))
        chunks.append((.object(["type": .string("start-step")]), 0.05))
        for answer in answered.toolParts {
            let approved = answer.approval?.approved ?? false
            approvedAll = approvedAll && approved
            if let partIndex = stored.parts.firstIndex(where: { part in
                if case .tool(let tool) = part {
                    return tool.toolCallId == answer.toolCallId
                }
                return false
            }), case .tool(var tool) = stored.parts[partIndex] {
                tool.state = "approval-responded"
                tool.approval = answer.approval
                stored.parts[partIndex] = .tool(tool)
            }
            if approved {
                chunks.append((.object([
                    "type": .string("tool-output-available"),
                    "toolCallId": .string(answer.toolCallId),
                    "output": .object([
                        "ticket": .string("IT-4821"),
                        "status": .string("open"),
                        "assignee": .string("Network team"),
                    ]),
                ]), 0.6))
            } else {
                chunks.append((.object([
                    "type": .string("tool-output-denied"),
                    "toolCallId": .string(answer.toolCallId),
                ]), 0.3))
            }
        }
        chunks.append((.object(["type": .string("finish-step")]), 0.05))
        chunks.append((.object(["type": .string("start-step")]), 0.05))
        chunks.append((.object(["type": .string("text-start"), "id": .string("t-after")]), 0.05))
        let text = approvedAll
            ? "Done. Ticket **IT-4821** is open and assigned to the network team. You'll see updates in your inbox."
            : "No problem, I won't open the ticket. Let me know if you'd like to try something else."
        for (index, piece) in DemoServer.pieces(text).enumerated() {
            chunks.append((.object(["type": .string("text-delta"), "id": .string("t-after"), "delta": .string(piece)]), DemoServer.delay(index)))
        }
        chunks.append((.object(["type": .string("text-end"), "id": .string("t-after")]), 0.05))
        chunks.append((.object(["type": .string("finish-step")]), 0.05))
        chunks.append((.object(["type": .string("finish"), "finishReason": .string("stop")]), 0.05))

        var reducer = UIMessageStreamReducer(continuing: stored)
        for (chunk, _) in chunks {
            reducer.apply(UIMessageChunk(json: chunk))
        }
        threadRows[rowIndex].message = reducer.message
        rows[conversationId] = threadRows
        touchSummary(conversationId)

        bots = bots.map { (bot: JSONValue) -> JSONValue in
            guard bot["id"]?.stringValue == "bot-helpdesk", case .object(var fields) = bot else { return bot }
            fields["status"] = .null
            fields["preview"] = .string(approvedAll ? "Ticket IT-4821 is open." : "Ticket not created.")
            return .object(fields)
        }
        return .stream(DemoServer.events(chunks))
    }

    // MARK: - Store helpers

    private func summary(for conversationId: String) -> JSONValue? {
        return conversations.first(where: { $0["id"]?.stringValue == conversationId })
    }

    private func target(for summary: JSONValue) -> JSONValue {
        if let botId = summary["botId"]?.stringValue, let bot = bots.first(where: { $0["id"]?.stringValue == botId }) {
            return bot
        }
        if let appId = summary["appId"]?.stringValue, let app = apps.first(where: { $0["id"]?.stringValue == appId }) {
            return app
        }
        return .null
    }

    private func updateSummary(_ conversationId: String, _ change: (inout [String: JSONValue]) -> Void) {
        guard let index = conversations.firstIndex(where: { $0["id"]?.stringValue == conversationId }),
              case .object(var fields) = conversations[index]
        else {
            return
        }
        change(&fields)
        conversations[index] = .object(fields)
    }

    /// Marks a conversation as just updated and moves it to the top of the list.
    private func touchSummary(_ conversationId: String) {
        updateSummary(conversationId) { summary in
            summary["updatedAt"] = .string(DemoServer.iso(Date()))
        }
        if let index = conversations.firstIndex(where: { $0["id"]?.stringValue == conversationId }), index > 0 {
            let item = conversations.remove(at: index)
            conversations.insert(item, at: 0)
        }
    }

    private func insertSummary(id: String, title: String, botId: String?, appId: String?, isBotHome: Bool) {
        var fields: [String: JSONValue] = [
            "id": .string(id),
            "title": .string(title),
            "pinned": .bool(false),
            "folderId": .null,
            "source": .string("chat"),
            "isGroup": .bool(false),
            "isBotHome": .bool(isBotHome),
            "archived": .bool(false),
            "updatedAt": .string(DemoServer.iso(Date())),
        ]
        if let botId {
            fields["botId"] = .string(botId)
        } else {
            fields["botId"] = .null
        }
        if let appId {
            fields["appId"] = .string(appId)
        } else {
            fields["appId"] = .null
        }
        conversations.insert(.object(fields), at: 0)
    }

    private func ensureHome(_ conversationId: String) {
        guard summary(for: conversationId) == nil else { return }
        let botId = String(conversationId.dropFirst("home-".count))
        let botName = bots.first(where: { $0["id"]?.stringValue == botId })?["name"]?.stringValue ?? "Bot"
        insertSummary(id: conversationId, title: botName, botId: botId, appId: nil, isBotHome: true)
    }

    private func appendRow(_ conversationId: String, _ row: MessageRow) {
        var threadRows = rows[conversationId] ?? []
        threadRows.append(row)
        rows[conversationId] = threadRows
        leaves[conversationId] = row.id
    }

    // MARK: - Responses

    private func json(_ value: JSONValue, status: Int = 200) -> DemoResponse {
        let data = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
        return .immediate(status: status, contentType: "application/json", body: data)
    }

    private func noContent() -> DemoResponse {
        return .immediate(status: 204, contentType: nil, body: Data())
    }

    private func failure(_ message: String, status: Int) -> DemoResponse {
        return json(.object(["error": .string(message)]), status: status)
    }

    // MARK: - Static helpers

    static func match(_ parts: [String], _ pattern: [String]) -> [String]? {
        guard parts.count == pattern.count else { return nil }
        var captures: [String] = []
        for (part, expected) in zip(parts, pattern) {
            if expected == "*" {
                captures.append(part)
            } else if part != expected {
                return nil
            }
        }
        return captures
    }

    static func jsonBody(_ body: Data?) -> JSONValue? {
        guard let body, !body.isEmpty else { return nil }
        return JSONValue.parse(data: body)
    }

    static func decodeMessage(_ value: JSONValue) -> UIMessage? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(UIMessage.self, from: data)
    }

    static func decodeRows(_ value: JSONValue) -> [MessageRow] {
        guard let data = try? JSONEncoder().encode(value) else { return [] }
        return (try? JSONDecoder().decode([MessageRow].self, from: data)) ?? []
    }

    static func rowJSON(_ row: MessageRow) -> JSONValue {
        let parent: JSONValue
        if let parentId = row.parentId {
            parent = .string(parentId)
        } else {
            parent = .null
        }
        return .object([
            "id": .string(row.id),
            "parentId": parent,
            "createdAt": .number(row.createdAt ?? nowMillis()),
            "feedback": .null,
            "message": row.message.toJSON(),
        ])
    }

    static func nowMillis() -> Double {
        return (Date().timeIntervalSince1970 * 1000).rounded()
    }

    /// Splits text after each space or newline so it can be streamed word by word.
    static func pieces(_ text: String) -> [String] {
        var result: [String] = []
        var current = ""
        for character in text {
            current.append(character)
            if character == " " || character == "\n" {
                result.append(current)
                current = ""
            }
        }
        if !current.isEmpty {
            result.append(current)
        }
        return result
    }

    /// 40 to 70 ms between streamed pieces.
    static func delay(_ index: Int) -> TimeInterval {
        return 0.04 + Double(index % 4) * 0.01
    }

    static func events(_ chunks: [(JSONValue, TimeInterval)]) -> [DemoStreamEvent] {
        var events: [DemoStreamEvent] = [DemoStreamEvent(delay: 0.05, payload: ": keepalive\n\n")]
        for (chunk, delay) in chunks {
            events.append(DemoStreamEvent(delay: delay, payload: "data: " + chunk.compactString() + "\n\n"))
        }
        events.append(DemoStreamEvent(delay: 0.05, payload: "data: [DONE]\n\n"))
        return events
    }

    /// Reads the request body, which URLSession hands to URL protocols as a stream.
    static func bodyData(of request: URLRequest) -> Data? {
        if let body = request.httpBody {
            return body
        }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 {
                break
            }
            data.append(contentsOf: buffer[0..<count])
        }
        return data
    }

    static func parseMultipart(_ body: Data) -> (filename: String, mediaType: String, payload: Data)? {
        guard let headerEnd = body.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let header = String(decoding: body[body.startIndex..<headerEnd.lowerBound], as: UTF8.self)
        var payload = Data(body[headerEnd.upperBound..<body.endIndex])
        if let tail = payload.range(of: Data("\r\n--".utf8), options: .backwards) {
            payload = Data(payload[payload.startIndex..<tail.lowerBound])
        }
        var filename = "attachment"
        if let start = header.range(of: "filename=\"") {
            let rest = header[start.upperBound...]
            if let end = rest.firstIndex(of: "\"") {
                filename = String(rest[rest.startIndex..<end])
            }
        }
        var mediaType = "application/octet-stream"
        for line in header.components(separatedBy: "\r\n") where line.lowercased().hasPrefix("content-type:") {
            mediaType = line.dropFirst("content-type:".count).trimmingCharacters(in: .whitespaces)
        }
        return (filename, mediaType, payload)
    }

    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// Parses fixture JSON after expanding `"@today:N"` and `"@dayago:D"` time tokens.
    static func parseFixture(_ text: String, now: Date) -> JSONValue {
        return JSONValue.parse(expandTimes(text, now: now)) ?? .null
    }

    static func expandTimes(_ text: String, now: Date) -> String {
        guard let regex = try? NSRegularExpression(pattern: "\"@(today|dayago):([0-9]+)\"") else {
            return text
        }
        let source = text as NSString
        let startOfToday = Calendar.current.startOfDay(for: now)
        var result = ""
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            result += source.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            let kind = source.substring(with: match.range(at: 1))
            let amount = Double(source.substring(with: match.range(at: 2))) ?? 0
            let date: Date
            if kind == "today" {
                date = max(now.addingTimeInterval(-amount), startOfToday.addingTimeInterval(60))
            } else {
                date = startOfToday.addingTimeInterval(-amount * 86_400 + 12 * 3_600)
            }
            result += "\"" + iso(date) + "\""
            cursor = match.range.location + match.range.length
        }
        result += source.substring(from: cursor)
        return result
    }
}
#endif
