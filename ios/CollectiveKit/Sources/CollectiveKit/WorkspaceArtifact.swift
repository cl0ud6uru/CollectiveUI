import Foundation

public enum WorkspaceArtifact {
    public static func path(toolName: String, output: JSONValue?) -> String? {
        guard ["workspace_write", "workspace_edit", "workspace_read"].contains(toolName),
              case .object(let fields) = output,
              fields["ok"] == .bool(true), case .string(let raw) = fields["path"] else { return nil }
        return normalizePath(raw)
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
    public func workspaceFile(path: String) async throws -> Data {
        guard let path = WorkspaceArtifact.normalizePath(path) else { throw APIError.invalidURL }
        let request = try makeRequest("/api/workspace/files", query: [URLQueryItem(name: "path", value: path)])
        let (data, _) = try await perform(request)
        guard data.count <= 10 * 1024 * 1024 else { throw APIError.invalidResponse }
        return data
    }
}
