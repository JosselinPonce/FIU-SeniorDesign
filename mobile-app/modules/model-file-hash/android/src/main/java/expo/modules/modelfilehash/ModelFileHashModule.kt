package expo.modules.modelfilehash

import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.Executors

class ModelFileHashModule : Module() {
  private val worker = Executors.newSingleThreadExecutor()
  private val lock = Any()
  private var active: String? = null
  private val cancelled = LinkedHashSet<String>()

  override fun definition() = ModuleDefinition {
    Name("ModelFileHash")
    Events("hashProgress")
    AsyncFunction("cancelHash") { id: String -> synchronized(lock) {
      cancelled.add(id)
      if (cancelled.size > 64) cancelled.remove(cancelled.first())
    }; Unit }
    AsyncFunction("hashFile") { uri: String, id: String, size: Double, promise: Promise ->
      if (!size.isFinite() || size <= 0 || size > Int.MAX_VALUE || size % 1 != 0.0) {
        promise.reject("HASH_SIZE", "Invalid expected file size", null)
      } else {
        val accepted = synchronized(lock) { if (active != null) false else { active = id; true } }
        if (!accepted) promise.reject("HASH_BUSY", "Another native hash is active", null)
        else worker.execute {
          var output: Map<String, Any>? = null
          var failure: Exception? = null
          try {
            val parsed = Uri.parse(uri)
            require(parsed.scheme == "file") { "Only app-private files are permitted" }
            val root = File(appContext.persistentFilesDirectory, "gemma-poc").canonicalPath + File.separator
            val file = File(requireNotNull(parsed.path)).canonicalFile
            require(file.path.startsWith(root) && file.isFile && file.length() == size.toLong()) { "Invalid model path or size" }
            val modified = file.lastModified()
            val digest = MessageDigest.getInstance("SHA-256")
            var bytes = 0L
            var lastProgress = System.nanoTime()
            sendEvent("hashProgress", mapOf("requestId" to id, "bytes" to bytes, "total" to size.toLong()))
            FileInputStream(file).use { stream ->
              val buffer = ByteArray(1024 * 1024)
              while (true) {
                check(!synchronized(lock) { cancelled.contains(id) }) { "Hash cancelled" }
                val count = stream.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count); bytes += count
                require(bytes <= size.toLong()) { "File grew during verification" }
                val now = System.nanoTime()
                if (now - lastProgress >= 200_000_000 || bytes == size.toLong()) {
                  sendEvent("hashProgress", mapOf("requestId" to id, "bytes" to bytes, "total" to size.toLong()))
                  lastProgress = now
                }
              }
            }
            check(!synchronized(lock) { cancelled.contains(id) }) { "Hash cancelled" }
            require(bytes == size.toLong() && file.length() == bytes && file.lastModified() == modified) { "File changed during verification" }
            output = mapOf("requestId" to id, "bytes" to bytes, "sha256" to digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) })
          } catch (error: Exception) { failure = error }
          synchronized(lock) { active = null; cancelled.remove(id) }
          if (output != null) promise.resolve(output)
          else promise.reject("HASH_FAILED", "Native SHA-256 failed: ${failure?.message}", failure)
        }
      }
    }
    OnDestroy { synchronized(lock) { active?.let { cancelled.add(it) } }; worker.shutdown() }
  }
}
