import Foundation

// MARK: - Lenient decoding helpers

extension KeyedDecodingContainer {
    /// Decodes a value if present and of the right type; returns nil instead of throwing.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        return try? decodeIfPresent(type, forKey: key)
    }

    /// Decodes an ISO-8601 string (or a millisecond/second epoch number) as a Date.
    func lenientDate(_ key: Key) -> Date? {
        if let text = lenient(String.self, key) {
            return ISODate.parse(text)
        }
        if let number = lenient(Double.self, key) {
            return Date(timeIntervalSince1970: number > 100_000_000_000 ? number / 1000 : number)
        }
        return nil
    }
}

public enum ISODate {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    public static func parse(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        if let date = fractional.date(from: text) {
            return date
        }
        return plain.date(from: text)
    }
}

// MARK: - Accounts and server

public struct User: Decodable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var email: String?
    public var isAdmin: Bool
    public var canCreateBots: Bool

    public init(id: String, name: String, email: String? = nil, isAdmin: Bool = false, canCreateBots: Bool = false) {
        self.id = id
        self.name = name
        self.email = email
        self.isAdmin = isAdmin
        self.canCreateBots = canCreateBots
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, email, isAdmin, canCreateBots
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        name = c.lenient(String.self, .name) ?? ""
        email = c.lenient(String.self, .email)
        isAdmin = c.lenient(Bool.self, .isAdmin) ?? false
        canCreateBots = c.lenient(Bool.self, .canCreateBots) ?? false
    }
}

public struct MobileInfo: Decodable, Hashable, Sendable {
    public var enabled: Bool
    public var appName: String
    public var logoEmoji: String
    public var apiVersion: Int

    public init(enabled: Bool, appName: String, logoEmoji: String, apiVersion: Int) {
        self.enabled = enabled
        self.appName = appName
        self.logoEmoji = logoEmoji
        self.apiVersion = apiVersion
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, appName, logoEmoji, apiVersion
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let enabled = c.lenient(Bool.self, .enabled) else {
            throw DecodingError.keyNotFound(CodingKeys.enabled, DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Not a CollectiveUI mobile info response"))
        }
        self.enabled = enabled
        appName = c.lenient(String.self, .appName) ?? "CollectiveUI"
        logoEmoji = c.lenient(String.self, .logoEmoji) ?? ""
        apiVersion = c.lenient(Int.self, .apiVersion) ?? 1
    }
}

public struct TokenResponse: Decodable, Hashable, Sendable {
    public var token: String
    public var expiresAt: Date?
    public var user: User?

    private enum CodingKeys: String, CodingKey {
        case token, expiresAt, user
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        token = try c.decode(String.self, forKey: .token)
        expiresAt = c.lenientDate(.expiresAt)
        user = c.lenient(User.self, .user)
    }
}

public struct SessionInfo: Decodable, Hashable, Sendable {
    public var user: User?
    public var deviceName: String
    public var expiresAt: Date?

    private enum CodingKeys: String, CodingKey {
        case user, deviceName, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = c.lenient(User.self, .user)
        deviceName = c.lenient(String.self, .deviceName) ?? ""
        expiresAt = c.lenientDate(.expiresAt)
    }
}

// MARK: - Shell

public struct Branding: Decodable, Hashable, Sendable {
    public var appName: String
    public var welcomeText: String
    public var logoEmoji: String
    public var logoUrl: String?

    public init(appName: String = "CollectiveUI", welcomeText: String = "", logoEmoji: String = "", logoUrl: String? = nil) {
        self.appName = appName
        self.welcomeText = welcomeText
        self.logoEmoji = logoEmoji
        self.logoUrl = logoUrl
    }

    private enum CodingKeys: String, CodingKey {
        case appName, welcomeText, logoEmoji, logoUrl
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        appName = c.lenient(String.self, .appName) ?? "CollectiveUI"
        welcomeText = c.lenient(String.self, .welcomeText) ?? ""
        logoEmoji = c.lenient(String.self, .logoEmoji) ?? ""
        logoUrl = c.lenient(String.self, .logoUrl)
    }
}

public struct Folder: Decodable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String

    private enum CodingKeys: String, CodingKey {
        case id, name
    }

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        name = c.lenient(String.self, .name) ?? ""
    }
}

public struct TaskActivity: Decodable, Hashable, Sendable {
    public var status: String
    public var unread: Bool

    private enum CodingKeys: String, CodingKey {
        case status, unread
    }

    public init(status: String, unread: Bool) {
        self.status = status
        self.unread = unread
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = c.lenient(String.self, .status) ?? ""
        unread = c.lenient(Bool.self, .unread) ?? false
    }
}

