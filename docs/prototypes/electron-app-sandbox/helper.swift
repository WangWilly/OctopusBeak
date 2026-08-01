/*
 * THROWAWAY PROTOTYPE — real Swift helper for packaged Electron probing.
 */

import Darwin
import Foundation
import Network

struct Ready: Codable {
    let event: String
    let pid: Int32
    let port: UInt16?
    let modelRead: Bool
    let modelBytes: Int
    let insideWrite: Bool
    let outsideWrite: Bool
    let mode: String
}

func attemptWrite(_ value: String, to path: String) -> Bool {
    do {
        try value.write(toFile: path, atomically: true, encoding: .utf8)
        return true
    } catch {
        return false
    }
}

func emit(_ ready: Ready) {
    let data = try! JSONEncoder().encode(ready)
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

let arguments = CommandLine.arguments
guard arguments.count == 5 else {
    fputs("usage: probe-helper serve|crash model-path inside-path outside-path\n", stderr)
    exit(64)
}

let mode = arguments[1]
let modelPath = arguments[2]
let insidePath = arguments[3]
let outsidePath = arguments[4]
let model = try? Data(contentsOf: URL(fileURLWithPath: modelPath))
let insideWrite = attemptWrite("inside", to: insidePath)
let outsideWrite = attemptWrite("outside", to: outsidePath)

if mode == "crash" {
    emit(Ready(
        event: "crash-injected",
        pid: getpid(),
        port: nil,
        modelRead: model != nil,
        modelBytes: model?.count ?? 0,
        insideWrite: insideWrite,
        outsideWrite: outsideWrite,
        mode: mode
    ))
    exit(42)
}

let queue = DispatchQueue(label: "octopusbeak.throwaway.loopback")
let listener = try NWListener(using: .tcp, on: .any)
listener.newConnectionHandler = { connection in
    connection.start(queue: queue)
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1024) { _, _, _, _ in
        connection.send(content: Data("pong".utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
listener.stateUpdateHandler = { state in
    switch state {
    case .ready:
        emit(Ready(
            event: "ready",
            pid: getpid(),
            port: listener.port?.rawValue,
            modelRead: model != nil,
            modelBytes: model?.count ?? 0,
            insideWrite: insideWrite,
            outsideWrite: outsideWrite,
            mode: mode
        ))
    case .failed(let error):
        fputs("listener-failed: \(error)\n", stderr)
        exit(70)
    default:
        break
    }
}
listener.start(queue: queue)
dispatchMain()
