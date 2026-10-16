// Murmur helper — menu-bar app that turns the fn key into a dictation toggle.
//
// fn (tap)  → start listening; fn again → stop and send.  Esc while listening → discard.
// Speech is recognized live (on-device when the Mac has the model) and streamed to the
// Murmur server over ws://…/helper, which fans it out to the chat web app. The audio is recorded
// at the same time and uploaded with the message, so people in the chat can play it back.
//
// Test hook: `Murmur --feed <audio file>` plays a file through the same recognizer
// instead of the mic (no fn tap, no pill, no sounds), sends it as one message, then quits.

import AVFoundation
import AppKit
import Speech

// Where messages go: the shared chat at copose.ai unless told otherwise.
//   defaults write com.andylee.murmur serverURL http://127.0.0.1:5320   (your own local server)
//   defaults write com.andylee.murmur displayName Sam                    (defaults to your first name)
//   defaults write com.andylee.murmur helperToken <token>                (the host only; = MURMUR_HELPER_TOKEN)
let settings = UserDefaults.standard
let serverBase = (settings.string(forKey: "serverURL") ?? ProcessInfo.processInfo.environment["MURMUR_URL"]
    ?? "https://copose.ai").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
let helperToken = settings.string(forKey: "helperToken") ?? ""
/// This install's identity in the chat (also handed to the browser by Open Chat).
let installKey: String = {
    if let k = settings.string(forKey: "installKey"), !k.isEmpty { return k }
    let k = UUID().uuidString
    settings.set(k, forKey: "installKey")
    return k
}()
let displayName = settings.string(forKey: "displayName")
    ?? NSFullUserName().split(separator: " ").first.map(String.init) ?? "Me"

func query(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
}

// --feed / --verbose print every recognizer result (with its text) to stderr for debugging.
let verbose = CommandLine.arguments.contains("--feed") || CommandLine.arguments.contains("--verbose")

func log(_ s: String) {
    FileHandle.standardError.write(("[murmur] " + s + "\n").data(using: .utf8)!)
}

// MARK: - Link: WebSocket to the server, reconnects forever

final class Link {
    private var task: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .default)
    private(set) var connected = false
    var onMessage: (([String: Any]) -> Void)?
    var onStatus: ((Bool) -> Void)?
    var role = "main" // a "feed" test instance streams text without taking over fn/toggle duty

    func connect() {
        let url = URL(string: serverBase.replacingOccurrences(of: "http", with: "ws")
            + "/helper?role=" + role + "&token=" + query(helperToken)
            + "&key=" + query(installKey) + "&name=" + query(displayName))!
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receive(t)
        t.sendPing { [weak self] err in
            DispatchQueue.main.async {
                guard let self, self.task === t else { return }
                if err != nil { return self.retry(t) }
                self.connected = true
                self.onStatus?(true)
            }
        }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.task === t else { return }
                switch result {
                case .success(.string(let s)):
                    if let d = s.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                        self.onMessage?(obj)
                    }
                    self.receive(t)
                case .success:
                    self.receive(t)
                case .failure:
                    self.retry(t)
                }
            }
        }
    }

    private func retry(_ t: URLSessionWebSocketTask) {
        guard task === t else { return }
        t.cancel(with: .goingAway, reason: nil)
        task = nil
        if connected {
            connected = false
            onStatus?(false)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.connect() }
    }

    func sendData(_ data: Data) {
        guard connected, let task else { return }
        task.send(.data(data)) { _ in }
    }

    func send(_ obj: [String: Any]) {
        guard connected, let task,
              let d = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: d, encoding: .utf8) else { return }
        task.send(.string(s)) { _ in }
    }
}

// MARK: - FnKey: listen-only event tap (needs Input Monitoring)

final class FnKey {
    var onTap: (() -> Void)?
    var onEscape: (() -> Void)?
    private var tap: CFMachPort?
    private var fnDown = false
    private var combo = false // fn was used as a modifier (fn+←, fn+F11 …) — not a dictation tap

