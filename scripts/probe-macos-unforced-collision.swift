import AppKit
import Foundation
import Darwin

final class ResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var value: [String: Any]?
  func set(_ result: [String: Any]) { lock.lock(); defer { lock.unlock() }; value = result }
  func get() -> [String: Any]? { lock.lock(); defer { lock.unlock() }; return value }
}
func errorChain(_ error: NSError) -> [[String: Any]] {
  var result: [[String: Any]] = [["domain": error.domain, "code": error.code]]
  if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError { result += errorChain(underlying) }
  return result
}
func clean() {
  let deadline = Date().addingTimeInterval(5)
  while Date() < deadline {
    let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "io.github.codex-router.control-center")
    if apps.isEmpty { return }
    for app in apps { app.terminate() }
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
  }
}
let app = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("Contents/Resources/Control Center.app")
let root = URL(fileURLWithPath: CommandLine.arguments[2])
var rows: [[String: Any]] = []
defer { clean() }
for trial in 0..<8 {
  clean()
  let state = root.appendingPathComponent("unforced-\(trial)")
  try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
  var environment = ProcessInfo.processInfo.environment
  environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
  environment["MODEL_ROUTER_STATE_DIR"] = state.path
  environment["CODEX_HOME"] = state.appendingPathComponent("codex").path
  let query = Process()
  query.executableURL = app.appendingPathComponent("Contents/MacOS/Codex Router")
  query.arguments = ["--query-lifecycle"]
  query.environment = environment
  query.standardOutput = FileHandle.nullDevice
  query.standardError = FileHandle.nullDevice
  try query.run()
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = true
  configuration.environment = [
    "CODEX_ROUTER_EMBEDDED_CONTROL_CENTER": "1",
    "MODEL_ROUTER_STATE_DIR": state.path,
    "CODEX_HOME": state.appendingPathComponent("codex").path,
    "CODEX_ROUTER_SOURCE_ROOT": environment["CODEX_ROUTER_SOURCE_ROOT"]!,
  ]
  let box = ResultBox()
  NSWorkspace.shared.openApplication(at: app, configuration: configuration) { application, error in
    var result: [String: Any] = [:]
    if let application { result["pid"] = application.processIdentifier }
    if let error { result["errors"] = errorChain(error as NSError) }
    box.set(result)
  }
  let deadline = Date().addingTimeInterval(5)
  while Date() < deadline && box.get() == nil { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
  var row = box.get() ?? ["timeout": true]
  row["trial"] = trial
  row["queryPID"] = query.processIdentifier
  if query.isRunning && Date() >= deadline { query.terminate() }
  query.waitUntilExit()
  row["queryExit"] = query.terminationStatus
  rows.append(row)
  print(String(data: try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!)
}
try JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent("unforced.json"))