public struct ConversationSummary: Decodable, Hashable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var pinned: Bool
    public var folderId: String?
    public var botId: String?
    public var appId: String?
    public var source: String
    public var isGroup: Bool
    public var isBotHome: Bool
    public var archived: Bool
    public var updatedAt: Date?
    public var taskActivity: TaskActivity?

    public init(
        id: String,
        title: String,
        pinned: Bool = false,
        folderId: String? = nil,
        botId: String? = nil,
        appId: String? = nil,
        source: String = "chat",
        isGroup: Bool = false,
        isBotHome: Bool = false,
        archived: Bool = false,
        updatedAt: Date? = nil,
        taskActivity: TaskActivity? = nil
    ) {
        self.id = id
        self.title = title
        self.pinned = pinned
        self.folderId = folderId
        self.botId = botId
        self.appId = appId
        self.source = source
        self.isGroup = isGroup
        self.isBotHome = isBotHome
        self.archived = archived
        self.updatedAt = updatedAt
        self.taskActivity = taskActivity
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, pinned, folderId, botId, appId, source, isGroup, isBotHome, archived, updatedAt, taskActivity
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        title = c.lenient(String.self, .title) ?? ""
        pinned = c.lenient(Bool.self, .pinned) ?? false
        folderId = c.lenient(String.self, .folderId)
        botId = c.lenient(String.self, .botId)
        appId = c.lenient(String.self, .appId)
        source = c.lenient(String.self, .source) ?? "chat"
        isGroup = c.lenient(Bool.self, .isGroup) ?? false
        isBotHome = c.lenient(Bool.self, .isBotHome) ?? false
        archived = c.lenient(Bool.self, .archived) ?? false
        updatedAt = c.lenientDate(.updatedAt)
        taskActivity = c.lenient(TaskActivity.self, .taskActivity)
    }
}

/// A model connection ("app"), bot, or group that a chat can target.
public struct TargetOption: Decodable, Hashable, Sendable, Identifiable {
    public var kind: String
    public var id: String
    public var name: String
    public var icon: String?
    /// The server's `description` field.
    public var detail: String?
    public var supportsVision: Bool
    public var hermes: Bool
    public var starters: [String]
    public var label: String?
    public var pinned: Bool
    public var coordinator: Bool
    public var hidden: Bool
    public var preview: String?
    public var lastAt: Date?
    public var status: String?
    public var members: [TargetOption]

    public init(kind: String, id: String, name: String, icon: String? = nil, detail: String? = nil, starters: [String] = []) {
        self.kind = kind
        self.id = id
        self.name = name
        self.icon = icon
        self.detail = detail
        self.supportsVision = false
        self.hermes = false
        self.starters = starters
        self.label = nil
        self.pinned = false
        self.coordinator = false
        self.hidden = false
        self.preview = nil
        self.lastAt = nil
        self.status = nil
        self.members = []
    }

    private enum CodingKeys: String, CodingKey {
        case kind, id, name, icon
        case detail = "description"
        case supportsVision, hermes, starters, label, pinned, coordinator, hidden, preview, lastAt, status, members
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.lenient(String.self, .kind) ?? "app"
        id = c.lenient(String.self, .id) ?? ""
        name = c.lenient(String.self, .name) ?? ""
        icon = c.lenient(String.self, .icon)
        detail = c.lenient(String.self, .detail)
        supportsVision = c.lenient(Bool.self, .supportsVision) ?? false
        hermes = c.lenient(Bool.self, .hermes) ?? false
        starters = c.lenient([String].self, .starters) ?? []
        label = c.lenient(String.self, .label)
        pinned = c.lenient(Bool.self, .pinned) ?? false
        coordinator = c.lenient(Bool.self, .coordinator) ?? false
        hidden = c.lenient(Bool.self, .hidden) ?? false
        preview = c.lenient(String.self, .preview)
        lastAt = c.lenientDate(.lastAt)
        status = c.lenient(String.self, .status)
        members = c.lenient([TargetOption].self, .members) ?? []
    }
}

public struct ShellResponse: Decodable, Hashable, Sendable {
    public var user: User?
    public var branding: Branding
    public var conversations: [ConversationSummary]
    public var folders: [Folder]
    public var apps: [TargetOption]
    public var bots: [TargetOption]
    public var inboxUnread: Int

    private enum CodingKeys: String, CodingKey {
        case user, branding, conversations, folders, apps, bots, inboxUnread
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = c.lenient(User.self, .user)
        branding = c.lenient(Branding.self, .branding) ?? Branding()
        conversations = c.lenient([ConversationSummary].self, .conversations) ?? []
        folders = c.lenient([Folder].self, .folders) ?? []
        apps = c.lenient([TargetOption].self, .apps) ?? []
        bots = c.lenient([TargetOption].self, .bots) ?? []
        inboxUnread = c.lenient(Int.self, .inboxUnread) ?? 0
    }
}

public struct BotChatResponse: Decodable, Hashable, Sendable {
    public var conversationId: String
}

