import AuthenticationServices
import Foundation
import UIKit

enum WebAuthenticatorError: LocalizedError {
    case couldNotStart
    case missingCallback

    var errorDescription: String? {
        switch self {
        case .couldNotStart:
            return "Couldn't open the sign-in page."
        case .missingCallback:
            return "Sign-in finished without a response."
        }
    }
}

/// Supplies the window that ASWebAuthenticationSession presents over.
final class PresentationAnchorProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let anchor: ASPresentationAnchor

    init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
        super.init()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return anchor
    }
}

/// Guards a continuation against being resumed twice.
final class ResumeGate: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed {
            return false
        }
        claimed = true
        return true
    }
}

/// Runs the server's web sign-in page in ASWebAuthenticationSession and returns the callback URL.
@MainActor
final class WebAuthenticator {
    private var session: ASWebAuthenticationSession?
    private var anchorProvider: PresentationAnchorProvider?

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        let provider = PresentationAnchorProvider(anchor: WebAuthenticator.currentAnchor())
        anchorProvider = provider
        defer {
            session = nil
            anchorProvider = nil
        }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            let gate = ResumeGate()
            let authSession = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callbackURL, error in
                guard gate.claim() else { return }
                if let error {
                    continuation.resume(throwing: error)
                } else if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: WebAuthenticatorError.missingCallback)
                }
            }
            authSession.presentationContextProvider = provider
            authSession.prefersEphemeralWebBrowserSession = false
            self.session = authSession
            if !authSession.start() {
                if gate.claim() {
                    continuation.resume(throwing: WebAuthenticatorError.couldNotStart)
                }
            }
        }
    }

    static func isUserCancellation(_ error: Error) -> Bool {
        if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
            return true
        }
        let nsError = error as NSError
        return nsError.domain == ASWebAuthenticationSessionErrorDomain
            && nsError.code == ASWebAuthenticationSessionError.Code.canceledLogin.rawValue
    }

    static func currentAnchor() -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap { $0.windows }
        if let keyWindow = windows.first(where: { $0.isKeyWindow }) {
            return keyWindow
        }
        if let anyWindow = windows.first {
            return anyWindow
        }
        return ASPresentationAnchor()
    }
}
