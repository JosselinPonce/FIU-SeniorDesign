import Foundation
import CryptoKit

enum FileHashError: Error { case cancelled, invalidSize, changedFile }

/// Runs on the module's worker queue, with at most one 1 MiB Data chunk alive.
func streamFileSHA256(_ url: URL, expectedBytes: Int64,
                      cancelled: () -> Bool, progress: (Int64) -> Void) throws -> String {
  let before = try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey])
  guard before.isRegularFile == true, Int64(before.fileSize ?? -1) == expectedBytes else { throw FileHashError.invalidSize }
  let file = try FileHandle(forReadingFrom: url)
  defer { try? file.close() }
  var hash = SHA256()
  var bytes: Int64 = 0
  var lastProgress = ProcessInfo.processInfo.systemUptime
  progress(0)
  while true {
    if cancelled() { throw FileHashError.cancelled }
    let count = try autoreleasepool { () throws -> Int in
      let chunk = try file.read(upToCount: 1024 * 1024) ?? Data()
      hash.update(data: chunk)
      return chunk.count
    }
    if count == 0 { break }
    bytes += Int64(count)
    guard bytes <= expectedBytes else { throw FileHashError.invalidSize }
    let now = ProcessInfo.processInfo.systemUptime
    if now - lastProgress >= 0.2 || bytes == expectedBytes { progress(bytes); lastProgress = now }
  }
  if cancelled() { throw FileHashError.cancelled }
  let after = try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
  guard bytes == expectedBytes, after.fileSize == before.fileSize,
        after.contentModificationDate == before.contentModificationDate else { throw FileHashError.changedFile }
  return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
