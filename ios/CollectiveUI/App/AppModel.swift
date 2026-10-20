import Foundation
import Observation
import SwiftUI
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

    #if os(iOS)
    var voice: VoiceSessionModel?
    #endif

    var shell: ShellResponse? = nil
    var shellError: String? = nil
    private var botStatusRequest = 0
    var sessionInfo: SessionInfo? = nil
    private(set) var settingsAccess = SettingsSessionAccess()
    var selection: ChatRoute? = nil
    var banner: Banner? = nil
    var isSigningIn: Bool = false

    #if os(iOS)
    let liveActivities = LiveActivityCoordinator()
    #endif

    private let authenticator: any WebAuthenticating
    @ObservationIgnored private var authAttempt = UUID()
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
        static let signedOut = "nativeSignedOut"
        static let lastServerAddress = "lastServerAddress"
    }

    init(credentials: any CredentialStore = KeychainCredentials(), defaults: UserDefaults = .standard,
         draftRoot: URL? = ConversationStateStore.defaultRoot, session: URLSession? = nil,
         launchDemo: Bool? = nil, resetDemoDrafts: Bool? = nil, authenticator: (any WebAuthenticating)? = nil) {
        self.authenticator = authenticator ?? WebAuthenticator()
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
        let signedOut = defaults.bool(forKey: Keys.signedOut)
        let credentialServer = signedOut ? nil : credentials.string(for: Keys.baseURL)
        let stored = defaults.string(forKey: Keys.baseURL) ?? credentialServer
        if let stored, let url = APIClient.normalizeBaseURL(stored) {
            serverURL = url
            // A failed server-address write must not send another server's token here.
            if !signedOut, let credentialServer,
               APIClient.normalizeBaseURL(credentialServer) == url {
                token = credentials.string(for: Keys.token)
            }
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
        #if os(iOS)
        liveActivities.app = self
        #endif
        // AppModel lives as long as the app, so a strong reference here is fine.
        let model = self
        let clientToken = token
        let clientGeneration = settingsAccess.generation
        api = APIClient(baseURL: serverURL, token: token, session: sessionOverride, onUnauthorized: {
            Task { @MainActor in
                guard model.settingsAccess.generation == clientGeneration, model.serverURL == serverURL, model.token == clientToken else { return }
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
        invalidateAuthentication()
        conversationStates.clear()
        #if DEBUG
        isDemoSession = url.host?.lowercased() == DemoMode.host
        #endif
        serverURL = url
        serverInfo = info
        token = nil
        shell = nil
        shellError = nil
        banner = nil
        sessionInfo = nil
        selection = nil
        if !isDemoSession {
            // Demo startup deliberately preserves unrelated real credentials. Never pair
            // an old token with this newly selected server if the app exits before sign-in.
            defaults.set(true, forKey: Keys.signedOut)
            credentials.remove(Keys.token)
            credentials.set(url.absoluteString, for: Keys.baseURL)
            defaults.set(url.absoluteString, forKey: Keys.baseURL)
            defaults.set(url.absoluteString, forKey: Keys.lastServerAddress)
        }
        rebuildConversationStates()
        rebuildClient()
    }

    func changeServer() {
        invalidateAuthentication()
        if token != nil, let oldAPI = api {
            Task {
                #if os(iOS)
                try? await oldAPI.sendIgnoringResponse("/api/mobile/v1/live-activities", method: "DELETE", body: .object([:]))
                #endif
                try? await oldAPI.revokeSession()
            }
        }
        #if os(iOS)
        liveActivities.resetLogin()
        #endif
        if !isDemoSession {
            defaults.set(true, forKey: Keys.signedOut)
            credentials.remove(Keys.baseURL)
            credentials.remove(Keys.token)
            defaults.removeObject(forKey: Keys.baseURL)
        }
        conversationStates.clear()
        serverURL = nil
        serverInfo = nil
        token = nil
        shell = nil
        shellError = nil
        banner = nil
        sessionInfo = nil
        selection = nil
        rebuildConversationStates()
        rebuildClient()
    }

    func loadServerInfoIfNeeded() async {
        guard serverInfo == nil, let serverURL else { return }
        do {
            let info = try await publicClient(serverURL).mobileInfo()
            guard self.serverURL == serverURL else { return }
            serverInfo = info
        } catch {
            // The sign-in button still works; the info is only cosmetic here.
        }
    }

    // MARK: - Sign in / out

    func signIn() async {
        guard let serverURL, token == nil, !isSigningIn, !Task.isCancelled else { return }
        #if DEBUG
        guard !isDemoSession else {
            showBanner("This is an offline sign-in preview. Browser sign-in requires a controlled test server.")
            return
        }
        #endif
        let attempt = UUID()
        authAttempt = attempt
        isSigningIn = true
        defer { if authAttempt == attempt { isSigningIn = false } }

        do {
            let info = try await publicClient(serverURL).mobileInfo()
            guard authAttempt == attempt, self.serverURL == serverURL, !Task.isCancelled else { return }
            serverInfo = info
            if !info.enabled {
                showBanner("Mobile sign-in is turned off on this server. Ask your administrator to set MOBILE_APP_ENABLED=true.", isError: true)
                return
            }
        } catch {
            guard authAttempt == attempt, !Task.isCancelled else { return }
            showBanner(error.localizedDescription, isError: true)
            return
        }

        let verifier = PKCE.makeVerifier()
        let challenge = PKCE.challenge(for: verifier)
        let state = PKCE.makeState()
        let deviceName = WebAuthenticator.deviceName
        guard let authorizeURL = MobileAuth.authorizeURL(baseURL: serverURL, challenge: challenge, state: state, deviceName: deviceName) else {
            showBanner("Couldn't build the sign-in address.", isError: true)
            return
        }

        do {
            let callback = try await withTaskCancellationHandler {
                try Task.checkCancellation()
                return try await authenticator.authenticate(url: authorizeURL, callbackScheme: MobileAuth.callbackScheme)
            } onCancel: { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self, self.authAttempt == attempt else { return }
                    self.authenticator.cancel()
                }
            }
            guard authAttempt == attempt, self.serverURL == serverURL, !Task.isCancelled else { return }
            switch MobileAuth.parseCallback(callback, expectedState: state) {
            case .code(let code):
                let response = try await publicClient(serverURL).exchangeToken(code: code, codeVerifier: verifier)
                guard authAttempt == attempt, self.serverURL == serverURL, !Task.isCancelled else {
                    let abandoned = APIClient(baseURL: serverURL, token: response.token, session: sessionOverride)
                    Task { try? await abandoned.revokeSession() }
                    return
                }
                completeSignIn(token: response.token)
                await refreshShell()
            case .denied:
                showBanner("Sign-in was not approved.", isError: true)
            case .invalid(let message):
                showBanner(message, isError: true)
            }
        } catch {
            guard authAttempt == attempt, !Task.isCancelled else { return }
            if error.isCancellation || WebAuthenticator.isUserCancellation(error) {
                return
            }
            showBanner(error.localizedDescription, isError: true)
        }
    }

    /// Window closure and task cancellation dismiss sign-in without changing server selection.
    func cancelSignIn() {
        guard isSigningIn else { return }
        invalidateAuthentication()
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
            guard credentials.string(for: Keys.token) == newToken,
                  credentials.string(for: Keys.baseURL) == serverURL.absoluteString else {
                defaults.set(true, forKey: Keys.signedOut)
                credentials.remove(Keys.token)
                showBanner("The Keychain couldn't save this session. Unlock your device or Keychain and try signing in again.", isError: true)
                let issuedSession = APIClient(baseURL: serverURL, token: newToken, session: sessionOverride)
                Task { try? await issuedSession.revokeSession() }
                return
            }
            defaults.set(false, forKey: Keys.signedOut)
        }
        token = newToken
        shell = nil
        shellError = nil
        banner = nil
        sessionInfo = nil
        selection = nil
        rebuildConversationStates()
        rebuildClient()
    }

    func signOut() async {
        let generation = settingsAccess.generation
        let signingOutAPI = api
        #if os(iOS)
        await liveActivities.clear(removeRemote: true)
        #endif
        guard settingsAccess.generation == generation else { return }
        // End local access immediately; a slow revocation must not leave chat usable
        // or clear a replacement session when its response eventually arrives.
        clearSession()
        if let signingOutAPI, signingOutAPI.token != nil {
            do {
                try await signingOutAPI.revokeSession()
            } catch {
                // The local session is already cleared even if the server is unreachable.
            }
        }
    }

    private func invalidateAuthentication() {
        authAttempt = UUID()
        isSigningIn = false
        authenticator.cancel()
    }

    private func clearSession() {
        invalidateAuthentication()
        #if os(iOS)
        liveActivities.resetLogin()
        #endif
        if !isDemoSession {
            defaults.set(true, forKey: Keys.signedOut)
            credentials.remove(Keys.token)
        }
        conversationStates.clear()
        token = nil
        shell = nil
        shellError = nil
        banner = nil
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
            botStatusRequest += 1
            shell = fresh
            shellError = nil
            #if os(iOS)
            liveActivities.restore()
            #endif
        } catch {
            guard settingsAccess.generation == generation else { return }
            if error.isUnauthorized || error.isCancellation {
                return
            }
            shellError = error.localizedDescription
        }
    }

    /// Complete server snapshots keep background/group work visible without reopening a conversation.
    func refreshBotStatuses() async {
        guard let api, token != nil, shell != nil else { return }
        let generation = settingsAccess.generation
        botStatusRequest += 1
        let request = botStatusRequest
        do {
            let statuses = try await api.botStatuses()
            guard settingsAccess.generation == generation, request == botStatusRequest else { return }
            guard var current = shell else { return }
            for index in current.bots.indices { current.bots[index].status = statuses[current.bots[index].id] ?? nil }
            shell = current
        } catch {
            guard settingsAccess.generation == generation, request == botStatusRequest else { return }
            if error.isUnauthorized {
                guard var current = shell else { return }
                for index in current.bots.indices { current.bots[index].status = nil }
                shell = current
            }
            // Focus/reconnect and the next foreground poll recover transient failures.
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
            settingsAccess.failValidation(generation: generation, request: request)
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
        let store = conversationStates
        if await mutateConversation({ api in
            try await api.deleteConversation(id: conversation.id)
        }), conversationStates === store {
            store.remove(conversation.id)
        }
    }

    private func deselect(_ conversationId: String) {
        if case .conversation(let selectedId)? = selection, selectedId == conversationId {
            selection = nil
        }
    }

    @discardableResult
    private func mutateConversation(_ operation: (APIClient) async throws -> Void) async -> Bool {
        guard let api, token != nil else { return false }
        do {
            try await operation(api)
        } catch {
            guard self.api === api else { return false }
            if !error.isUnauthorized && !error.isCancellation {
                showBanner(error.localizedDescription, isError: true)
            }
            return false
        }
        guard self.api === api, !Task.isCancelled else { return false }
        await refreshShell()
        return self.api === api
    }

    #if DEBUG
    /// Demo mode starts signed in against the in-memory demo server (or on the signed-out screens).
    private func configureDemo() {
        #if os(iOS)
        DemoServer.shared.install(chartPNG: DemoArt.chartPNG(), petV1: DemoArt.petAtlasPNG(version: 1), petV2: DemoArt.petAtlasPNG(version: 2))
        #elseif os(macOS)
        DemoServer.shared.install(chartPNG: Data(), petV1: DemoPetArt.atlasPNG(version: 1), petV2: DemoPetArt.atlasPNG(version: 2))
        #endif
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
