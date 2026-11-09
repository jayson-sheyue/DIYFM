import Foundation
import CryptoKit

let root = FileManager.default.temporaryDirectory.appendingPathComponent("DIYFM-FileTests-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: root) }
let files = try NativeFiles(root: root)
var bytes = Data(repeating: 0, count: 80)
bytes.replaceSubrange(0..<4, with: Data("RIFF".utf8)); bytes.replaceSubrange(8..<12, with: Data("WAVE".utf8))
let key = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
let begin = try files.begin(["kind":"media", "id":key, "size":bytes.count])
let ticket = begin["ticket"] as! String
func rejects(_ operation: () throws -> Void) { do { try operation(); fatalError("An invalid transfer was accepted") } catch {} }
rejects { _ = try files.chunk(["ticket":ticket, "offset":1, "data":bytes.base64EncodedString()]) }
rejects { _ = try files.commit(ticket) }
_ = try files.chunk(["ticket":ticket, "offset":0, "data":bytes.base64EncodedString()])
_ = try files.commit(ticket)
let persisted = try Data(contentsOf: files.audio(key)); assert(persisted == bytes)
let cached = try files.begin(["kind":"media", "id":key, "size":bytes.count]); assert(cached["exists"] as? Bool == true)
let bad = try files.begin(["kind":"media", "id":String(repeating:"a",count:64), "size":bytes.count])["ticket"] as! String
_ = try files.chunk(["ticket":bad, "offset":0, "data":bytes.base64EncodedString()])
rejects { _ = try files.commit(bad) }; _ = files.abort(bad)
rejects { _ = try files.audio("../outside") }
let destination = root.appendingPathComponent("original.mp3")
let old = Data("old complete file".utf8); try old.write(to: destination)
let output = try files.begin(["kind":"export", "size":bytes.count], destination:destination)["ticket"] as! String
rejects { _ = try files.commit(output) }
let retained = try Data(contentsOf:destination); assert(retained == old)
_ = try files.chunk(["ticket":output, "offset":0, "data":bytes.base64EncodedString()]); _ = try files.commit(output)
let replaced = try Data(contentsOf:destination); assert(replaced == bytes)
files.prune(keep:[])
let mediaPath = try files.audio(key).path; assert(!FileManager.default.fileExists(atPath:mediaPath))
print("Mac native file contracts passed: ordering, complete commit, source hash, traversal rejection, atomic replacement and pruning.")