// MARK: - Inbox and search

public struct InboxItem: Decodable, Hashable, Sendable, Identifiable {
    public var id: String
    public var kind: String
    public var title: String
    public var body: String?
    public var conversationId: String?
    public var createdAt: Date?
    public var read: Bool

    private enum CodingKeys: String, CodingKey {
        case id, kind, title, body, conversationId, createdAt, read
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        kind = c.lenient(String.self, .kind) ?? ""
        title = c.lenient(String.self, .title) ?? ""
        body = c.lenient(String.self, .body)
        conversationId = c.lenient(String.self, .conversationId)
        createdAt = c.lenientDate(.createdAt)
        read = c.lenient(Bool.self, .read) ?? false
    }
}

public struct InboxResponse: Decodable, Hashable, Sendable {
    public var items: [InboxItem]

    private enum CodingKeys: String, CodingKey {
        case items
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = c.lenient([InboxItem].self, .items) ?? []
    }
}

public struct SearchResult: Decodable, Hashable, Sendable, Identifiable {
    public var conversationId: String
    public var title: String
    public var snippet: String?
    public var updatedAt: Date?

    public var id: String { conversationId }

    private enum CodingKeys: String, CodingKey {
        case conversationId, title, snippet, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = c.lenient(String.self, .conversationId) ?? ""
        title = c.lenient(String.self, .title) ?? ""
        snippet = c.lenient(String.self, .snippet)
        updatedAt = c.lenientDate(.updatedAt)
    }
}

public struct SearchResponse: Decodable, Hashable, Sendable {
    public var results: [SearchResult]

    private enum CodingKeys: String, CodingKey {
        case results
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        results = c.lenient([SearchResult].self, .results) ?? []
    }
}

public struct UploadedFile: Decodable, Hashable, Sendable, Identifiable {
    public var id: String
    public var url: String
    public var filename: String
    public var mediaType: String
    public var readable: Bool

    public init(id: String, url: String, filename: String, mediaType: String, readable: Bool) {
        self.id = id
        self.url = url
        self.filename = filename
        self.mediaType = mediaType
        self.readable = readable
    }

    private enum CodingKeys: String, CodingKey {
        case id, url, filename, mediaType, readable
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        url = c.lenient(String.self, .url) ?? "/api/files/\(id)"
        filename = c.lenient(String.self, .filename) ?? "file"
        mediaType = c.lenient(String.self, .mediaType) ?? "application/octet-stream"
        readable = c.lenient(Bool.self, .readable) ?? false
    }
}

// MARK: - Conversation snapshot

public struct SnapshotSummary: Decodable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var botId: String?
    public var appId: String?
    public var isBotHome: Bool
    public var isGroup: Bool
    public var source: String
    public var pinned: Bool
    public var folderId: String?
    public var archived: Bool
    public var updatedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case id, title, botId, appId, isBotHome, isGroup, source, pinned, folderId, archived, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        title = c.lenient(String.self, .title) ?? ""
        botId = c.lenient(String.self, .botId)
        appId = c.lenient(String.self, .appId)
        isBotHome = c.lenient(Bool.self, .isBotHome) ?? false
        isGroup = c.lenient(Bool.self, .isGroup) ?? false
        source = c.lenient(String.self, .source) ?? "chat"
        pinned = c.lenient(Bool.self, .pinned) ?? false
        folderId = c.lenient(String.self, .folderId)
        archived = c.lenient(Bool.self, .archived) ?? false
        updatedAt = c.lenientDate(.updatedAt)
    }
}

public struct RunInfo: Decodable, Hashable, Sendable {
    public var id: String
    public var status: String
    public var segment: JSONValue?

    private enum CodingKeys: String, CodingKey {
        case id, status, segment
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, .id) ?? ""
        status = c.lenient(String.self, .status) ?? ""
        segment = c.lenient(JSONValue.self, .segment)
    }
}

public struct MessageRow: Decodable, Hashable, Sendable, Identifiable {
    public var id: String
    public var parentId: String?
    /// Epoch milliseconds.
    public var createdAt: Double?
    public var feedback: Int?
    public var message: UIMessage

    public init(id: String, parentId: String?, createdAt: Double? = nil, feedback: Int? = nil, message: UIMessage) {
        self.id = id
        self.parentId = parentId
        self.createdAt = createdAt
        self.feedback = feedback
        self.message = message
    }

    private enum CodingKeys: String, CodingKey {
        case id, parentId, createdAt, feedback, message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let decodedMessage = c.lenient(UIMessage.self, .message)
        let rowId = c.lenient(String.self, .id) ?? decodedMessage?.id ?? ""
        id = rowId
        parentId = c.lenient(String.self, .parentId)
        createdAt = c.lenient(Double.self, .createdAt)
        feedback = c.lenient(Int.self, .feedback)
        message = decodedMessage ?? UIMessage(id: rowId, role: .assistant, parts: [])
    }
}

