import Foundation

/// A current-role decision, separate from cached shell identity. Validation is
/// fail-closed, and only the newest request for the current login may complete.
public struct SettingsSessionAccess: Sendable {
    public private(set) var generation = UUID()
    public private(set) var isAdmin = false
    public private(set) var isValidated = false
    public private(set) var isValidating = false
    /// Pending checks block new opens, but do not revoke an existing browser/path.
    public var shouldDismissAdminDestinations: Bool { !isValidating && !isAdmin }
    private var request: UUID?
    public init() {}

    public mutating func invalidate() { self = Self() }
    public mutating func beginValidation() -> UUID {
        isAdmin = false
        isValidated = false
        isValidating = true
        let next = UUID()
        request = next
        return next
    }
    @discardableResult
    public mutating func completeValidation(isAdmin: Bool, generation: UUID, request: UUID) -> Bool {
        guard self.generation == generation, self.request == request else { return false }
        self.isAdmin = isAdmin
        isValidated = true
        isValidating = false
        self.request = nil
        return true
    }
    @discardableResult
    public mutating func failValidation(generation: UUID, request: UUID) -> Bool {
        guard self.generation == generation, self.request == request else { return false }
        isAdmin = false
        isValidated = false
        isValidating = false
        self.request = nil
        return true
    }
}

/// Fixed website destinations, never an arbitrary redirect supplied by a server.
/// Browser login and server-side authorization remain independent of the native token.
public enum SettingsDestination: String, CaseIterable, Identifiable, Sendable {
    case general, security, personalization, memory, approvals, connectedAccounts, workspace, dataControls
    case usage, connections, managedHermes, groups, users, bots, pets, tools, mcp, sandboxes, activity, organization

    public var id: String { rawValue }
    public var isAdminOnly: Bool { Self.allCases.firstIndex(of: self)! >= Self.allCases.firstIndex(of: .usage)! }
    public static func available(isAdmin: Bool) -> [Self] { allCases.filter { isAdmin || !$0.isAdminOnly } }

    public var title: String {
        switch self {
        case .general: "General"
        case .security: "Security"
        case .personalization: "Personalization"
        case .memory: "Memory"
        case .approvals: "Approvals"
        case .connectedAccounts: "Connected accounts"
        case .workspace: "Workspace"
        case .dataControls: "Data controls"
        case .usage: "Usage"
        case .connections: "Connections"
        case .managedHermes: "Managed Hermes"
        case .groups: "Groups"
        case .users: "Users"
        case .bots: "Bots"
        case .pets: "Pets"
        case .tools: "Bots & tools"
        case .mcp: "MCP servers"
        case .sandboxes: "Workspaces"
        case .activity: "Activity"
        case .organization: "Organization settings"
        }
    }

    public var symbol: String {
        switch self {
        case .general, .organization: "slider.horizontal.3"
        case .security: "lock.shield"
        case .personalization: "text.alignleft"
        case .memory: "brain"
        case .approvals: "checkmark.shield"
        case .connectedAccounts, .connections: "link"
        case .workspace, .sandboxes: "terminal"
        case .dataControls: "archivebox"
        case .usage: "chart.bar"
        case .managedHermes, .bots: "square.grid.2x2"
        case .groups: "person.3"
        case .users: "person.2"
        case .pets: "pawprint"
        case .tools: "wrench.and.screwdriver"
        case .mcp: "network"
        case .activity: "waveform.path"
        }
    }

    public var detail: String {
        switch self {
        case .general: "Default chat target and website preferences"
        case .security: "Passkeys, two-factor authentication and sessions"
        case .personalization: "Custom instructions for your conversations"
        case .memory: "Review, pin and remove saved memories"
        case .approvals: "Review and revoke always-allowed tools"
        case .connectedAccounts: "ChatGPT plans, personal and remote Hermes"
        case .workspace: "Files and personal workspace controls"
        case .dataControls: "Archived chats, history and data management"
        case .usage: "Organization usage and reporting"
        case .connections: "Model providers and connections"
        case .managedHermes: "Enrollment and managed Hermes instances"
        case .groups: "Group membership and access policies"
        case .users: "User accounts and organization access"
        case .bots: "Manage the organization's bots"
        case .pets: "Pet catalog and appearance"
        case .tools: "Bot capabilities and tool policies"
        case .mcp: "Manage MCP server connections"
        case .sandboxes: "Organization workspaces and sandboxes"
        case .activity: "Organization activity and audit history"
        case .organization: "Branding, defaults and organization policies"
        }
    }

    public var path: String {
        switch self {
        case .usage: "/admin"
        case .connections: "/admin/apps"
        case .managedHermes: "/admin/hermes"
        case .groups: "/admin/groups"
        case .users: "/admin/users"
        case .bots: "/admin/bots"
        case .pets: "/admin/pets"
        case .tools: "/admin/tools"
        case .mcp: "/admin/mcp"
        case .sandboxes: "/admin/sandboxes"
        case .activity: "/admin/activity"
        case .organization: "/admin/settings"
        default: "/settings"
        }
    }

    private var tab: String {
        switch self {
        case .connectedAccounts: "connected-accounts"
        case .dataControls: "data-controls"
        default: rawValue
        }
    }

    public func url(server: URL, isAdmin: Bool) -> URL? {
        guard !isAdminOnly || isAdmin,
              let base = URLComponents(url: server, resolvingAgainstBaseURL: false),
              ["https", "http"].contains(base.scheme?.lowercased() ?? ""),
              let host = base.host, !host.isEmpty,
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              !base.percentEncodedPath.lowercased().contains("%2f"),
              !base.percentEncodedPath.lowercased().contains("%5c"),
              !base.path.contains("\\"),
              !base.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        var components = URLComponents(url: server.appendingPathComponent(String(path.dropFirst())), resolvingAgainstBaseURL: false)
        components?.queryItems = isAdminOnly ? nil : [URLQueryItem(name: "tab", value: tab)]
        return components?.url
    }
}
