import Foundation
import Observation
import SwiftUI
import UIKit
import CollectiveKit

enum AppPhase: Equatable {
    case setup
    case signIn
    case main
}

/// What the detail column shows.
enum ChatRoute: Hashable {
    case conversation(String)
    case newChat(conversationId: String, target: TargetOption)
    case bot(botId: String, kind: String, nonce: String)
}

struct Banner: Identifiable, Equatable {
    let id = UUID()
    let text: String
    let isError: Bool
}

@MainActor
@Observable
final class AppModel {
    private(set) var serverURL: URL? = nil
    private(set) var serverInfo: MobileInfo? = nil
    private(set) var token: String? = nil
    private(set) var api: APIClient? = nil

    var shell: ShellResponse? = nil
    var shellError: String? = nil
    var sessionInfo: SessionInfo? = nil
    var selection: ChatRoute? = nil
    var banner: Banner? = nil
    var isSigningIn: Bool = false

    private let authenticator: WebAuthenticator
    /// Custom URLSession for every API client (used by the debug demo mode); nil uses the shared session.
    private let sessionOverride: URLSession?

    private enum Keys {
        static let token = "token"
        static let baseURL = "baseURL"
        static let lastServerAddress = "lastServerAddress"
    }

    init() {
        authenticator = WebAuthenticator()
        #if DEBUG
        if DemoMode.isEnabled {
            sessionOverride = DemoMode.session
            configureDemo()
            return
        }
        #endif
        sessionOverride = nil
        let stored = KeychainStore.string(for: Keys.baseURL) ?? UserDefaults.standard.string(forKey: Keys.baseURL)
        if let stored, let url = APIClient.normalizeBaseURL(stored) {
            serverURL = url
            token = KeychainStore.string(for: Keys.token)
        }
        rebuildClient()
    }

    var phase: AppPhase {
        if serverURL == nil {
            return .setup
        }
        if token == nil {
            return .signIn
        }
        return .main
    }

    var lastServerAddress: String? {
        return UserDefaults.standard.string(forKey: Keys.lastServerAddress)
    }

    var appName: String {
        if let name = shell?.branding.appName, !name.isEmpty {
            return name
        }
        if let name = serverInfo?.appName, !name.isEmpty {
            return name
        }
        return "CollectiveUI"
    }

    var bots: [TargetOption] {
        return (shell?.bots ?? []).filter { !$0.hidden }
    }

    var apps: [TargetOption] {
        return shell?.apps ?? []
    }

    /// Chats shown in the sidebar: everything except bot home chats and archived ones.
    var chatConversations: [ConversationSummary] {
        return (shell?.conversations ?? []).filter { !$0.isBotHome && !$0.archived }
    }

    var inboxUnread: Int {
        return shell?.inboxUnread ?? 0
    }

    /// Client without a token, for the public endpoints used before sign-in.
    private func publicClient(_ url: URL) -> APIClient {
        return APIClient(baseURL: url, session: sessionOverride)
    }

    private func rebuildClient() {
        guard let serverURL else {
            api = nil
            return
        }
        // AppModel lives as long as the app, so a strong reference here is fine.
        let model = self
        api = APIClient(baseURL: serverURL, token: token, session: sessionOverride, onUnauthorized: {
            Task { @MainActor in
                model.handleUnauthorized()
            }
        })
    }

    // MARK: - Server setup

    func checkServer(_ input: String) async throws -> (URL, MobileInfo) {
        guard let url = APIClient.normalizeBaseURL(input) else {
            throw APIError.invalidURL
        }
        let info = try await publicClient(url).mobileInfo()
        return (url, info)
    }

    func useServer(_ url: URL, info: MobileInfo) {
        serverURL = url
        serverInfo = info
        KeychainStore.set(url.absoluteString, for: Keys.baseURL)
        UserDefaults.standard.set(url.absoluteString, forKey: Keys.baseURL)
        UserDefaults.standard.set(url.absoluteString, forKey: Keys.lastServerAddress)
        rebuildClient()
    }

    func changeServer() {
        KeychainStore.remove(Keys.baseURL)
        KeychainStore.remove(Keys.token)
        UserDefaults.standard.removeObject(forKey: Keys.baseURL)
        serverURL = nil
        serverInfo = nil
        token = nil
        shell = nil
        selection = nil
        rebuildClient()
    }

    func loadServerInfoIfNeeded() async {
        guard serverInfo == nil, let serverURL else { return }
        do {
            serverInfo = try await publicClient(serverURL).mobileInfo()
        } catch {
            // The sign-in button still works; the info is only cosmetic here.
        }
    }

    // MARK: - Sign in / out

    func signIn() async {
        guard let serverURL, !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }

        do {
            let info = try await publicClient(serverURL).mobileInfo()
            serverInfo = info
            if !info.enabled {
                showBanner("Mobile sign-in is turned off on this server. Ask your administrator to set MOBILE_APP_ENABLED=true.", isError: true)
                return
            }
        } catch {
            showBanner(error.localizedDescription, isError: true)
            return
        }

        let verifier = PKCE.makeVerifier()
        let challenge = PKCE.challenge(for: verifier)
        let state = PKCE.makeState()
        let deviceName = UIDevice.current.name
        guard let authorizeURL = MobileAuth.authorizeURL(baseURL: serverURL, challenge: challenge, state: state, deviceName: deviceName) else {
            showBanner("Couldn't build the sign-in address.", isError: true)
            return
        }

        do {
            let callback = try await authenticator.authenticate(url: authorizeURL, callbackScheme: MobileAuth.callbackScheme)
            switch MobileAuth.parseCallback(callback, expectedState: state) {
            case .code(let code):
                let response = try await publicClient(serverURL).exchangeToken(code: code, codeVerifier: verifier)
                KeychainStore.set(response.token, for: Keys.token)
                KeychainStore.set(serverURL.absoluteString, for: Keys.baseURL)
                token = response.token
                shell = nil
                selection = nil
                rebuildClient()
                await refreshShell()
            case .denied:
                showBanner("Sign-in was not approved.", isError: true)
            case .invalid(let message):
                showBanner(message, isError: true)
            }
        } catch {
            if WebAuthenticator.isUserCancellation(error) {
                return
            }
            showBanner(error.localizedDescription, isError: true)
        }
    }

    func signOut() async {
        if let api, token != nil {
            do {
                try await api.revokeSession()
            } catch {
                // Ignore: the local session is wiped regardless.
            }
        }
        clearSession()
    }

    private func clearSession() {
        KeychainStore.remove(Keys.token)
        token = nil
        shell = nil
        sessionInfo = nil
        selection = nil
        rebuildClient()
    }

    func handleUnauthorized() {
        #if DEBUG
        if DemoMode.isEnabled {
            return
        }
        #endif
        guard token != nil else { return }
        clearSession()
        showBanner("Your session has ended. Please sign in again.", isError: true)
    }

    // MARK: - Data

    func refreshShell() async {
        guard let api, token != nil else { return }
        do {
            let fresh = try await api.shell()
            shell = fresh
            shellError = nil
        } catch {
            if error.isUnauthorized || error.isCancellation {
                return
            }
            shellError = error.localizedDescription
        }
    }

    func loadSessionInfo() async {
        guard let api, token != nil else { return }
        do {
            sessionInfo = try await api.currentSession()
        } catch {
            // Settings shows what it has.
        }
    }

    func startNewChat(with target: TargetOption) {
        selection = .newChat(conversationId: IDGenerator.make(), target: target)
    }

    func openConversation(_ id: String) {
        selection = .conversation(id)
    }

    func setPinned(_ conversation: ConversationSummary, pinned: Bool) async {
        await mutateConversation { api in
            try await api.updateConversation(id: conversation.id, pinned: pinned)
        }
    }

    func archive(_ conversation: ConversationSummary) async {
        deselect(conversation.id)
        await mutateConversation { api in
            try await api.updateConversation(id: conversation.id, archived: true)
        }
    }

    func rename(_ conversation: ConversationSummary, to title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await mutateConversation { api in
            try await api.updateConversation(id: conversation.id, title: trimmed)
        }
    }

    func delete(_ conversation: ConversationSummary) async {
        deselect(conversation.id)
        await mutateConversation { api in
            try await api.deleteConversation(id: conversation.id)
        }
    }

    private func deselect(_ conversationId: String) {
        if case .conversation(let selectedId)? = selection, selectedId == conversationId {
            selection = nil
        }
    }

    private func mutateConversation(_ operation: (APIClient) async throws -> Void) async {
        guard let api else { return }
        do {
            try await operation(api)
        } catch {
            if !error.isUnauthorized && !error.isCancellation {
                showBanner(error.localizedDescription, isError: true)
            }
        }
        await refreshShell()
    }

    #if DEBUG
    /// Demo mode starts signed in against the in-memory demo server (or on the signed-out screens).
    private func configureDemo() {
        DemoServer.shared.install(chartPNG: DemoArt.chartPNG(), petV1: DemoArt.petAtlasPNG(version: 1), petV2: DemoArt.petAtlasPNG(version: 2))
        switch DemoMode.screen {
        case "setup":
            serverURL = nil
            token = nil
        case "signin":
            serverURL = DemoMode.baseURL
            serverInfo = DemoMode.info
            token = nil
        default:
            serverURL = DemoMode.baseURL
            serverInfo = DemoMode.info
            token = DemoMode.token
        }
        rebuildClient()
    }
    #endif

    // MARK: - Banner

    func showBanner(_ text: String, isError: Bool = false) {
        banner = Banner(text: text, isError: isError)
    }
}
