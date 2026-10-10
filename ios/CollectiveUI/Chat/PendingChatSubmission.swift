import Foundation
import CollectiveKit

/// Reuse the immutable request identity after uncertain acceptance. The server's
/// message primary key prevents a retry from admitting a second direct-chat turn.
struct PendingChatSubmission: Codable {
    let messageId: String
    let text: String
    let attachments: [ComposerAttachment]
    let body: JSONValue
    var wasRetried = false
}

/// /new and /reset reuse their destination when an uncertain command is retried.
struct PendingCommandAttempt: Codable {
    let text: String
    let nextId: String
}