public struct ConversationSnapshot: Decodable, Hashable, Sendable {
    public var summary: SnapshotSummary?
    public var run: RunInfo?
    public var conversationId: String
    public var isBotHome: Bool
    public var unavailable: Bool
    public var unavailableReason: String?
    public var target: TargetOption?
    public var initialRows: [MessageRow]
    public var initialLeafId: String?
    public var resume: Bool

    private enum CodingKeys: String, CodingKey {
        case summary, run, conversationId, isBotHome, unavailable, unavailableReason, target, initialRows, initialLeafId, resume
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        summary = c.lenient(SnapshotSummary.self, .summary)
        run = c.lenient(RunInfo.self, .run)
        conversationId = c.lenient(String.self, .conversationId) ?? summary?.id ?? ""
        isBotHome = c.lenient(Bool.self, .isBotHome) ?? summary?.isBotHome ?? false
        unavailable = c.lenient(Bool.self, .unavailable) ?? false
        unavailableReason = c.lenient(String.self, .unavailableReason)
        target = c.lenient(TargetOption.self, .target)
        initialRows = c.lenient([MessageRow].self, .initialRows) ?? []
        initialLeafId = c.lenient(String.self, .initialLeafId)
        resume = c.lenient(Bool.self, .resume) ?? false
    }

    /// The messages on the path from the root to `initialLeafId`.
    public func displayedThread() -> [UIMessage] {
        return MessageThread.path(rows: initialRows, leafId: initialLeafId).map { $0.message }
    }
}

public enum MessageThread {
    /// Walks from `leafId` up through `parentId` links and returns root-first order.
    /// Falls back to the newest row when the leaf is missing or unknown.
    public static func path(rows: [MessageRow], leafId: String?) -> [MessageRow] {
        guard !rows.isEmpty else { return [] }
        var byId: [String: MessageRow] = [:]
        for row in rows where byId[row.id] == nil {
            byId[row.id] = row
        }
        var cursor: String? = nil
        if let leafId, byId[leafId] != nil {
            cursor = leafId
        } else {
            var newest: MessageRow? = nil
            for row in rows {
                if let current = newest {
                    if (row.createdAt ?? 0) >= (current.createdAt ?? 0) {
                        newest = row
                    }
                } else {
                    newest = row
                }
            }
            cursor = newest?.id
        }
        var result: [MessageRow] = []
        var seen = Set<String>()
        while let id = cursor, let row = byId[id], !seen.contains(id) {
            seen.insert(id)
            result.append(row)
            cursor = row.parentId
        }
        return Array(result.reversed())
    }
}

// MARK: - Sidebar grouping

public struct ConversationSection: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let conversations: [ConversationSummary]

    public init(id: String, title: String, conversations: [ConversationSummary]) {
        self.id = id
        self.title = title
        self.conversations = conversations
    }
}

public enum ConversationGrouping {
    /// Groups conversations into Pinned / Today / Yesterday / Previous 7 Days / Older, keeping input order.
    public static func sections(
        for conversations: [ConversationSummary],
        now: Date = Date(),
        calendar: Calendar = Calendar.current
    ) -> [ConversationSection] {
        let startOfToday = calendar.startOfDay(for: now)
        let startOfYesterday = calendar.date(byAdding: .day, value: -1, to: startOfToday) ?? startOfToday
        let startOfWeek = calendar.date(byAdding: .day, value: -7, to: startOfToday) ?? startOfToday

        var pinned: [ConversationSummary] = []
        var today: [ConversationSummary] = []
        var yesterday: [ConversationSummary] = []
        var week: [ConversationSummary] = []
        var older: [ConversationSummary] = []

        for conversation in conversations {
            if conversation.pinned {
                pinned.append(conversation)
                continue
            }
            let date = conversation.updatedAt ?? Date.distantPast
            if date >= startOfToday {
                today.append(conversation)
            } else if date >= startOfYesterday {
                yesterday.append(conversation)
            } else if date >= startOfWeek {
                week.append(conversation)
            } else {
                older.append(conversation)
            }
        }

        var sections: [ConversationSection] = []
        if !pinned.isEmpty {
            sections.append(ConversationSection(id: "pinned", title: "Pinned", conversations: pinned))
        }
        if !today.isEmpty {
            sections.append(ConversationSection(id: "today", title: "Today", conversations: today))
        }
        if !yesterday.isEmpty {
            sections.append(ConversationSection(id: "yesterday", title: "Yesterday", conversations: yesterday))
        }
        if !week.isEmpty {
            sections.append(ConversationSection(id: "week", title: "Previous 7 Days", conversations: week))
        }
        if !older.isEmpty {
            sections.append(ConversationSection(id: "older", title: "Older", conversations: older))
        }
        return sections
    }
}