    var running: Bool { tap != nil }

    func start() -> Bool {
        if tap != nil { return true }
        let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            Unmanaged<FnKey>.fromOpaque(refcon!).takeUnretainedValue().handle(type, event)
            return Unmanaged.passUnretained(event)
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: CGEventMask(mask), callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else { return false }
        self.tap = tap
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    private func handle(_ type: CGEventType, _ e: CGEvent) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        case .flagsChanged:
            let fn = e.flags.contains(.maskSecondaryFn)
            if fn != fnDown {
                fnDown = fn
                if fn {
                    // fn pressed together with ⌘/⌥/⌃/⇧ is a shortcut, not a tap
                    combo = !e.flags.intersection([.maskCommand, .maskAlternate, .maskControl, .maskShift]).isEmpty
                } else if !combo {
                    DispatchQueue.main.async { self.onTap?() }
                }
            } else if fnDown {
                combo = true // another modifier changed while fn is held
            }
        case .keyDown:
            if fnDown { combo = true }
            if e.getIntegerValueField(.keyboardEventKeycode) == 53 { // Esc
                DispatchQueue.main.async { self.onEscape?() }
            }
        default:
            break
        }
    }
}

// MARK: - Dictation: AVAudioEngine → SFSpeechRecognizer with live partials

final class Dictation {
    private let recognizer: SFSpeechRecognizer
    private var engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private let requestLock = NSLock()
    private var task: SFSpeechRecognitionTask?
    private var session = 0
    private var committed = "" // text from earlier recognition segments of this dictation
    private var current = ""
    // Word timings (seconds into the recording) for karaoke highlighting on playback, kept in
    // step with committed/current. audioIn = seconds of audio fed so far (under requestLock).
    private var committedWords: [Word] = []
    private var currentWords: [Word] = []
    private var audioIn: Double = 0
    private var lastHadMetadata = false
    private var restarts: [CFTimeInterval] = []
    private var finishing: ((String) -> Void)?
    private var finishTimer: DispatchWorkItem?
    private var feeding = false
    private(set) var active = false

    var onPartial: ((String) -> Void)?
    var onLevel: ((Float) -> Void)?
    var onError: ((String) -> Void)?

    init() {
        let preferred = Locale(identifier: Locale.preferredLanguages.first ?? "en-US")
        recognizer = SFSpeechRecognizer(locale: preferred) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
        recognizer.defaultTaskHint = .dictation
    }

    struct Word { let text: String; let start: Double; let duration: Double }

    var onDevice: Bool { recognizer.supportsOnDeviceRecognition }
    var words: [Word] { committedWords + currentWords }
    var text: String { join(committed, current) }

    // The recording people can play back: AAC in a temp .m4a, written from the same buffers
    // the recognizer hears. Guarded by requestLock (written on the audio thread).
    private var recorder: AVAudioFile?
    private var recordingURL: URL?

