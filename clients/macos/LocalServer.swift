import Foundation
import Network

final class LocalServer {
    static let port: UInt16 = 24618
    static let origin = "http://127.0.0.1:\(port)"
    private let queue = DispatchQueue(label: "io.github.jaysonsheyue.diyfm.web")
    private var listener: NWListener?
    private let root: URL
    init(root: URL) { self.root = root.standardizedFileURL.resolvingSymlinksInPath() }
    func start(completion: @escaping (Error?) -> Void) {
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: Self.port)!)
            let server = try NWListener(using: parameters)
            listener = server
            var reported = false
            server.stateUpdateHandler = { state in
                switch state {
                case .ready: if !reported { reported = true; DispatchQueue.main.async { completion(nil) } }
                case .failed(let error): if !reported { reported = true; DispatchQueue.main.async { completion(error) } }
                default: break
                }
            }
            server.newConnectionHandler = { [weak self] connection in
                connection.start(queue: self?.queue ?? .global())
                self?.read(connection, data: Data())
            }
            server.start(queue: queue)
        } catch { completion(error) }
    }
    func stop() { listener?.cancel() }
    private func read(_ connection: NWConnection, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] bytes, _, ended, error in
            guard let self = self else { connection.cancel(); return }
            var request = data; if let bytes = bytes { request.append(bytes) }
            guard request.count <= 16384, error == nil else { connection.cancel(); return }
            if request.range(of: Data("\r\n\r\n".utf8)) != nil {
                self.respond(connection, request: request)
            } else if !ended { self.read(connection, data: request) } else { connection.cancel() }
        }
    }
    private func respond(_ connection: NWConnection, request: Data) {
        let lines = String(decoding: request, as: UTF8.self).components(separatedBy: "\r\n")
        let first = (lines.first ?? "").split(separator: " ")
        let allowedHost = lines.contains { $0.lowercased() == "host: 127.0.0.1:\(Self.port)" }
        guard first.count == 3, ["GET", "HEAD"].contains(String(first[0])), allowedHost else { send(connection, status: "400 Bad Request", type: "text/plain", data: Data()); return }
        let raw = String(first[1]).components(separatedBy: "?")[0]
        guard let path = raw.removingPercentEncoding, !path.contains("\0") else { connection.cancel(); return }
        let relative = path == "/" ? "index.html" : String(path.dropFirst())
        let file = root.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.path + "/"), let bytes = try? Data(contentsOf: file), bytes.count <= 4 * 1024 * 1024 else {send(connection, status: "404 Not Found", type: "text/plain", data: Data()); return}
        let types = ["html":"text/html; charset=utf-8", "mjs":"application/javascript", "js":"application/javascript", "css":"text/css", "svg":"image/svg+xml", "txt":"text/plain", "json":"application/json"]
        send(connection, status: "200 OK", type: types[file.pathExtension] ?? "application/octet-stream", data: bytes, head: first[0] == "HEAD")
    }
    private func send(_ connection: NWConnection, status: String, type: String, data: Data, head: Bool = false) {
        var response = Data("HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(data.count)\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n".utf8)
        if !head { response.append(data) }
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
}
