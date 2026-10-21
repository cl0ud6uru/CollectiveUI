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
    var isEstablished = false { didSet { saveLater() } }
    var newChatTarget: TargetOption? { didSet { saveLater() } }
    var text = "" { didSet { saveLater() } }
    var attachments: [ComposerAttachment] = [] { didSet { saveLater() } }
    var stoppedReplies: [StoppedReply] = [] { didSet { saveLater() } }
    var pendingSubmission: PendingChatSubmission? { didSet { saveLater() } }
    var pendingCommand: PendingCommandAttempt? { didSet { saveLater() } }
    var requiresStatusCheck = false { didSet { saveLater() } }
    enum PersistenceIssue: Equatable {
        case unavailable, writeFailed, readFailed

        var message: String {
            switch self {
            case .unavailable, .writeFailed:
                return "Couldn't save this draft on this device. Your text is still in this window. Keep the app open and retry saving before sending."
            case .readFailed:
                return "Couldn't read the saved draft. Sending is paused to protect it. If you've typed new text, copy it and clear the composer before retrying."
            }
        }
    }
    fileprivate(set) var persistenceIssue: PersistenceIssue?
    @ObservationIgnored var save: (() -> Bool)?
    @ObservationIgnored var reload: (() -> Bool)?
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    // A Stop acknowledgement belongs to a turn, even after its view detaches.
    @ObservationIgnored var stopOperation: UUID?

    private func saveLater() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }

    @discardableResult
    func flush() -> Bool {
        saveTask?.cancel()
        saveTask = nil
        return save?() ?? false
    }

    @discardableResult
    func retryPersistence() -> Bool {
        if persistenceIssue == .readFailed { return reload?() ?? false }
        return flush()
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
@Observable
final class ConversationStateStore {
    private struct Saved: Codable {
        var isEstablished: Bool?
        var conversationId: String?
        var newChatTarget: TargetOption?
        var text: String
        var attachments: [ComposerAttachment]
        var stoppedReplies: [StoppedReply]
        var pendingSubmission: PendingChatSubmission?
        var pendingCommand: PendingCommandAttempt?
        var requiresStatusCheck: Bool?
    }
    private(set) var recoverableIDs: [String] = []
    private let directory: URL?
    private var states: [String: ConversationState] = [:]
    private var isValid = true

    init(server: URL?, token: String?, root: URL? = ConversationStateStore.defaultRoot) {
        if let server, let token, let root {
            directory = root.appendingPathComponent(Self.digest(server.absoluteString + "\0" + token), isDirectory: true)
        } else { directory = nil }
        if let directory, let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            recoverableIDs = files.compactMap { file in
                guard let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data),
                      saved.pendingSubmission != nil || saved.pendingCommand != nil || saved.requiresStatusCheck == true ||
                      !saved.text.isEmpty || !saved.attachments.isEmpty else { return nil }
                return saved.conversationId
            }.sorted()
        }
    }

    nonisolated static var defaultRoot: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent(draftDirectoryName, isDirectory: true)
    }

    nonisolated private static var draftDirectoryName: String {
        #if os(macOS)
        "io.collectiveui.macos/ChatDrafts"
        #else
        "ChatDrafts"
        #endif
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func file(for id: String) -> URL? { directory?.appendingPathComponent(Self.digest(id) + ".json") }

    func state(for conversationId: String) -> ConversationState {
        if let state = states[conversationId] { return state }
        let state = ConversationState()
        if let file = file(for: conversationId) {
            do {
                let data = try Data(contentsOf: file)
                restore(try JSONDecoder().decode(Saved.self, from: data), into: state)
            } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                // A genuinely new conversation has no local draft yet.
            } catch {
                state.persistenceIssue = .readFailed
            }
        } else {
            state.persistenceIssue = .unavailable
        }
        state.reload = { [weak self, weak state] in
            guard let self, self.isValid, let state, let file = self.file(for: conversationId),
                  state.text.isEmpty, state.attachments.isEmpty,
                  state.pendingSubmission == nil, state.pendingCommand == nil else { return false }
            do {
                let saved = try JSONDecoder().decode(Saved.self, from: Data(contentsOf: file))
                self.restore(saved, into: state)
                state.persistenceIssue = nil
                return state.flush()
            } catch {
                state.persistenceIssue = .readFailed
                return false
            }
        }
        state.save = { [weak self, weak state] in
            guard let self, self.isValid, let state else { return false }
            self.updateRecoverableID(conversationId, state: state)
            // Never replace an unreadable file: it may contain an admitted request's identity.
            guard state.persistenceIssue != .readFailed else { return false }
            guard let file = self.file(for: conversationId), let directory = self.directory else {
                state.persistenceIssue = .unavailable
                return false
            }
            let saved = Saved(isEstablished: state.isEstablished, conversationId: conversationId, newChatTarget: state.newChatTarget, text: state.text, attachments: state.attachments, stoppedReplies: state.stoppedReplies,
                pendingSubmission: state.pendingSubmission, pendingCommand: state.pendingCommand, requiresStatusCheck: state.requiresStatusCheck)
            do {
                let data = try JSONEncoder().encode(saved)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                var protectedDirectory = directory
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try protectedDirectory.setResourceValues(values)
                #if os(iOS)
                try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                #else
                // macOS uses owner-only permissions, with FileVault providing disk encryption.
                try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
                try data.write(to: file, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                #endif
                state.persistenceIssue = nil
                return true
            } catch {
                state.persistenceIssue = .writeFailed
                return false
            }
        }
        states[conversationId] = state
        return state
    }

    private func restore(_ saved: Saved, into state: ConversationState) {
        state.isEstablished = state.isEstablished || saved.isEstablished == true
        state.newChatTarget = state.isEstablished ? nil : saved.newChatTarget
        state.text = saved.text
        state.attachments = saved.attachments.map { attachment in
            var restored = attachment
            if restored.isUploading { restored.errorText = "Upload interrupted. Remove the file and attach it again." }
            return restored
        }
        state.stoppedReplies = saved.stoppedReplies
        state.pendingSubmission = saved.pendingSubmission
        state.pendingCommand = saved.pendingCommand
        // A retained request is unresolved even if an older/inconsistent flag says otherwise.
        state.requiresStatusCheck = saved.requiresStatusCheck == true || saved.pendingSubmission != nil
    }

    private func updateRecoverableID(_ id: String, state: ConversationState) {
        let hasDraft = !state.text.isEmpty || !state.attachments.isEmpty || state.pendingSubmission != nil ||
            state.pendingCommand != nil || state.requiresStatusCheck
        if hasDraft && !recoverableIDs.contains(id) { recoverableIDs.append(id) }
        if !hasDraft { recoverableIDs.removeAll { $0 == id } }
    }

    func flush() { states.values.forEach { $0.flush() } }

    func remove(_ conversationId: String) {
        recoverableIDs.removeAll { $0 == conversationId }
        if let state = states.removeValue(forKey: conversationId) {
            state.save = nil
            state.reload = nil
        }
        if let file = file(for: conversationId) { try? FileManager.default.removeItem(at: file) }
    }

    func clear() {
        isValid = false
        recoverableIDs = []
        for state in states.values {
            state.save = nil
            state.reload = nil
            state.persistenceIssue = nil
            state.isEstablished = false
            state.newChatTarget = nil
            state.text = ""
            state.attachments = []
            state.stoppedReplies = []
            state.pendingSubmission = nil
            state.pendingCommand = nil
            state.requiresStatusCheck = false
        }
        states = [:]
        if let directory { try? FileManager.default.removeItem(at: directory) }
    }
}