    private func openRecorder(_ format: AVAudioFormat) {
        _ = takeRecording()
        guard format.channelCount <= 2 else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("murmur-\(UUID().uuidString).m4a")
        let fileSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: format.channelCount,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        guard let file = try? AVAudioFile(forWriting: url, settings: fileSettings,
                                          commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        else { return log("couldn't start recording audio") }
        requestLock.lock()
        recorder = file
        recordingURL = url
        requestLock.unlock()
    }

    /// Finishes the recording and returns its bytes (nil when there is none).
    func takeRecording() -> Data? {
        requestLock.lock()
        let url = recordingURL
        recorder = nil // releasing the AVAudioFile finalizes the .m4a
        recordingURL = nil
        requestLock.unlock()
        guard let url else { return nil }
        defer { try? FileManager.default.removeItem(at: url) }
        return try? Data(contentsOf: url)
    }

    /// Start from the microphone.
    func start() throws {
        reset()
        engine = AVAudioEngine() // fresh engine picks up the current default input (AirPods etc.)
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "Murmur", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone input available"])
        }
        openRecorder(format)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.append(buffer)
        }
        engine.prepare()
        try engine.start()
        active = true
        beginTask()
    }

    /// Start from an audio file, streamed in real time (self-test).
    func startFeeding(_ url: URL, done: @escaping () -> Void) throws {
        reset()
        let file = try AVAudioFile(forReading: url)
        openRecorder(file.processingFormat)
        active = true
        feeding = true
        beginTask()
        let format = file.processingFormat
        DispatchQueue.global().async { [weak self] in
            let frames: AVAudioFrameCount = 4096
            while let self, self.feeding,
                  let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
                  (try? file.read(into: buf, frameCount: frames)) != nil, buf.frameLength > 0 {
                self.append(buf)
                Thread.sleep(forTimeInterval: Double(buf.frameLength) / format.sampleRate)
            }
            DispatchQueue.main.async(execute: done)
        }
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        requestLock.lock()
        request?.append(buffer)
        try? recorder?.write(from: buffer)
        audioIn += Double(buffer.frameLength) / buffer.format.sampleRate
        requestLock.unlock()
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += ch[i] * ch[i] }
        let db = 20 * log10(max(sqrt(sum / Float(buffer.frameLength)), 1e-6))
        let level = min(max((db + 58) / 38, 0), 1) // ~-58 dB room noise → 0, loud speech → 1
        DispatchQueue.main.async { self.onLevel?(level) }
    }

    private func reset() {
        session += 1
        committed = ""
        current = ""
        committedWords = []
        currentWords = []
        requestLock.lock()
        audioIn = 0
        requestLock.unlock()
        lastHadMetadata = false
        restarts = []
        finishing = nil
        finishTimer?.cancel()
    }

    private func beginTask() {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.taskHint = .dictation
        req.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        requestLock.lock()
        request = req
        let offset = audioIn // a restarted task's timestamps count from its own first buffer
        requestLock.unlock()
        let s = session
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async { self?.handle(result, error, s, offset) }
        }
    }

    private func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?, _ s: Int, _ offset: Double) {
        guard s == session else { return }
        if let result {
            let t = result.bestTranscription.formattedString
            if verbose {
                log("result final=\(result.isFinal) meta=\(result.speechRecognitionMetadata != nil) stopping=\(finishing != nil) text=\"\(t)\"")
            }
            if looksLikeReset(t) {
                committed = join(committed, current)
                committedWords += currentWords
            }
            current = t
            currentWords = result.bestTranscription.segments.filter { !$0.substring.isEmpty }.map {
                Word(text: $0.substring, start: offset + $0.timestamp, duration: $0.duration)
            }
            if verbose, result.speechRecognitionMetadata != nil || result.isFinal {
                log("  words: " + currentWords.map { String(format: "%@@%.2f+%.2f", $0.text, $0.start, $0.duration) }.joined(separator: " "))
            }
            lastHadMetadata = result.speechRecognitionMetadata != nil
            onPartial?(text)
            if result.isFinal { return segmentEnded() }
        }
        if let error {
            let code = (error as NSError).code
            if verbose { log("error \(code) stopping=\(finishing != nil)") }
            if finishing == nil, active, code != 1110, code != 216, code != 301 {
                log("recognizer error \(code): \(error.localizedDescription)")
            }
            segmentEnded()
        }
    }

    /// The recognizer finished a task. If we're stopping, deliver; if the user is still
    /// talking (server-side 1-minute cap, long silence, error), roll into a fresh task.
    private func segmentEnded() {
        if finishing != nil { return finish() }
        guard active else { return }
        committed = join(committed, current)
        current = ""
        committedWords += currentWords
        currentWords = []
        let now = CACurrentMediaTime()
        restarts = restarts.filter { now - $0 < 3 } + [now]
        if restarts.count > 3 {
            onError?("Speech recognition keeps failing — check Speech Recognition in System Settings › Privacy.")
            return
        }
        session += 1
        beginTask()
    }

    /// On-device recognition closes each utterance after a pause (that result carries metadata) and
    /// starts the next one from an empty transcript; the result after endAudio can be empty too.
    /// Detect those restarts so earlier words are kept instead of being overwritten.
    private func looksLikeReset(_ new: String) -> Bool {
        let o = normalize(current), n = normalize(new)
        guard !o.isEmpty else { return false }
        if n.isEmpty { return true } // a fresh, still-empty utterance
        if lastHadMetadata { return !n.hasPrefix(o) } // cumulative results would repeat the closed utterance
        guard o.count >= 12, !o.hasPrefix(String(n.prefix(8))) else { return false } // same opening → revision
        return n.count < o.count / 2
    }

    func stop(_ done: @escaping (String) -> Void) {
        guard active else { return done(text) }
        active = false
        feeding = false
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        finishing = done
        requestLock.lock()
        request?.endAudio()
        requestLock.unlock()
        let w = DispatchWorkItem { [weak self] in self?.finish() }
        finishTimer = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: w)
    }

    private func finish() {
        guard let done = finishing else { return }
        finishing = nil
        finishTimer?.cancel()
        session += 1 // ignore late callbacks
        task = nil
        requestLock.lock()
        request = nil
        requestLock.unlock()
        done(text)
    }

    func cancel() {
        active = false
        feeding = false
        finishing = nil
        finishTimer?.cancel()
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        task?.cancel()
        task = nil
        requestLock.lock()
        request = nil
        requestLock.unlock()
        _ = takeRecording()
        session += 1
    }
}

