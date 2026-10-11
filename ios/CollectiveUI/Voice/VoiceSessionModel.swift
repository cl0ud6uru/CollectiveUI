import Foundation
import Observation
import WebKit
import AVFAudio
import CollectiveKit

@MainActor
@Observable
final class VoiceSessionModel {
    static let engineURL = URL(string: "https://voice.collective.invalid/engine")!
    let id = UUID()
    let conversationId: String
    let name: String
    let page: WebPage
    var expanded = true
    private(set) var muted = false
    private(set) var status = "connecting"
    let inputLevel = VoiceInputLevel()
    let audioDiagnostics = VoiceAudioDiagnostics()
    private(set) var saving = false
    private(set) var unsaved = false
    var notice: String?
    @ObservationIgnored private weak var chat: ChatModel?
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let target: [String: String]
    @ObservationIgnored private let demo: Bool
    @ObservationIgnored private var loaded = false
    @ObservationIgnored private var ready = false
    @ObservationIgnored private var ending = false
    @ObservationIgnored private var deadline: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var avatarTask: Task<Void, Never>?
    @ObservationIgnored private var avatarGeneration = 0

    init(chat: ChatModel, api: APIClient) {
        self.chat = chat; self.app = chat.app; self.api = api
        conversationId = chat.conversationId; name = chat.assistantName
        demo = chat.app.isDemoSession
        if chat.isNew, let option = chat.target { target = [option.kind == "bot" ? "botId" : "appId": option.id] }
        else { target = ["conversationId": chat.conversationId] }
        let handler = VoiceScriptHandler()
        var config = WebPage.Configuration()
        config.websiteDataStore = .nonPersistent()
        config.mediaPlaybackBehavior = .allowsInlinePlayback
        config.allowsAirPlayForMediaPlayback = false
        config.userContentController.add(handler, name: "voiceEvents")
        config.userContentController.addScriptMessageHandler(handler, contentWorld: .page, name: "voiceAPI")
        config.deviceSensorAuthorization = .init { permission, frame, origin in
            guard frame.isMainFrame, origin.protocol == "https", origin.host == Self.engineURL.host,
                  permission == .mediaCapture(.microphone) else { return .deny }
            return .grant // The app obtains the OS microphone permission before starting capture.
        }
        page = WebPage(configuration: config, navigationDecider: VoiceNavigationPolicy())
        handler.model = self
        audioDiagnostics.connect { [weak self] operation in
            guard let self else { return nil }
            return try await self.page.callJavaScript("return await window.voice.diagnostics[operation]()", arguments: ["operation": operation])
        }
    }

    var active: Bool { status == "connecting" || status == "connected" || status == "ending" }
    var statusLabel: String {
        if demo && status == "connected" { return String(localized: "Preview · mic off") }
        switch status {
        case "connecting": return String(localized: "Connecting…")
        case "connected": return muted ? String(localized: "Microphone muted") : String(localized: "Listening")
        case "ending": return String(localized: "Saving conversation…")
        default: return unsaved ? String(localized: "Speech needs saving") : String(localized: "Voice ended")
        }
    }

