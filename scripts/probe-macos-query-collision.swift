import AppKit
import Foundation
import Darwin

final class CompletionBox: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: [String: Any]?
  func set(_ value: [String: Any]) { lock.lock(); defer { lock.unlock() }; stored = value }
  func get() -> [String: Any]? { lock.lock(); defer { lock.unlock() }; return stored }
}

func errors(_ error: NSError) -> [[String: Any]] {
  var result: [[String: Any]] = [["domain": error.domain, "code": error.code]]
  if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError { result += errors(underlying) }
  return result
}

let app = URL(fileURLWithPath: CommandLine.arguments[1])
let directory = URL(fileURLWithPath: CommandLine.arguments[2])
let embedded = app.appendingPathComponent("Contents/Resources/Control Center.app")
let executable = embedded.appendingPathComponent("Contents/MacOS/Codex Router")
let query = Process()
query.executableURL = executable
query.arguments = ["--query-lifecycle"]
var environment = ProcessInfo.processInfo.environment
environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
environment["MODEL_ROUTER_STATE_DIR"] = directory.path
environment["CODEX_HOME"] = directory.appendingPathComponent("codex").path
query.environment = environment
let output = Pipe()
query.standardOutput = output
query.standardError = FileHandle.nullDevice
try query.run()
var stopped = false
defer {
  if stopped { kill(query.processIdentifier, SIGCONT) }
  if query.isRunning { kill(query.processIdentifier, SIGKILL) }
  query.waitUntilExit()
}
let registrationDeadline = Date().addingTimeInterval(5)
var registered: [String: Any]?
while Date() < registrationDeadline {
  if let running = NSRunningApplication(processIdentifier: query.processIdentifier),
     running.bundleIdentifier == "io.github.codex-router.control-center", !running.isTerminated {
    if kill(query.processIdentifier, SIGSTOP) == 0 {
      stopped = true
      registered = ["pid": running.processIdentifier, "finishedLaunching": running.isFinishedLaunching]
    }
    break
  }
  usleep(1000)
}
guard let registered, stopped else { fatalError("Could not establish query-registration barrier") }

func openEmbedded() -> [String: Any] {
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = true
  configuration.environment = [
    "CODEX_ROUTER_EMBEDDED_CONTROL_CENTER": "1",
    "MODEL_ROUTER_STATE_DIR": directory.path,
    "CODEX_HOME": directory.appendingPathComponent("codex").path,
    "CODEX_ROUTER_SOURCE_ROOT": environment["CODEX_ROUTER_SOURCE_ROOT"]!,
  ]
  let box = CompletionBox()
  NSWorkspace.shared.openApplication(at: embedded, configuration: configuration) { application, error in
    var value: [String: Any] = [:]
    if let application { value["pid"] = application.processIdentifier }
    if let error { value["errors"] = errors(error as NSError) }
    box.set(value)
  }
  let deadline = Date().addingTimeInterval(5)
  while Date() < deadline {
    if let value = box.get() { return value }
    RunLoop.main.run(until: Date().addingTimeInterval(0.01))
  }
  return ["timeout": true]
}

let collision = openEmbedded()
kill(query.processIdentifier, SIGCONT)
stopped = false
query.waitUntilExit()
let queryOutput = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
// Allow registration teardown to complete; this is experimental sequencing,
// not a retry in the production launcher or in the proposed CI fix.
let exitDeadline = Date().addingTimeInterval(5)
while Date() < exitDeadline {
  if NSRunningApplication.runningApplications(withBundleIdentifier: "io.github.codex-router.control-center").isEmpty { break }
  RunLoop.main.run(until: Date().addingTimeInterval(0.01))
}
let noQuery = openEmbedded()
let result: [String: Any] = ["queryBarrier": registered, "withQuery": collision, "queryExit": query.terminationStatus, "queryOutput": queryOutput, "withoutQuery": noQuery]
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
try data.write(to: directory.appendingPathComponent("collision.json"))
print(String(data: data, encoding: .utf8)!)
for application in NSRunningApplication.runningApplications(withBundleIdentifier: "io.github.codex-router.control-center") { application.terminate() }
guard collision["errors"] != nil, noQuery["pid"] != nil else { exit(1) }
