import ExpoModulesCore
import Foundation

public final class ModelFileHashModule: Module {
  private let worker = DispatchQueue(label: "drivesense.model-sha256", qos: .utility)
  private let lock = NSLock()
  private var active: String?
  private var cancelled: [String] = []

  private func isCancelled(_ id: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return cancelled.contains(id)
  }

  public func definition() -> ModuleDefinition {
    Name("ModelFileHash")
    Events("hashProgress")
    AsyncFunction("cancelHash") { (id: String) in
      self.lock.lock(); defer { self.lock.unlock() }
      self.cancelled.append(id)
      self.cancelled = Array(self.cancelled.suffix(64))
    }
    AsyncFunction("hashFile") { (uri: String, id: String, size: Double, promise: Promise) in
      guard size.isFinite, size > 0, size <= Double(Int32.max), size.rounded() == size else {
        promise.reject("HASH_SIZE", "Invalid expected file size"); return
      }
      self.lock.lock()
      guard self.active == nil else {
        self.lock.unlock(); promise.reject("HASH_BUSY", "Another native hash is active"); return
      }
      self.active = id
      self.lock.unlock()
      self.worker.async {
        // Do not resolve/reject until the descriptor is closed and ownership cleared.
        var output: [String: Any]?
        var failure: Error?
        do {
          guard let url = URL(string: uri), url.isFileURL else { throw FileHashError.invalidSize }
          let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("gemma-poc").resolvingSymlinksInPath().path + "/"
          let resolved = url.resolvingSymlinksInPath().standardizedFileURL
          guard resolved.path.hasPrefix(root) else { throw FileHashError.invalidSize }
          let digest = try streamFileSHA256(resolved, expectedBytes: Int64(size),
            cancelled: { self.isCancelled(id) }, progress: { bytes in
              self.sendEvent("hashProgress", ["requestId": id, "bytes": bytes, "total": Int64(size)])
            })
          output = ["requestId": id, "bytes": Int64(size), "sha256": digest]
        } catch { failure = error }
        self.lock.lock()
        self.active = nil
        self.cancelled.removeAll { $0 == id }
        self.lock.unlock()
        if let output { promise.resolve(output) }
        else { promise.reject("HASH_FAILED", "Native SHA-256 failed: \(String(describing: failure!))") }
      }
    }
    OnDestroy {
      self.lock.lock(); defer { self.lock.unlock() }
      if let id = self.active { self.cancelled.append(id) }
    }
  }
}
