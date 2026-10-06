import Foundation
import Observation
import CryptoKit
import CollectiveKit

struct StoppedReply: Codable, Equatable {
    var messageId: String
    let parentId: String
}

/// Shared by reconstructed chat models. Upload callbacks keep updating this same draft.
@MainActor
@Observable
final class ConversationState {
    var text = "" { didSet { saveLater() } }
    var attachments: [ComposerAttachment] = [] { didSet { saveLater() } }
    var stoppedReplies: [StoppedReply] = [] { didSet { saveLater() } }
    @ObservationIgnored var save: (() -> Void)?
    @ObservationIgnored private var saveTask: Task<Void, Never>?

    private func saveLater() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }

    func flush() {
        saveTask?.cancel()
        saveTask = nil
        save?()
    }

    func markStopped(messageId: String, parentId: String) {
        stoppedReplies.removeAll { $0.parentId == parentId }
        stoppedReplies.append(StoppedReply(messageId: messageId, parentId: parentId))
        flush()
    }

    /// Match a locally stopped reply to the server's authoritative message identity.
    /// If no assistant was saved yet, keep a small local row after that exact user message.
    func reconcileStoppedReplies(in thread: [UIMessage]) -> [UIMessage] {
        var result = thread
        for index in stoppedReplies.indices.reversed() {
            let stopped = stoppedReplies[index]
            guard let parent = result.firstIndex(where: { $0.id == stopped.parentId }) else { continue }
            let next = parent + 1
            if next < result.count, result[next].role == .assistant {
                if stoppedReplies[index].messageId != result[next].id {
                    if stopped.messageId.hasPrefix("stopped-") {
                        stoppedReplies[index].messageId = result[next].id
                    } else {
                        // A different server message is a replacement reply, such as a
                        // regeneration from another client, not the locally stopped turn.
                        stoppedReplies.remove(at: index)
                    }
                }
            } else {
                result.insert(UIMessage(id: stopped.messageId, role: .assistant), at: next)
            }
        }
        return result
    }

    func showsStoppedPlaceholder(for message: UIMessage) -> Bool {
        message.role == .assistant && !message.hasVisibleContent && stoppedReplies.contains { $0.messageId == message.id }
    }

    func preventsResume(in thread: [UIMessage]) -> Bool {
        guard let user = thread.last(where: { $0.role == .user }) else { return false }
        return stoppedReplies.contains { $0.parentId == user.id }
    }
}

/// Drafts are stored separately for each server and credential session. No token is written
/// into a file or its name. Demo fixtures use their own scope and never restore real drafts.
@MainActor
final class ConversationStateStore {
    private struct Saved: Codable {
        var text: String
        var attachments: [ComposerAttachment]
        var stoppedReplies: [StoppedReply]
    }
    private let directory: URL?
    private var states: [String: ConversationState] = [:]
    private var isValid = true

    init(server: URL?, token: String?, root: URL? = ConversationStateStore.defaultRoot) {
        if let server, let token, let root {
            directory = root.appendingPathComponent(Self.digest(server.absoluteString + "\0" + token), isDirectory: true)
        } else { directory = nil }
    }

    nonisolated static var defaultRoot: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("ChatDrafts", isDirectory: true)
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func file(for id: String) -> URL? { directory?.appendingPathComponent(Self.digest(id) + ".json") }

    func state(for conversationId: String) -> ConversationState {
        if let state = states[conversationId] { return state }
        let state = ConversationState()
        if let file = file(for: conversationId), let data = try? Data(contentsOf: file),
           let saved = try? JSONDecoder().decode(Saved.self, from: data) {
            state.text = saved.text
            state.attachments = saved.attachments.map { attachment in
                var restored = attachment
                if restored.isUploading { restored.errorText = "Upload interrupted. Remove the file and attach it again." }
                return restored
            }
            state.stoppedReplies = saved.stoppedReplies
        }
        state.save = { [weak self, weak state] in
            guard let self, self.isValid, let state, let file = self.file(for: conversationId), let directory = self.directory else { return }
            let saved = Saved(text: state.text, attachments: state.attachments, stoppedReplies: state.stoppedReplies)
            guard let data = try? JSONEncoder().encode(saved) else { return }
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                var protectedDirectory = directory
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try protectedDirectory.setResourceValues(values)
                try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            } catch { /* In-memory drafts still survive navigation if storage is unavailable. */ }
        }
        states[conversationId] = state
        return state
    }

    func flush() { states.values.forEach { $0.flush() } }

    func remove(_ conversationId: String) {
        states.removeValue(forKey: conversationId)?.save = nil
        if let file = file(for: conversationId) { try? FileManager.default.removeItem(at: file) }
    }

    func clear() {
        isValid = false
        for state in states.values {
            state.save = nil
            state.text = ""
            state.attachments = []
            state.stoppedReplies = []
        }
        states = [:]
        if let directory { try? FileManager.default.removeItem(at: directory) }
    }
}
