import Foundation

/// Client-side identifiers for messages and new conversations (16 chars, [A-Za-z0-9]).
public enum IDGenerator {
    static let alphabet: [Character] = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")

    public static func make(length: Int = 16) -> String {
        var result = ""
        result.reserveCapacity(length)
        for _ in 0..<max(length, 0) {
            if let character = alphabet.randomElement() {
                result.append(character)
            }
        }
        return result
    }
}
