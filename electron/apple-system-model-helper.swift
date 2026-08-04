import Darwin
import Foundation
import FoundationModels

private let protocolVersion = "apple-system-model/v1"

private struct Handshake: Encodable, Sendable {
    let protocolVersion: String
    let type: String
    let helperVersion: String
}

private struct Command: Decodable {
    let protocolVersion: String
    let type: String
    let requestId: String?
    let runId: String?
    let prompt: String?
}

private func isExactInboundCommand(_ data: Data) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: data),
          let command = object as? [String: Any],
          command["protocolVersion"] as? String == protocolVersion,
          let type = command["type"] as? String else {
        return false
    }

    switch type {
    case "activate":
        return Set(command.keys) == ["protocolVersion", "type", "requestId"]
            && command["requestId"] is String
    case "start":
        return Set(command.keys) == ["protocolVersion", "type", "runId", "prompt"]
            && command["runId"] is String
            && command["prompt"] is String
    case "cancel":
        return Set(command.keys) == ["protocolVersion", "type", "runId"]
            && command["runId"] is String
    default:
        return false
    }
}

private struct Activation: Encodable, Sendable {
    let protocolVersion: String
    let type: String
    let requestId: String
    let availability: String
    let providerIdentity: String
    let osBuild: String
    let reason: String?
}

private struct RunEvent: Encodable, Sendable {
    let protocolVersion: String
    let type: String
    let runId: String
    let content: String?
    let reason: String?
}

private func currentOSBuild() -> String {
    var size = 0
    guard sysctlbyname("kern.osversion", nil, &size, nil, 0) == 0 else {
        return "unknown"
    }
    var value = [CChar](repeating: 0, count: size)
    guard sysctlbyname("kern.osversion", &value, &size, nil, 0) == 0 else {
        return "unknown"
    }
    return String(cString: value)
}

private func generationFailureReason(_ error: Error) -> String {
    guard let generationError = error as? LanguageModelSession.GenerationError else {
        return "provider-generation-failed"
    }
    switch generationError {
    case .exceededContextWindowSize:
        return "context-window-exceeded"
    case .assetsUnavailable:
        return "provider-assets-unavailable"
    case .guardrailViolation:
        return "provider-guardrail-violation"
    case .unsupportedGuide:
        return "provider-guide-unsupported"
    case .unsupportedLanguageOrLocale:
        return "provider-language-or-locale-unsupported"
    case .decodingFailure:
        return "provider-decoding-failed"
    case .rateLimited:
        return "provider-rate-limited"
    case .concurrentRequests:
        return "provider-concurrent-request"
    case .refusal:
        return "provider-refused"
    @unknown default:
        return "provider-failed"
    }
}

private actor ProtocolEmitter {
    func emit<T: Encodable & Sendable>(_ message: T) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(message),
              let line = String(data: data, encoding: .utf8) else {
            exit(70)
        }
        print(line)
        fflush(stdout)
    }
}

private actor RunRegistry {
    private let emitter: ProtocolEmitter
    private var activated = false
    private var tasks: [String: Task<Void, Never>] = [:]

    init(emitter: ProtocolEmitter) {
        self.emitter = emitter
    }

    func setActivated(_ value: Bool) {
        activated = value
    }

    func start(runId: String, prompt: String) {
        guard activated else {
            Task {
                await emitter.emit(RunEvent(
                    protocolVersion: protocolVersion,
                    type: "failure",
                    runId: runId,
                    content: nil,
                    reason: "provider-not-activated"
                ))
            }
            return
        }
        if tasks[runId] != nil {
            Task {
                await emitter.emit(RunEvent(
                    protocolVersion: protocolVersion,
                    type: "failure",
                    runId: runId,
                    content: nil,
                    reason: "provider-concurrent-request"
                ))
            }
            return
        }

        tasks[runId] = Task { @MainActor [weak self] in
            do {
                let session = LanguageModelSession(
                    model: SystemLanguageModel.default,
                    instructions: "Answer plainly and do not use markdown."
                )
                for try await partial in session.streamResponse(to: prompt) {
                    try Task.checkCancellation()
                    await emitter.emit(RunEvent(
                        protocolVersion: protocolVersion,
                        type: "stream",
                        runId: runId,
                        content: partial.content,
                        reason: nil
                    ))
                }
                if !Task.isCancelled {
                    await emitter.emit(RunEvent(
                        protocolVersion: protocolVersion,
                        type: "complete",
                        runId: runId,
                        content: nil,
                        reason: nil
                    ))
                }
            } catch is CancellationError {
                // The host owns the terminal cancelled state; emit no late event.
            } catch {
                if !Task.isCancelled {
                    await emitter.emit(RunEvent(
                        protocolVersion: protocolVersion,
                        type: "failure",
                        runId: runId,
                        content: nil,
                        reason: generationFailureReason(error)
                    ))
                }
            }
            await self?.finish(runId: runId)
        }
    }

    private func finish(runId: String) {
        tasks.removeValue(forKey: runId)
    }

    func cancel(runId: String) {
        tasks.removeValue(forKey: runId)?.cancel()
    }

    func cancelAll() {
        for task in tasks.values {
            task.cancel()
        }
        tasks.removeAll()
    }
}

@main
private struct AppleSystemModelHelper {
    static func main() async {
        let emitter = ProtocolEmitter()
        let runs = RunRegistry(emitter: emitter)
        await emitter.emit(Handshake(
            protocolVersion: protocolVersion,
            type: "handshake",
            helperVersion: "1"
        ))

        let decoder = JSONDecoder()
        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                guard let data = line.data(using: .utf8),
                      let command = try? decoder.decode(Command.self, from: data),
                      isExactInboundCommand(data) else {
                    exit(70)
                }
                if command.type == "start",
                   let runId = command.runId,
                   let prompt = command.prompt {
                    await runs.start(runId: runId, prompt: prompt)
                    continue
                }
                if command.type == "cancel", let runId = command.runId {
                    await runs.cancel(runId: runId)
                    continue
                }
                guard command.type == "activate", let requestId = command.requestId else {
                    continue
                }

                let model = SystemLanguageModel.default
                switch model.availability {
                case .available:
                    await runs.setActivated(true)
                    await emitter.emit(Activation(
                        protocolVersion: protocolVersion,
                        type: "activation",
                        requestId: requestId,
                        availability: "available",
                        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
                        osBuild: currentOSBuild(),
                        reason: nil
                    ))
                case .unavailable(let reason):
                    await runs.setActivated(false)
                    await emitter.emit(Activation(
                        protocolVersion: protocolVersion,
                        type: "activation",
                        requestId: requestId,
                        availability: "unavailable",
                        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
                        osBuild: currentOSBuild(),
                        reason: String(describing: reason)
                    ))
                }
            }
        } catch {
            // EOF and input failures terminate all active generation below.
        }
        await runs.cancelAll()
    }
}
