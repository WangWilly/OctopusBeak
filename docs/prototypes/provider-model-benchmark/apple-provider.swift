import Foundation
import FoundationModels

actor ToolRecorder {
    private(set) var calls: [String] = []

    func record(_ accountID: String) {
        calls.append(accountID)
    }
}

struct FinancialOverviewTool: Tool {
    let name = "read_financial_overview"
    let description = "Read a user-authorized financial overview by its exact identifier."
    let recorder: ToolRecorder

    @Generable
    struct Arguments {
        @Guide(description: "The exact user-authorized financial overview identifier.")
        var overviewID: String
    }

    func call(arguments: Arguments) async throws -> String {
        await recorder.record(arguments.overviewID)
        return "financial overview \(arguments.overviewID) is available"
    }
}

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

@main
struct AppleProviderProbe {
    static func main() async {
        let started = ContinuousClock.now
        let model = SystemLanguageModel.default

        guard case .available = model.availability else {
            emit([
                "kind": "unavailable",
                "availability": String(describing: model.availability),
            ])
            exit(2)
        }

        emit([
            "kind": "ready",
            "coldStartMs": milliseconds(since: started),
            "availability": "available",
        ])

        do {
            if let recoverIndex = CommandLine.arguments.firstIndex(of: "--recover"),
               CommandLine.arguments.indices.contains(recoverIndex + 1) {
                let checkpointID = CommandLine.arguments[recoverIndex + 1]
                let session = LanguageModelSession(
                    model: model,
                    instructions: "Repeat the checkpoint identifier from the user exactly and add nothing else."
                )
                let response = try await session.respond(
                    to: "Recovery context carries checkpoint \(checkpointID)."
                )
                emit([
                    "kind": "recovery",
                    "checkpoint": checkpointID,
                    "content": response.content,
                    "correct": response.content.contains(checkpointID),
                ])
                return
            }

            if CommandLine.arguments.contains("--tool") {
                let recorder = ToolRecorder()
                let session = LanguageModelSession(
                    model: model,
                    tools: [FinancialOverviewTool(recorder: recorder)],
                    instructions: "Always use the supplied tool when the user asks for an authorized financial overview. Never invent its result."
                )
                let response = try await session.respond(
                    to: "Use read_financial_overview exactly once with overviewID benchmark-overview-68, then briefly report the tool result."
                )
                emit([
                    "kind": "toolResult",
                    "calls": await recorder.calls,
                    "content": response.content,
                    "correct": await recorder.calls == ["benchmark-overview-68"],
                ])
                return
            }

            let session = LanguageModelSession(
                model: model,
                instructions: "Answer plainly and do not use markdown."
            )
            let inferenceStarted = ContinuousClock.now
            var firstPartialMs: Double?
            var finalContent = ""
            for try await partial in session.streamResponse(
                to: "In about 80 words, explain why an application must keep credentials outside a model context."
            ) {
                if firstPartialMs == nil {
                    firstPartialMs = milliseconds(since: inferenceStarted)
                    emit([
                        "kind": "firstPartial",
                        "ttftMs": firstPartialMs!,
                    ])
                }
                finalContent = partial.content
            }
            emit([
                "kind": "completion",
                "ttftMs": firstPartialMs ?? -1,
                "totalMs": milliseconds(since: inferenceStarted),
                "characters": finalContent.count,
                "content": finalContent,
            ])
        } catch {
            emit([
                "kind": "error",
                "message": String(describing: error),
            ])
            exit(1)
        }
    }

    static func milliseconds(since start: ContinuousClock.Instant) -> Double {
        let duration = start.duration(to: .now)
        return Double(duration.components.seconds) * 1000
            + Double(duration.components.attoseconds) / 1_000_000_000_000_000
    }
}