func join(_ a: String, _ b: String) -> String {
    let a = a.trimmingCharacters(in: .whitespaces), b = b.trimmingCharacters(in: .whitespaces)
    if a.isEmpty { return b }
    if b.isEmpty { return a }
    return a + " " + b
}

func normalize(_ s: String) -> String {
    String(s.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == " " })
}

// MARK: - Pill: floating waveform at the bottom of the screen while listening

final class PillView: NSView {
    var levels = [CGFloat](repeating: 0, count: 16)

    func push(_ v: Float) {
        levels.removeFirst()
        levels.append(CGFloat(v))
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 1, dy: 1)
        let bg = NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2)
        NSColor(white: 0.07, alpha: 0.94).setFill()
        bg.fill()
        NSColor(white: 1, alpha: 0.12).setStroke()
        bg.lineWidth = 1
        bg.stroke()

        // recording dot
        NSColor.systemRed.setFill()
        NSBezierPath(ovalIn: NSRect(x: 14, y: bounds.midY - 3.5, width: 7, height: 7)).fill()

        // bars
        let barW: CGFloat = 3, gap: CGFloat = 3
        var x: CGFloat = 32
        NSColor(white: 1, alpha: 0.92).setFill()
        for l in levels {
            let h = 3 + l * (bounds.height - 16)
            NSBezierPath(roundedRect: NSRect(x: x, y: bounds.midY - h / 2, width: barW, height: h),
                         xRadius: barW / 2, yRadius: barW / 2).fill()
            x += barW + gap
        }
    }
}

final class Pill {
    private let view = PillView(frame: NSRect(x: 0, y: 0, width: 140, height: 34))
    private let panel: NSPanel

