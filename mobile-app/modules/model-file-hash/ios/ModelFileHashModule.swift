import ExpoModulesCore
import Foundation

// BEGIN DEBUG GEMMA MEMORY
#if DEBUG
import Darwin
import os

// Point-in-time values only. No peak, allocation ownership or driver data.
private func gemmaDiagnosticMemorySnapshot() -> [String: Any] {
  var info = task_vm_info_data_t()
  var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
  let result = withUnsafeMutablePointer(to: &info) { pointer in
    pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
      task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
    }
  }
  return ["status": "available", "devicePhysicalBytes": ProcessInfo.processInfo.physicalMemory,
          "availableToProcessBytes": os_proc_available_memory(),
          "residentBytes": result == KERN_SUCCESS ? info.resident_size as Any : NSNull(),
          "physicalFootprintBytes": result == KERN_SUCCESS ? info.phys_footprint as Any : NSNull(),
          "uptimeMs": ProcessInfo.processInfo.systemUptime * 1000]
}
#endif
// END DEBUG GEMMA MEMORY

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
#if DEBUG
    AsyncFunction("gemmaMemorySnapshot") { () -> [String: Any] in
      gemmaDiagnosticMemorySnapshot()
    }
#endif
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
