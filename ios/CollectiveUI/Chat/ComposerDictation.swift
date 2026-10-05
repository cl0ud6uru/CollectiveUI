import Foundation
import Observation
@preconcurrency import Speech
import AVFAudio

/// Dictation is opt-in, on-device, and only edits a draft. It never sends a chat message.
@MainActor
@Observable
final class ComposerDictation {
    private(set) var isPreparing = false
    private(set) var isListening = false
    private(set) var transcript = ""
    var errorMessage: String?
    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private var recognizer: SFSpeechRecognizer?
    @ObservationIgnored private var onTranscript: ((String) -> Void)?
    @ObservationIgnored private var tapInstalled = false
    @ObservationIgnored private var session = UUID()
    @ObservationIgnored private var ownsAudioSession = false

    func start(onTranscript: @escaping (String) -> Void) async {
        guard !isPreparing && !isListening else { return }
        session = UUID()
        let activeSession = session
        isPreparing = true
        errorMessage = nil
        defer { if session == activeSession { isPreparing = false } }
        let authorization = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard session == activeSession, !Task.isCancelled else { return }
        guard authorization == .authorized else {
            errorMessage = "Allow Speech Recognition in iPhone Settings to use dictation. You can still type your message."
            return
        }
        let allowed = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard session == activeSession, !Task.isCancelled else { return }
        guard allowed else {
            errorMessage = "Allow Microphone access in iPhone Settings to use dictation."
            return
        }
        guard let recognizer = SFSpeechRecognizer(locale: .current), recognizer.isAvailable,
              recognizer.supportsOnDeviceRecognition else {
            errorMessage = "On-device dictation is unavailable for this language. Try your keyboard’s dictation button or type your message."
            return
        }
        self.recognizer = recognizer
        self.onTranscript = onTranscript
        transcript = ""
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audio.setActive(true)
            ownsAudioSession = true
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw NSError(domain: "Dictation", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone is available."])
            }
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.requiresOnDeviceRecognition = true
            request.shouldReportPartialResults = true
            request.taskHint = .dictation
            self.request = request
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
                request?.append(buffer)
            }
            tapInstalled = true
            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                let words = result?.bestTranscription.formattedString
                let final = result?.isFinal == true
                let failure = error?.localizedDescription
                Task { @MainActor [weak self] in
                    guard let self, self.session == activeSession else { return }
                    if let words { self.transcript = words }
                    if final || failure != nil {
                        self.stop()
                        if let failure, words == nil { self.errorMessage = failure }
                    }
                }
            }
            engine.prepare()
            try engine.start()
            isListening = true
        } catch {
            stop(commit: false)
            errorMessage = error.localizedDescription
        }
    }

    /// Keeps recognized words when stopped or interrupted, invalidating any late recognition callbacks.
    func stop(commit: Bool = true) {
        session = UUID()
        engine.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        if ownsAudioSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            ownsAudioSession = false
        }
        isListening = false
        isPreparing = false
        let words = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if commit, !words.isEmpty { onTranscript?(words) }
        transcript = ""
        onTranscript = nil
    }
}
