import Foundation
import AVFoundation
import MediaPlayer

final class NativePlayer {
    struct Track { let id: String; let key: String; let title: String; let file: URL }
    private let player = AVPlayer()
    private var tracks: [Track] = []
    private var index = 0
    private var mode = "once"
    private var speed: Float = 1
    private var endObserver: NSObjectProtocol?
    private var timeObserver: Any?
    private var ended = false
    private var wantsPlay = false
    private(set) var revision = 0
    var activeKeys: Set<String> { Set(tracks.map { $0.key }) }
    init() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in DispatchQueue.main.async { self?.resume() }; return .success }
        center.pauseCommand.addTarget { [weak self] _ in DispatchQueue.main.async { self?.pause() }; return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in DispatchQueue.main.async { if self?.wantsPlay == true { self?.pause() } else { self?.resume() } }; return .success }
        center.nextTrackCommand.addTarget { [weak self] _ in DispatchQueue.main.async { self?.advance(1) }; return .success }
        center.previousTrackCommand.addTarget { [weak self] _ in DispatchQueue.main.async { self?.advance(-1) }; return .success }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            DispatchQueue.main.async { self?.seek(event.positionTime) }; return .success
        }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in self?.nowPlaying() }
    }
    deinit {
        if let token = endObserver { NotificationCenter.default.removeObserver(token) }
        if let token = timeObserver { player.removeTimeObserver(token) }
    }
    func route(_ command: String, data: [String: Any], files: NativeFiles) throws -> [String: Any] {
        if command == "player.state" { return state() }
        guard let incoming = data["revision"] as? Int else { throw failure() }
        if incoming < revision { return state() }
        revision = incoming
        switch command {
        case "player.load":
            guard let values = data["tracks"] as? [[String: Any]], !values.isEmpty, values.count <= 1000, let selected = data["selected"] as? String else { throw failure() }
            let items = try values.map { value -> Track in
                guard let id = value["id"] as? String, let key = value["key"] as? String, let title = value["title"] as? String else { throw failure() }
                let file = try files.audio(key)
                guard FileManager.default.fileExists(atPath: file.path) else { throw failure() }
                return Track(id: id, key: key, title: String(title.prefix(240)), file: file)
            }
            guard let position = items.firstIndex(where: { $0.id == selected }) else { throw failure() }
            try configure(data); tracks = items; index = position; loadCurrent()
        case "player.reconcile":
            guard let ids = data["ids"] as? [String], ids.count <= 100000 else { throw failure() }
            let current = tracks.indices.contains(index) ? tracks[index].id : ""
            tracks = tracks.filter { ids.contains($0.id) }
            if let position = tracks.firstIndex(where: { $0.id == current }) { index = position }
            else { pause(); tracks = []; player.replaceCurrentItem(with: nil); MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
        case "player.play": resume()
        case "player.pause": pause()
        case "player.stop": pause(); tracks = []; player.replaceCurrentItem(with: nil); ended = false; MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        case "player.seek": guard let time = data["time"] as? Double, time.isFinite else { throw failure() }; seek(time)
        case "player.configure": try configure(data); if wantsPlay { player.rate = speed }
        default: throw failure()
        }
        return state()
    }
    private func configure(_ data: [String: Any]) throws {
        guard let mode = data["mode"] as? String, ["single", "channel", "once"].contains(mode), let rate = data["rate"] as? Double, rate.isFinite, rate >= 0.5, rate <= 2 else { throw failure() }
        self.mode = mode; self.speed = Float(rate)
    }
    private func loadCurrent() {
        guard tracks.indices.contains(index) else { return }
        if let token = endObserver { NotificationCenter.default.removeObserver(token) }
        let item = AVPlayerItem(url: tracks[index].file)
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            guard let self = self, self.wantsPlay, self.player.currentItem === item else { return }
            if self.mode == "once" { self.ended = true; self.wantsPlay = false; self.nowPlaying() }
            else { if self.mode == "channel" { self.index = (self.index + 1) % self.tracks.count }; self.loadCurrent() }
        }
        ended = false; wantsPlay = true; player.replaceCurrentItem(with: item); player.playImmediately(atRate: speed); nowPlaying()
    }
    private func resume() { guard !tracks.isEmpty else { return }; if ended { seek(0) }; ended = false; wantsPlay = true; player.playImmediately(atRate: speed); nowPlaying() }
    private func pause() { wantsPlay = false; player.pause(); nowPlaying() }
    private func seek(_ time: Double) { player.seek(to: CMTime(seconds: max(0, time), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero); ended = false }
    private func advance(_ by: Int) { guard !tracks.isEmpty else { return }; index = (index + by + tracks.count) % tracks.count; loadCurrent() }
    private func seconds(_ time: CMTime) -> Double { let value = CMTimeGetSeconds(time); return value.isFinite ? max(0, value) : 0 }
    func state() -> [String: Any] {
        let track = tracks.indices.contains(index) ? tracks[index] : nil
        return ["revision": revision, "id": track?.id ?? "", "title": track?.title ?? "", "paused": !wantsPlay, "ended": ended, "time": seconds(player.currentTime()), "duration": player.currentItem.map { seconds($0.duration) } ?? 0, "rate": speed, "error": player.currentItem?.status == .failed ? "playback" : ""]
    }
    private func nowPlaying() {
        guard tracks.indices.contains(index) else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: tracks[index].title, MPMediaItemPropertyArtist: "DIYFM", MPMediaItemPropertyPlaybackDuration: player.currentItem.map { seconds($0.duration) } ?? 0, MPNowPlayingInfoPropertyElapsedPlaybackTime: seconds(player.currentTime()), MPNowPlayingInfoPropertyPlaybackRate: wantsPlay ? speed : 0]
        MPNowPlayingInfoCenter.default().playbackState = wantsPlay ? .playing : .paused
    }
    private func failure() -> Error { NSError(domain: "DIYFM.Player", code: 1) }
}