    func load() async {
        guard !loaded else { return }; loaded = true
        do {
            guard let url = Bundle.main.url(forResource: "voice-engine", withExtension: "html") else { throw APIError.invalidResponse }
            let html = try String(contentsOf: url, encoding: .utf8)
            page.load(simulatedRequest: URLRequest(url: Self.engineURL), responseHTML: html)
            deadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(45))
                guard !Task.isCancelled, let self, self.status == "connecting" else { return }
                self.notice = String(localized: "Voice could not connect. Check your connection and try again.")
                await self.end()
            }
        } catch { notice = error.localizedDescription; status = "ended" }
    }

    func receive(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "ready":
            guard !ready, !ending else { return }; ready = true
            guard event["secure"] as? Bool == true, event["media"] as? Bool == true else {
                notice = String(localized: "Voice capture is unavailable on this device."); status = "ended"; return
            }
            Task { await begin() }
        case "status":
            // Native End owns its terminal transition, including capture shutdown and saving.
            if let value = event["value"] as? String, !ending { status = value }
            if status != "connecting" { deadline?.cancel() }
        case "level":
            if let value = event["value"] as? Double, value.isFinite { inputLevel.value = muted || status != "connected" ? 0 : min(1, max(0, value)) }
        case "notice": notice = event["message"] as? String
        case "changed": refreshChat()
        case "approval":
            expanded = false
            notice = String(localized: "Review the approval card in chat. Spoken agreement does not approve tools.")
            refreshChat()
        case "saving": saving = event["value"] as? Bool ?? false
        case "saved":
            unsaved = event["unsaved"] as? Bool ?? false
            saving = false; refreshChat()
        default: break
        }
    }

    private func begin() async {
        guard !ending else { return }
        if !demo {
            let allowed = await AVAudioApplication.requestRecordPermission()
            guard !ending else { return }
            guard allowed else {
                notice = String(localized: "Allow Microphone access in Settings to use voice. You can still type in this chat.")
                status = "ended"; deadline?.cancel(); return
            }
        }
        do {
            _ = try await page.callJavaScript("return window.voice.start(config)", arguments: ["config": ["target": target, "chatId": conversationId, "demo": demo, "identity": avatarMetadata]])
        } catch { notice = error.localizedDescription; await end() }
    }

    func setMuted(_ value: Bool) async {
        guard status == "connected" else { return }
        do {
            _ = try await page.callJavaScript("window.voice.mute(value)", arguments: ["value": value])
            muted = value
            if value { inputLevel.value = 0 }
        } catch { notice = error.localizedDescription; await end() }
    }

    func setVisible() async {
        guard ready else { return }
        _ = try? await page.callJavaScript("window.voice.visible(value)", arguments: ["value": expanded])
    }

    func end() async {
        guard !ending else { return }; ending = true; deadline?.cancel()
        avatarTask?.cancel(); avatarGeneration += 1
        status = "ending"; muted = true; inputLevel.value = 0
        saving = true
        defer { saving = false }
        // Capture starts only after ready; ending also rejects a late ready event.
        // An unready engine has no capture to stop and must not await WebKit startup.
        if ready {
            // Native capture shutdown also works if the web process has stalled.
            await page.setMicrophoneCaptureState(.none)
            await page.pauseAllMediaPlayback()
            await audioDiagnostics.stop()
        } else { audioDiagnostics.disconnect() }
        if ready {
            unsaved = true // Retain retry protection until the engine confirms saving.
            do { _ = try await page.callJavaScript("return window.voice.end()") }
            catch { notice = error.localizedDescription }
        }
        status = "ended"
        refreshChat()
    }

    func retrySave() async {
        saving = true; notice = nil
        defer { saving = false }
        do { _ = try await page.callJavaScript("return window.voice.retry()") }
        catch { notice = error.localizedDescription }
    }

    func dismiss() {
        guard !active, !saving, !unsaved else { expanded = false; return }
        deadline?.cancel(); refreshTask?.cancel(); avatarTask?.cancel(); avatarGeneration += 1; audioDiagnostics.disconnect(); page.stopLoading()
        if app?.voice?.id == id { app?.voice = nil }
    }

    private var authenticated: Bool { app?.api?.token == api.token && app?.api?.baseURL == api.baseURL && app?.phase == .main }

    private var avatarBotId: String? { chat?.target?.kind == "bot" ? chat?.target?.id : nil }
    private var avatarPet: PetAppearance? { avatarBotId.flatMap { app?.shell?.pets[$0] } }
    private var avatarMetadata: [String: Any] {
        VoiceAvatarIdentity.metadata(botId: avatarBotId, icon: chat?.assistantIcon, pet: avatarPet)
    }
    var avatarIdentityKey: String {
        [String(ready), status == "connected" ? "connected" : "inactive", avatarBotId ?? "", chat?.assistantIcon ?? "",
         avatarPet?.avatarPath(for: avatarBotId ?? "") ?? "", avatarPet?.appearance ?? "", avatarPet?.motion ?? ""].joined(separator: "|")
    }

    func refreshAvatar() async {
        guard ready, status == "connected", !ending, authenticated else { return }
        avatarTask?.cancel(); avatarGeneration += 1
        let generation = avatarGeneration, identity = avatarMetadata, botId = avatarBotId, pet = avatarPet
        avatarTask = Task { [weak self] in
            guard let self, !Task.isCancelled, self.authenticated, !self.ending, generation == self.avatarGeneration else { return }
            _ = try? await self.page.callJavaScript("window.voice.identity(value)", arguments: ["value": identity])
            guard !Task.isCancelled, generation == self.avatarGeneration, let botId,
                  let path = pet?.avatarPath(for: botId), let version = pet?.spriteVersionNumber else { return }
            do {
                let data = try await self.api.loadData(from: path)
                guard !Task.isCancelled, self.authenticated, !self.ending, generation == self.avatarGeneration else { return }
                let atlas = try VoiceAvatarIdentity.addingAtlas(data, to: identity, version: version)
                _ = try await self.page.callJavaScript("window.voice.identity(value)", arguments: ["value": atlas])
            } catch { /* The existing bot icon remains visible when its atlas is unavailable. */ }
        }
        await avatarTask?.value
    }

    func setReducedMotion(_ value: Bool) async {
        guard ready else { return }
        _ = try? await page.callJavaScript("window.voice.reduceMotion(value)", arguments: ["value": value])
    }

    func request(_ request: [String: Any]) async throws -> [String: Any] {
        guard authenticated, !demo, let path = request["path"] as? String, let method = request["method"] as? String else { throw APIError.unauthorized }
        let body = request["body"].flatMap { try? JSONSerialization.data(withJSONObject: $0, options: .fragmentsAllowed) }.flatMap(JSONValue.parse(data:))
        let components = try VoiceRequestPolicy(conversationId: conversationId).validate(path: path, method: method, body: body)
        // Once End is tapped, no new session or delegated run may be admitted.
        if ending && method == "POST" && (components.path.hasSuffix("/session") || body?["delegate"]?.boolValue == true) { throw CancellationError() }
        var urlRequest = try api.makeRequest(components.path, method: method, query: components.queryItems ?? [], body: body == .null ? nil : body)
        urlRequest.timeoutInterval = components.path.hasSuffix("/session") ? 35 : 15
        do {
            let (data, response) = try await api.perform(urlRequest)
            guard authenticated else { throw APIError.unauthorized }
            if components.path.hasSuffix("/avatar") {
                guard data.count <= 25 * 1024 * 1024 else { throw APIError.invalidResponse }
                return ["status": response.statusCode, "body": data.base64EncodedString()]
            }
            return ["status": response.statusCode, "body": try JSONSerialization.jsonObject(with: data)]
        } catch let error as APIError {
            if method == "GET", components.path.hasSuffix("/session"),
               case .server(404, "Not Found", _) = error {
                return ["status": 404, "body": ["error": "This server doesn't have mobile voice yet. Update the CollectiveUI server, then try again."]]
            }
            return ["status": error.statusCode ?? 502, "body": ["error": error.localizedDescription]]
        }
    }

    func refreshChat() {
        guard authenticated, !demo, refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            defer { self.refreshTask = nil }
            await self.chat?.refreshAfterVoice()
            await self.app?.refreshShell()
        }
    }

    func updateContext(_ messages: [[String: String]]) async {
        guard ready, status == "connected" else { return }
        _ = try? await page.callJavaScript("window.voice.context(messages)", arguments: ["messages": messages])
    }
}
