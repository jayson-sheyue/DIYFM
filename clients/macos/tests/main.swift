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

let webRoot = root.appendingPathComponent("web/catalog/packages", isDirectory: true)
try FileManager.default.createDirectory(at: webRoot, withIntermediateDirectories: true)
let zipPayload = Data((0..<(7 * 1024 * 1024 + 321)).map { UInt8($0 & 0xff) })
let zipHash = SHA256.hash(data: zipPayload).map { String(format: "%02x", $0) }.joined()
try zipPayload.write(to: webRoot.appendingPathComponent("starter.zip"))
let server = LocalServer(root: root.appendingPathComponent("web"))
let okReq = Data("GET /catalog/packages/starter.zip HTTP/1.1\r\nHost: 127.0.0.1:24618\r\n\r\n".utf8)
let okResp = server.resolveResponse(for: okReq)
assert(okResp?.status == "200 OK", "Expected 200 OK for >4MB bundled starter zip")
assert(okResp?.type == "application/zip", "Expected application/zip MIME type")
assert(okResp?.data.count == zipPayload.count, "Bundled starter zip byte count truncated")
let fetchedHash = SHA256.hash(data: okResp!.data).map { String(format: "%02x", $0) }.joined()
assert(fetchedHash == zipHash, "Bundled starter zip SHA-256 mismatch")

let badHostReq = Data("GET /catalog/packages/starter.zip HTTP/1.1\r\nHost: evil.example\r\n\r\n".utf8)
assert(server.resolveResponse(for: badHostReq)?.status == "400 Bad Request", "Expected 400 for invalid Host header")
let escapeReq = Data("GET /../original.mp3 HTTP/1.1\r\nHost: 127.0.0.1:24618\r\n\r\n".utf8)
assert(server.resolveResponse(for: escapeReq)?.status == "404 Not Found", "Expected 404 for path traversal")

print("Mac native file & local server contracts passed: ordering, complete commit, source hash, traversal rejection, atomic replacement, pruning, and >4MB zip resolution.")
