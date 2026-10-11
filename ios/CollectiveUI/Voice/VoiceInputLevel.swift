import Observation

/// Isolates microphone samples from the rest of the screen's observation graph.
@MainActor
@Observable
final class VoiceInputLevel {
    var value = 0.0
}
