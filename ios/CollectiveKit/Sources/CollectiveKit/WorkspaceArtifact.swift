import Foundation

public struct WorkspaceArtifact: Equatable, Sendable {
    public let path: String
    public let instanceId: String?

    public static func parse(toolName: String, output: JSONValue?) -> WorkspaceArtifact? {
        guard ["workspace_write", "workspace_edit", "workspace_read"].contains(toolName),
              case .object(let fields) = output,
              fields["ok"] == .bool(true), case .string(let raw) = fields["path"],
              let path = normalizePath(raw) else { return nil }
        let instanceId: String?
        if let value = fields["instanceId"], value != .null {
            guard case .string(let id) = value, isValidInstanceID(id) else { return nil }
            instanceId = id
        } else {
            instanceId = nil
        }
        return WorkspaceArtifact(path: path, instanceId: instanceId)
    }

    static func isValidInstanceID(_ value: String) -> Bool {
        (8...64).contains(value.utf8.count) && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }

    public static func normalizePath(_ raw: String) -> String? {
        let prefix = "/home/agent/workspace/"
        let path = raw.hasPrefix(prefix) ? String(raw.dropFirst(prefix.count)) : raw
        guard !raw.isEmpty, raw.utf16.count <= 1024, !path.hasPrefix("/"), !path.contains("\\"),
              !raw.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              path.range(of: "^[a-z]:", options: [.regularExpression, .caseInsensitive]) == nil
        else { return nil }
        var segments: [Substring] = []
        for segment in path.split(separator: "/") {
            if segment == "." { continue }
            if segment == ".." {
                guard !segments.isEmpty else { return nil }
                segments.removeLast()
            } else { segments.append(segment) }
        }
        return segments.isEmpty ? nil : segments.joined(separator: "/")
    }
}

extension APIClient {
    /// Fetch with the app's bearer token; never hand an authenticated relative link to Safari.
    public func workspaceFile(path: String, instanceId: String? = nil) async throws -> Data {
        guard let path = WorkspaceArtifact.normalizePath(path) else { throw APIError.invalidURL }
        var query = [URLQueryItem(name: "path", value: path)]
        if let instanceId {
            guard WorkspaceArtifact.isValidInstanceID(instanceId) else { throw APIError.invalidURL }
            query.append(URLQueryItem(name: "instanceId", value: instanceId))
        }
        let request = try makeRequest("/api/workspace/files", query: query)
        let (data, _) = try await perform(request)
        guard data.count <= 10 * 1024 * 1024 else { throw APIError.invalidResponse }
        return data
    }
}
