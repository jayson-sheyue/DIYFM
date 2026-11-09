import Foundation
import CryptoKit

final class NativeFiles {
    struct Upload { let file: URL; let size: Int; let key: String?; let destination: URL? }
    let media: URL
    let staging: URL
    private var uploads: [String: Upload] = [:]
    init(root: URL) throws {
        media = root.appendingPathComponent("AudioCache", isDirectory: true)
        staging = root.appendingPathComponent("Transfers", isDirectory: true)
        for directory in [media, staging] { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        for file in (try? FileManager.default.contentsOfDirectory(at: staging, includingPropertiesForKeys: nil)) ?? [] { try? FileManager.default.removeItem(at: file) }
    }
    func audio(_ key: String) throws -> URL {
        guard key.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw failure() }
        return media.appendingPathComponent(key + ".wav")
    }
    func begin(_ data: [String: Any], destination: URL? = nil) throws -> [String: Any] {
        guard let size = data["size"] as? Int, size > 0, size <= 500 * 1024 * 1024 else { throw failure() }
        let key = data["kind"] as? String == "media" ? data["id"] as? String : nil
        if let key = key {
            let file = try audio(key)
            if let attributes = try? FileManager.default.attributesOfItem(atPath: file.path), attributes[.size] as? Int == size { return ["exists": true] }
        } else if destination == nil { throw failure() }
        let ticket = UUID().uuidString
        let file = staging.appendingPathComponent(ticket + ".part")
        guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw failure() }
        uploads[ticket] = Upload(file: file, size: size, key: key, destination: destination)
        return ["ticket": ticket]
    }
    func chunk(_ data: [String: Any]) throws -> [String: Any] {
        guard let ticket = data["ticket"] as? String, let upload = uploads[ticket], let offset = data["offset"] as? Int, let encoded = data["data"] as? String, encoded.count <= 300000, let bytes = Data(base64Encoded: encoded), bytes.count <= 192 * 1024 else { throw failure() }
        let handle = try FileHandle(forWritingTo: upload.file); defer { try? handle.close() }
        let current = try handle.seekToEnd()
        guard current == offset, offset + bytes.count <= upload.size else { throw failure() }
        try handle.write(contentsOf: bytes)
        return ["written": offset + bytes.count]
    }
    func commit(_ ticket: String) throws -> [String: Any] {
        guard let upload = uploads[ticket] else { throw failure() }
        let attributes = try FileManager.default.attributesOfItem(atPath: upload.file.path)
        guard attributes[.size] as? Int == upload.size else { throw failure() }
        if let key = upload.key {
            let bytes = try Data(contentsOf: upload.file, options: .mappedIfSafe)
            let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            guard hash == key, bytes.count >= 44, String(decoding: bytes.prefix(4), as: UTF8.self) == "RIFF", String(decoding: bytes[8..<12], as: UTF8.self) == "WAVE" else { throw failure() }
            let target = try audio(key)
            if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: upload.file) }
            else { try FileManager.default.moveItem(at: upload.file, to: target) }
        } else if let destination = upload.destination {
            // Stage beside the destination, then atomically replace only after the full transfer is verified.
            let temporary = destination.deletingLastPathComponent().appendingPathComponent(".diyfm-\(UUID().uuidString).tmp")
            defer { try? FileManager.default.removeItem(at: temporary) }
            try FileManager.default.copyItem(at: upload.file, to: temporary)
            if FileManager.default.fileExists(atPath: destination.path) { _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary) }
            else { try FileManager.default.moveItem(at: temporary, to: destination) }
            try FileManager.default.removeItem(at: upload.file)
        } else { throw failure() }
        uploads.removeValue(forKey: ticket)
        return ["saved": true]
    }
    func abort(_ ticket: String) -> [String: Any] { if let upload = uploads.removeValue(forKey: ticket) { try? FileManager.default.removeItem(at: upload.file) }; return [:] }
    func prune(keep: Set<String>) {
        for file in (try? FileManager.default.contentsOfDirectory(at: media, includingPropertiesForKeys: nil)) ?? [] {
            if !keep.contains(file.deletingPathExtension().lastPathComponent) { try? FileManager.default.removeItem(at: file) }
        }
    }
    private func failure() -> Error { NSError(domain: "DIYFM.Transfer", code: 1) }
}
