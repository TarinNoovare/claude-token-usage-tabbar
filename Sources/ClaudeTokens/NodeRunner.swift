import Foundation

enum RunResult {
    case success(Data)       // stdout (authoritative)
    case launchFailed(String) // couldn't start node (e.g. ENOENT) → re-resolve path
    case failure(String)      // ran but exited nonzero with no usable stdout
}

// Runs `node <script>` off the main thread and returns its stdout. Drains
// stdout+stderr concurrently before waitUntilExit() to avoid the 64KB pipe
// deadlock, with a hard watchdog in case node hangs.
final class NodeRunner {
    private let queue = DispatchQueue(label: "com.claudetokens.node")

    func run(nodePath: String, script: String, completion: @escaping (RunResult) -> Void) {
        queue.async {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: nodePath)
            proc.arguments = [script]

            // Give node a sane PATH so its own children (security, refresh.js)
            // resolve, since the GUI app's PATH is launchd-minimal.
            var env = ProcessInfo.processInfo.environment
            let nodeDir = (nodePath as NSString).deletingLastPathComponent
            env["PATH"] = "\(nodeDir):/usr/bin:/bin:/usr/sbin:/sbin"
            proc.environment = env

            let outPipe = Pipe()
            let errPipe = Pipe()
            proc.standardOutput = outPipe
            proc.standardError = errPipe

            do {
                try proc.run()
            } catch {
                completion(.launchFailed(error.localizedDescription))
                return
            }

            var outData = Data()
            var errData = Data()
            let group = DispatchGroup()
            group.enter()
            DispatchQueue.global().async {
                outData = outPipe.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }
            group.enter()
            DispatchQueue.global().async {
                errData = errPipe.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }

            // node's own timeouts are ~8-9s; hard-cap at 15s.
            let killer = DispatchWorkItem {
                if proc.isRunning { proc.terminate() }
            }
            self.queue.asyncAfter(deadline: .now() + 15, execute: killer)

            proc.waitUntilExit()
            killer.cancel()
            group.wait()

            if proc.terminationStatus != 0 && outData.isEmpty {
                let msg = String(data: errData, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                completion(.failure(msg.isEmpty ? "node exited \(proc.terminationStatus)" : msg))
            } else {
                completion(.success(outData))
            }
        }
    }
}