    init() {
        panel = NSPanel(contentRect: view.frame, styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = view
    }

    func show() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        if let f = screen?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: f.midX - view.frame.width / 2, y: f.minY + 28))
        }
        view.levels = view.levels.map { _ in 0 }
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.12; panel.animator().alphaValue = 1 }
    }

    func hide() {
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.15; panel.animator().alphaValue = 0 }) {
            self.panel.orderOut(nil)
        }
    }

    func level(_ v: Float) { view.push(v) }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let link = Link()
    let fnKey = FnKey()
    let dictation = Dictation()
    let pill = Pill()
    var statusItem: NSStatusItem!
    var recordingID: String?
    var askedInputMonitoring = false
    var lastLevelAt: CFTimeInterval = 0
    var peakLevel: Float = 0
    let feedURL: URL? = {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--feed"), i + 1 < args.count else { return nil }
        return URL(fileURLWithPath: args[i + 1])
    }()

    func applicationDidFinishLaunching(_ note: Notification) {
        if feedURL != nil { link.role = "feed" }
        link.onStatus = { [weak self] up in
            guard let self else { return }
            self.updateIcon()
            guard up else { return }
            if let url = self.feedURL { self.runFeed(url) } else { self.sendHello() }
        }
        link.onMessage = { [weak self] msg in
            switch msg["t"] as? String {
            case "toggle": self?.toggle()
            case "cancel": self?.cancel()
            default: break
            }
        }
        dictation.onLevel = { [weak self] v in self?.level(v) }
        dictation.onError = { [weak self] m in self?.link.send(["t": "error", "message": m]) }
        link.connect()

        if feedURL != nil {
            SFSpeechRecognizer.requestAuthorization { _ in }
            return
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        updateIcon()

        fnKey.onTap = { [weak self] in self?.toggle() }
        fnKey.onEscape = { [weak self] in if self?.recordingID != nil { self?.cancel() } }

        // Ask for everything up front so the prompts come in one go.
        SFSpeechRecognizer.requestAuthorization { _ in DispatchQueue.main.async { self.sendHello() } }
        AVCaptureDevice.requestAccess(for: .audio) { _ in DispatchQueue.main.async { self.sendHello() } }
        armFnKey()
        log("ready — on-device recognition: \(dictation.onDevice)")
    }

    /// Input Monitoring is granted in System Settings; keep retrying until the tap can be created.
    func armFnKey() {
        // A listen-only tap can be created without the grant and then silently see no keys,
        // so wait for Input Monitoring itself before arming.
        if CGPreflightListenEventAccess(), fnKey.start() {
            log("fn key armed")
            sendHello()
            return
        }
        if !askedInputMonitoring {
            askedInputMonitoring = true
            CGRequestListenEventAccess()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.armFnKey() }
    }

    func sendHello() {
        let fnUsage = UserDefaults(suiteName: "com.apple.HIToolbox")?.object(forKey: "AppleFnUsageType") as? Int
        var msg: [String: Any] = [
            "t": "hello",
            "name": displayName,
            "onDevice": dictation.onDevice,
            "perms": [
                "mic": Self.name(AVCaptureDevice.authorizationStatus(for: .audio).rawValue),
                "speech": Self.name(SFSpeechRecognizer.authorizationStatus().rawValue),
                "input": fnKey.running && CGPreflightListenEventAccess() ? "granted" : "missing",
            ],
        ]
        msg["fnUsage"] = fnUsage ?? NSNull()
        link.send(msg)
    }

    static func name(_ raw: Int) -> String {
        // AVAuthorizationStatus and SFSpeechRecognizerAuthorizationStatus share these raw values
        switch raw {
        case 3: return "granted"
        case 2: return "denied"
        case 1: return "restricted"
        default: return "notDetermined"
        }
    }

    // MARK: dictation control

    func toggle() {
        recordingID == nil ? start() : stop()
    }

    func start() {
        guard link.connected else {
            NSSound.beep()
            log("can't reach \(serverBase)")
            return
        }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized,
              AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            NSSound.beep()
            link.send(["t": "error", "message": "Murmur needs Microphone and Speech Recognition access (System Settings › Privacy & Security)."])
            sendHello()
            return
        }
        let id = UUID().uuidString
        dictation.onPartial = { [weak self] t in self?.link.send(["t": "partial", "id": id, "text": t]) }
        do {
            try dictation.start()
        } catch {
            NSSound.beep()
            link.send(["t": "error", "message": error.localizedDescription])
            return
        }
        recordingID = id
        link.send(["t": "start", "id": id])
        pill.show()
        play("Tink")
        updateIcon()
    }

    func stop() {
        guard let id = recordingID else { return }
        recordingID = nil
        pill.hide()
        play("Pop")
        updateIcon()
        dictation.stop { [weak self] text in self?.sendFinal(id: id, text: text) }
    }

    /// Sends the finished transcript, then its recording ({t:"audio"} + one binary frame) so the
    /// chat can play it back. Returns the audio size for logging.
    @discardableResult
    func sendFinal(id: String, text: String) -> Int {
        let audio = dictation.takeRecording()
        // [word, start ms, duration ms] so the chat can highlight each word as the recording plays
        let words = dictation.words.map { [$0.text, Int($0.start * 1000), Int($0.duration * 1000)] as [Any] }
        link.send(["t": "final", "id": id, "text": text, "words": words])
        guard !text.isEmpty, let audio, !audio.isEmpty else { return 0 }
        link.send(["t": "audio", "id": id])
        link.sendData(audio)
        return audio.count
    }

    func cancel() {
        guard let id = recordingID else { return }
        recordingID = nil
        dictation.cancel()
        link.send(["t": "cancel", "id": id])
        pill.hide()
        updateIcon()
    }

    func level(_ v: Float) {
        guard recordingID != nil else { return }
        if feedURL == nil { pill.level(v) }
        peakLevel = max(peakLevel, v)
        let now = CACurrentMediaTime()
        if now - lastLevelAt > 0.05 { // ~20 Hz to the web app
            link.send(["t": "level", "v": (peakLevel * 100).rounded() / 100])
            lastLevelAt = now
            peakLevel = 0
        }
    }

    func runFeed(_ url: URL) {
        guard recordingID == nil else { return }
        let id = UUID().uuidString
        recordingID = id
        dictation.onPartial = { [weak self] t in self?.link.send(["t": "partial", "id": id, "text": t]) }
        link.send(["t": "start", "id": id])
        do {
            try dictation.startFeeding(url) { [weak self] in
                guard let self else { return }
                self.recordingID = nil
                self.dictation.stop { text in
                    let bytes = self.sendFinal(id: id, text: text)
                    log("feed final: \(text) (audio \(bytes) bytes)")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { NSApp.terminate(nil) }
                }
            }
        } catch {
            log("feed failed: \(error.localizedDescription)")
            NSApp.terminate(nil)
        }
    }

    func play(_ name: String) {
        guard let s = NSSound(named: NSSound.Name(name))?.copy() as? NSSound else { return }
        s.volume = 0.25
        s.play()
    }

    // MARK: menu bar

    func updateIcon() {
        guard let button = statusItem?.button else { return }
        let symbol = recordingID != nil ? "waveform.circle.fill" : "waveform"
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Murmur")
        button.appearsDisabled = !link.connected
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let state: String
        if !fnKey.running {
            state = "Needs Input Monitoring to hear fn"
        } else if recordingID != nil {
            state = "Listening… press fn to send"
        } else {
            state = "Press fn to dictate"
        }
        menu.addItem(withTitle: state, action: nil, keyEquivalent: "")
        let host = URL(string: serverBase)?.host ?? serverBase
        menu.addItem(withTitle: link.connected ? "Connected to \(host)" : "Can’t reach \(host)",
                     action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open Chat", action: #selector(openChat), keyEquivalent: "o").target = self
        menu.addItem(withTitle: recordingID != nil ? "Stop Dictation" : "Start Dictation",
                     action: #selector(toggleFromMenu), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Input Monitoring Settings…", action: #selector(openInputMonitoring), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Keyboard Settings (set 🌐 key to Do Nothing)…", action: #selector(openKeyboard), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Murmur", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    // The host's token, or this install's key + name, tells the page whose mic and messages are "mine".
    @objc func openChat() {
        let suffix = helperToken.isEmpty
            ? "/#key=" + query(installKey) + "&name=" + query(displayName)
            : "/#owner=" + query(helperToken)
        NSWorkspace.shared.open(URL(string: serverBase + suffix)!)
    }
    @objc func toggleFromMenu() { toggle() }
    @objc func openInputMonitoring() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!)
    }
    @objc func openKeyboard() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension")!)
    }
}

@main
struct Main {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
