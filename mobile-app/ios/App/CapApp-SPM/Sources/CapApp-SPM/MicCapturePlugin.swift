import Foundation
import AVFoundation
import Capacitor

@objc(MicCapturePlugin)
public class MicCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MicCapturePlugin"
    public let jsName = "MicCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise)
    ]

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16000,
        channels: 1,
        interleaved: true
    )!
    private let chunkBytes = 3200
    private var pcmAccumulator = Data()
    private let queue = DispatchQueue(label: "MicCapture.audio")
    private var isRunning = false
    private var interruptionObserver: NSObjectProtocol?

    @objc func requestPermission(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            call.resolve(["granted": granted])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self = self else { return }
            if self.isRunning {
                call.resolve()
                return
            }
            do {
                try self.configureAudioSession()
                try self.startEngine()
                self.registerInterruptionHandler()
                self.isRunning = true
                call.resolve()
            } catch {
                call.reject("start_failed", error.localizedDescription, error)
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.teardown()
            call.resolve()
        }
    }

    @objc func isRecording(_ call: CAPPluginCall) {
        call.resolve(["recording": isRunning])
    }

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .measurement,
            options: [.allowBluetooth, .defaultToSpeaker, .mixWithOthers]
        )
        try session.setPreferredSampleRate(48000)
        try session.setPreferredIOBufferDuration(0.1)
        try session.setActive(true, options: [])
    }

    private func startEngine() throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)

        guard let conv = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw NSError(
                domain: "MicCapture",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Cannot create AVAudioConverter"]
            )
        }
        self.converter = conv

        let bufferSize = AVAudioFrameCount(inputFormat.sampleRate * 0.1)
        input.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
            self?.process(buffer: buffer)
        }
        engine.prepare()
        try engine.start()
    }

    private func process(buffer: AVAudioPCMBuffer) {
        guard let conv = converter else { return }
        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let outFrameCount = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outFrameCount) else { return }

        var error: NSError?
        var inputProvided = false
        let status = conv.convert(to: outBuf, error: &error) { _, outStatus in
            if inputProvided {
                outStatus.pointee = .noDataNow
                return nil
            }
            inputProvided = true
            outStatus.pointee = .haveData
            return buffer
        }

        if status == .error || error != nil { return }
        guard outBuf.frameLength > 0, let int16Ptr = outBuf.int16ChannelData?.pointee else { return }

        let byteCount = Int(outBuf.frameLength) * MemoryLayout<Int16>.size
        let chunk = Data(bytes: int16Ptr, count: byteCount)
        pcmAccumulator.append(chunk)
        emitChunks()
    }

    private func emitChunks() {
        while pcmAccumulator.count >= chunkBytes {
            let chunk = pcmAccumulator.prefix(chunkBytes)
            pcmAccumulator.removeSubrange(0..<chunkBytes)
            let base64 = chunk.base64EncodedString()
            self.notifyListeners("pcmChunk", data: ["data": base64])
        }
    }

    private func registerInterruptionHandler() {
        if interruptionObserver != nil { return }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: nil
        ) { [weak self] notification in
            guard let self = self,
                  let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
            switch type {
            case .began:
                self.notifyListeners("interruption", data: ["state": "began"])
            case .ended:
                self.queue.async {
                    do {
                        try AVAudioSession.sharedInstance().setActive(true, options: [])
                        if !self.engine.isRunning { try self.engine.start() }
                        self.notifyListeners("interruption", data: ["state": "ended"])
                    } catch {
                        self.notifyListeners("interruption", data: ["state": "resume_failed", "error": error.localizedDescription])
                    }
                }
            @unknown default:
                break
            }
        }
    }

    private func teardown() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
            interruptionObserver = nil
        }
        pcmAccumulator.removeAll()
        converter = nil
        isRunning = false
    }
}
