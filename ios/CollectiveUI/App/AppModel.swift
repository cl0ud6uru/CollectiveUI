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
    private(set) var settingsAccess = SettingsSessionAccess()
    var selection: ChatRoute? = nil
    var banner: Banner? = nil
    var isSigningIn: Bool = false

    let liveActivities = LiveActivityCoordinator()

    private let authenticator: WebAuthenticator
    /// Custom URLSession for every API client (used by the debug demo mode); nil uses the shared session.
    private let sessionOverride: URLSession?
    private let credentials: any CredentialStore
    private let defaults: UserDefaults
    private let draftRoot: URL?
    private(set) var isDemoSession = false
    @ObservationIgnored private(set) var conversationStates: ConversationStateStore

    private enum Keys {
        static let token = "token"
        static let baseURL = "baseURL"
        static let lastServerAddress = "lastServerAddress"
    }

    init(credentials: any CredentialStore = KeychainCredentials(), defaults: UserDefaults = .standard,
         draftRoot: URL? = ConversationStateStore.defaultRoot, session: URLSession? = nil,
         launchDemo: Bool? = nil, resetDemoDrafts: Bool? = nil) {
        authenticator = WebAuthenticator()
        self.credentials = credentials
        self.defaults = defaults
        self.draftRoot = draftRoot
        conversationStates = ConversationStateStore(server: nil, token: nil, root: draftRoot)
        #if DEBUG
        if launchDemo ?? DemoMode.isEnabled {
            isDemoSession = true
            sessionOverride = session ?? DemoMode.session
            configureDemo()
            rebuildConversationStates()
            if resetDemoDrafts ?? ProcessInfo.processInfo.arguments.contains("--demo-reset-drafts") {
                conversationStates.clear()
                rebuildConversationStates()
            }
            return
        }
        #endif
        sessionOverride = session
        let stored = credentials.string(for: Keys.baseURL) ?? defaults.string(forKey: Keys.baseURL)
        if let stored, let url = APIClient.normalizeBaseURL(stored) {
            serverURL = url
            token = credentials.string(for: Keys.token)
        }
        rebuildConversationStates()
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
        return defaults.string(forKey: Keys.lastServerAddress)
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
        settingsAccess.invalidate()
        guard let serverURL else {
            api = nil
            return
        }
        liveActivities.app = self
        // AppModel lives as long as the app, so a strong reference here is fine.
        let model = self
        let clientToken = token
        api = APIClient(baseURL: serverURL, token: token, session: sessionOverride, onUnauthorized: {
            Task { @MainActor in
                guard model.serverURL == serverURL, model.token == clientToken else { return }
                model.handleUnauthorized()
            }
        })
    }

    private func rebuildConversationStates() {
        conversationStates = ConversationStateStore(server: serverURL, token: token, root: draftRoot)
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
        conversationStates.clear()
        #if DEBUG
        isDemoSession = url.host?.lowercased() == DemoMode.host
        #endif
        serverURL = url
        serverInfo = info
        token = nil
        shell = nil
        sessionInfo = nil
        selection = nil
        if !isDemoSession {
            // Demo startup deliberately preserves unrelated real credentials. Never pair
            // an old token with this newly selected server if the app exits before sign-in.
            credentials.remove(Keys.token)
            credentials.set(url.absoluteString, for: Keys.baseURL)
            defaults.set(url.absoluteString, forKey: Keys.baseURL)
            defaults.set(url.absoluteString, forKey: Keys.lastServerAddress)
        }
        rebuildConversationStates()
        rebuildClient()
    }

    func changeServer() {
        if token != nil, let oldAPI = api {
            Task {
                try? await oldAPI.sendIgnoringResponse("/api/mobile/v1/live-activities", method: "DELETE", body: .object([:]))
                try? await oldAPI.revokeSession()
            }
        }
        liveActivities.resetLogin()
        if !isDemoSession {
            credentials.remove(Keys.baseURL)
            credentials.remove(Keys.token)
            defaults.removeObject(forKey: Keys.baseURL)
        }
        conversationStates.clear()
        serverURL = nil
        serverInfo = nil
        token = nil
        shell = nil
        sessionInfo = nil
        selection = nil
        rebuildConversationStates()
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
                completeSignIn(token: response.token)
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

    /// Used only after the server's PKCE token exchange succeeded. The current server/session,
    /// rather than the process launch arguments, decides whether credentials are real.
    func completeSignIn(token newToken: String) {
        guard let serverURL else { return }
        #if DEBUG
        isDemoSession = serverURL.host?.lowercased() == DemoMode.host
        #endif
        conversationStates.clear()
        if !isDemoSession {
            credentials.set(newToken, for: Keys.token)
            credentials.set(serverURL.absoluteString, for: Keys.baseURL)
        }
        token = newToken
        shell = nil
        sessionInfo = nil
        selection = nil
        rebuildConversationStates()
        rebuildClient()
    }

    func signOut() async {
        await liveActivities.clear(removeRemote: true)
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
        liveActivities.resetLogin()
        if !isDemoSession { credentials.remove(Keys.token) }
        conversationStates.clear()
        token = nil
        shell = nil
        sessionInfo = nil
        selection = nil
        rebuildConversationStates()
        rebuildClient()
    }

    func handleUnauthorized() {
        guard token != nil else { return }
        clearSession()
        showBanner("Your session has ended. Please sign in again.", isError: true)
    }

    // MARK: - Data

    func refreshShell() async {
        guard let api, token != nil else { return }
        let generation = settingsAccess.generation
        do {
            let fresh = try await api.shell()
            guard settingsAccess.generation == generation else { return }
            shell = fresh
            shellError = nil
            liveActivities.restore()
        } catch {
            guard settingsAccess.generation == generation else { return }
            if error.isUnauthorized || error.isCancellation {
                return
            }
            shellError = error.localizedDescription
        }
    }

    func loadSessionInfo() async {
        guard let api, token != nil else { return }
        let generation = settingsAccess.generation
        let request = settingsAccess.beginValidation()
        sessionInfo = nil
        do {
            let fresh = try await api.currentSession()
            guard settingsAccess.completeValidation(isAdmin: fresh.user?.isAdmin == true,
                generation: generation, request: request) else { return }
            sessionInfo = fresh
        } catch {
            // Unknown or failed role validation remains fail-closed. Never fall
            // back to shell.user for administrator controls.
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
            conversationStates.remove(conversation.id)
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
