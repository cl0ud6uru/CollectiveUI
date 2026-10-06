import ActivityKit
import Foundation
import Observation
import UIKit
import CollectiveKit

@MainActor
@Observable
final class LiveActivityCoordinator {
    private(set) var enabled = UserDefaults.standard.bool(forKey: "liveActivitiesEnabled")
    private(set) var availability = "Status updates appear while the app is open."
    @ObservationIgnored private var watches: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var watchIDs: [String: UUID] = [:]
    @ObservationIgnored private var tokenTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var dismissed: Set<String> = []
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var authorizationTask: Task<Void, Never>?
    @ObservationIgnored weak var app: AppModel?
    @ObservationIgnored private var isForeground = true

    init() {
        authorizationTask = Task { [weak self] in
            for await allowed in ActivityAuthorizationInfo().activityEnablementUpdates {
                if !allowed { await self?.clear(removeRemote: true) }
            }
        }
    }
    // Random scope tied to this local sign-in; only scopes are stored here, never auth tokens in preferences.
    var scope: String { UserDefaults.standard.string(forKey: "activityLoginScope") ?? "" }
    private var canPush: Bool { Bundle.main.object(forInfoDictionaryKey: "CollectiveLiveActivityPushEnabled") as? Bool == true }

    func setEnabled(_ value: Bool) async {
        enabled = value
        UserDefaults.standard.set(value, forKey: "liveActivitiesEnabled")
        if value {
            restore()
            if case .conversation(let id)? = app?.selection { observe(conversationId: id) }
        } else { await clear(removeRemote: true) }
    }
    func foreground(_ value: Bool) {
        isForeground = value
        if value { restore() }
    }
    func restore() {
        guard let app, app.token != nil, app.shell?.user != nil else { return }
        if scope.isEmpty { UserDefaults.standard.set(UUID().uuidString, forKey: "activityLoginScope") }
        let login = scope
        dismissed.formUnion(UserDefaults.standard.stringArray(forKey: "activityDismissedRuns.\(login)") ?? [])
        for activity in Activity<CollectiveRunAttributes>.activities {
            if activity.attributes.scope != login || !enabled {
                Task { await activity.end(nil, dismissalPolicy: .immediate) }
                continue
            }
            if activity.activityState == .active || activity.activityState == .stale {
                monitorToken(activity)
                observe(conversationId: activity.attributes.conversationId, runId: activity.attributes.runId)
            }
        }
        if !ActivityAuthorizationInfo().areActivitiesEnabled { availability = "Live Activities are unavailable or disabled in iOS Settings." }
    }
    /// Monitoring belongs to AppModel, so navigating away from a ChatView doesn't end the server run's activity.
    func observe(conversationId: String, runId: String? = nil, replace: Bool = false) {
        guard enabled, app?.token != nil else { return }
        if replace { watches.removeValue(forKey: conversationId)?.cancel() }
        guard watches[conversationId] == nil else { return }
        let session = generation
        let watchID = UUID()
        watchIDs[conversationId] = watchID
        watches[conversationId] = Task { [weak self] in
            var pinnedRun = runId
            defer { if self?.generation == session && self?.watchIDs[conversationId] == watchID { self?.watches[conversationId] = nil; self?.watchIDs[conversationId] = nil } }
            while !Task.isCancelled, let self, self.generation == session, self.enabled {
                if self.isForeground, let app = self.app, let api = app.api, let user = app.shell?.user, !self.scope.isEmpty {
                    do {
                        let query = pinnedRun.map { "?runId=\($0)" } ?? ""
                        let snapshot: RunActivitySnapshot = try await api.get("/api/mobile/v1/conversations/\(conversationId)/activity\(query)", as: RunActivitySnapshot.self)
                        guard !Task.isCancelled, self.generation == session, app.shell?.user?.id == user.id else { return }
                        pinnedRun = snapshot.runId
                        await self.apply(snapshot)
                        if snapshot.content.phase.isTerminal { return }
                    } catch {
                        if error.isUnauthorized { return }
                        if let code = (error as? APIError)?.statusCode, [403, 404, 410].contains(code) {
                            if let pinnedRun { await self.dismiss(runId: pinnedRun) }
                            return
                        }
                        // Preserve the last known state; the widget's stale date shows uncertainty.
                        self.availability = "Waiting to reconnect. Open chat for the latest status."
                    }
                }
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }
    private func apply(_ snapshot: RunActivitySnapshot) async {
        let all = Activity<CollectiveRunAttributes>.activities.filter { $0.attributes.scope == scope && [.active, .stale].contains($0.activityState) }
        let matching = all.filter { $0.attributes.runId == snapshot.runId }
        for duplicate in matching.dropFirst() { await duplicate.end(nil, dismissalPolicy: .immediate) }
        var activity = matching.first
        if activity == nil, ActivityStartPolicy.mayStart(enabled: enabled, authorized: ActivityAuthorizationInfo().areActivitiesEnabled,
            foreground: isForeground, phase: snapshot.content.phase, runId: snapshot.runId,
            existingRunIds: all.map { $0.attributes.runId }, dismissedRunIds: dismissed) {
            guard let app else { return }
            let captured = generation
            let pet = app.shell?.pets[snapshot.botId]
            let pixels = await ActivityPetEncoder.encode(pet: pet, botId: snapshot.botId, api: app.api)
            // Encoding can suspend while another conversation starts or this watch gets replaced.
            // Recheck capacity and deduplication immediately before the synchronous request.
            let currentRuns = Activity<CollectiveRunAttributes>.activities.filter {
                $0.attributes.scope == scope && [.active, .stale].contains($0.activityState)
            }.map { $0.attributes.runId }
            guard !Task.isCancelled, generation == captured, app.token != nil,
                  ActivityStartPolicy.mayStart(enabled: enabled, authorized: ActivityAuthorizationInfo().areActivitiesEnabled,
                    foreground: isForeground, phase: snapshot.content.phase, runId: snapshot.runId,
                    existingRunIds: currentRuns, dismissedRunIds: dismissed) else { return }
            let attributes = CollectiveRunAttributes(scope: scope, conversationId: snapshot.conversationId, botId: snapshot.botId,
                runId: snapshot.runId, pet: pet?.enabled == true ? pet?.appearance ?? "off" : "off", petPixels: pixels)
            // Keep combined attributes and content below Apple's 4 KB bound.
            guard let attrs = try? JSONEncoder().encode(attributes), let content = try? JSONEncoder().encode(snapshot.content),
                  attrs.count + content.count <= 3500 else { return }
            do {
                activity = try Activity.request(attributes: attributes, content: self.content(snapshot.content),
                    pushType: canPush && snapshot.backgroundUpdates ? .token : nil)
                if let activity { monitorToken(activity) }
            } catch {
                availability = "Live Activities could not start on this device. Chat is still available."
                return
            }
        }
        guard let activity else { return }
        availability = canPush && snapshot.backgroundUpdates ? "Background delivery configured; device delivery needs verification." : "Status updates appear while the app is open."
        let current = activity.content.state
        guard current.accepts(snapshot.content) else { return }
        if snapshot.content.phase.isTerminal {
            await activity.end(content(snapshot.content), dismissalPolicy: .after(.now + 300))
            await unregister(activity)
        } else { await activity.update(content(snapshot.content)) }
    }
    private func content(_ state: RunActivityContent) -> ActivityContent<RunActivityContent> {
        ActivityContent(state: state, staleDate: state.phase.isTerminal ? nil : .now + 180,
            relevanceScore: state.phase == .attention ? 100 : 50)
    }
    private func monitorToken(_ activity: Activity<CollectiveRunAttributes>) {
        guard tokenTasks[activity.id] == nil else { return }
        let session = generation
        tokenTasks[activity.id] = Task { [weak self] in
            guard let self else { return }
            // The current token can already exist on relaunch; then observe every rotation.
            if let token = activity.pushToken { await self.register(token, activity: activity, generation: session) }
            for await token in activity.pushTokenUpdates {
                guard !Task.isCancelled, self.generation == session else { return }
                await self.register(token, activity: activity, generation: session)
            }
        }
        Task { [weak self] in
            for await state in activity.activityStateUpdates {
                guard let self, self.generation == session else { return }
                if state == .dismissed || state == .ended {
                    self.dismissed.insert(activity.attributes.runId)
                    UserDefaults.standard.set(Array(self.dismissed).suffix(150).map { $0 }, forKey: "activityDismissedRuns.\(self.scope)")
                    await self.unregister(activity)
                    return
                }
            }
        }
    }
    private func register(_ token: Data, activity: Activity<CollectiveRunAttributes>, generation session: UUID) async {
        guard canPush, enabled, activity.attributes.scope == scope else { return }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        // Persist only version, never token. Each received token supersedes older rotations/retries.
        let key = "activityTokenVersion.\(activity.id)"
        let version = max(Int(Date.now.timeIntervalSince1970 * 1000), UserDefaults.standard.integer(forKey: key) + 1)
        UserDefaults.standard.set(version, forKey: key)
        for attempt in 0..<4 {
            guard !Task.isCancelled, self.generation == session, activity.attributes.scope == scope, let api = app?.api else { return }
            do {
                try await api.sendIgnoringResponse("/api/mobile/v1/live-activities", method: "POST", body: .object([
                    "activityId": .string(activity.id), "runId": .string(activity.attributes.runId),
                    "pushToken": .string(hex), "tokenVersion": .number(Double(version)),
                ]))
                return
            } catch {
                if error.isUnauthorized || [400, 403, 404, 409, 410, 429].contains((error as? APIError)?.statusCode ?? 0) { return }
                availability = "Background registration is waiting to reconnect."
                try? await Task.sleep(for: .seconds(Double(1 << attempt)))
            }
        }
        // Foreground restore retries the current token after network failure/relaunch.
        tokenTasks[activity.id]?.cancel(); tokenTasks[activity.id] = nil
    }
    private func unregister(_ activity: Activity<CollectiveRunAttributes>) async {
        tokenTasks.removeValue(forKey: activity.id)?.cancel()
        UserDefaults.standard.removeObject(forKey: "activityTokenVersion.\(activity.id)")
        guard activity.attributes.scope == scope, let api = app?.api else { return }
        try? await api.sendIgnoringResponse("/api/mobile/v1/live-activities", method: "DELETE", body: .object(["activityId": .string(activity.id)]))
    }
    private func dismiss(runId: String) async {
        for activity in Activity<CollectiveRunAttributes>.activities where activity.attributes.scope == scope && activity.attributes.runId == runId {
            await activity.end(nil, dismissalPolicy: .immediate)
            await unregister(activity)
        }
    }
    func clear(removeRemote: Bool) async {
        generation = UUID()
        for task in watches.values { task.cancel() }; watches.removeAll(); watchIDs.removeAll()
        for task in tokenTasks.values { task.cancel() }; tokenTasks.removeAll()
        dismissed.removeAll()
        for activity in Activity<CollectiveRunAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
            UserDefaults.standard.removeObject(forKey: "activityTokenVersion.\(activity.id)")
        }
        if removeRemote, let api = app?.api, app?.token != nil {
            try? await api.sendIgnoringResponse("/api/mobile/v1/live-activities", method: "DELETE", body: .object([:]))
        }
    }
    func resetLogin() {
        generation = UUID()
        for task in watches.values { task.cancel() }; watches.removeAll(); watchIDs.removeAll()
        for task in tokenTasks.values { task.cancel() }; tokenTasks.removeAll()
        UserDefaults.standard.removeObject(forKey: "activityDismissedRuns.\(scope)")
        dismissed.removeAll()
        UserDefaults.standard.removeObject(forKey: "activityLoginScope")
        // End synchronously captured activities even if sign-in happens before this task executes.
        let old = Activity<CollectiveRunAttributes>.activities
        Task { for activity in old { await activity.end(nil, dismissalPolicy: .immediate) } }
    }
    func open(_ url: URL) async {
        guard let app, app.token != nil, let link = ActivityDeepLink(url: url, expectedScope: scope), let api = app.api else { return }
        let session = generation
        do {
            let snapshot: RunActivitySnapshot = try await api.get("/api/mobile/v1/conversations/\(link.conversationId)/activity?runId=\(link.runId)", as: RunActivitySnapshot.self)
            guard generation == session, snapshot.botId == link.botId, snapshot.runId == link.runId else { return }
            app.openConversation(link.conversationId)
        } catch { if !error.isUnauthorized { app.showBanner("This chat is no longer available.", isError: true) } }
    }
}
