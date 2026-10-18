import Foundation
import AVFoundation
import CoreImage
import UIKit
import Capacitor

@objc(CameraCapturePlugin)
public class CameraCapturePlugin: CAPPlugin, CAPBridgedPlugin, AVCaptureVideoDataOutputSampleBufferDelegate {
    public let identifier = "CameraCapturePlugin"
    public let jsName = "CameraCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capture", returnType: CAPPluginReturnPromise)
    ]

    private let sessionQueue = DispatchQueue(label: "CameraCapture.session")
    private var session: AVCaptureSession?
    private var pendingCall: CAPPluginCall?
    private var framesSeen = 0
    private let warmupFrames = 12
    private let ciContext = CIContext()

    @objc func requestPermission(_ call: CAPPluginCall) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            call.resolve(["granted": true])
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                call.resolve(["granted": granted])
            }
        default:
            call.resolve(["granted": false])
        }
    }

    @objc func capture(_ call: CAPPluginCall) {
        let facing = call.getString("facing") ?? "back"
        let position: AVCaptureDevice.Position = (facing == "front") ? .front : .back

        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            call.reject("permission_denied")
            return
        }

        sessionQueue.async { [weak self] in
            guard let self = self else { return }
            if self.pendingCall != nil {
                call.reject("busy")
                return
            }
            guard let device = self.cameraDevice(position: position) else {
                call.reject("no_camera")
                return
            }
            do {
                let session = AVCaptureSession()
                session.sessionPreset = .hd1280x720

                let input = try AVCaptureDeviceInput(device: device)
                guard session.canAddInput(input) else {
                    call.reject("input_failed")
                    return
                }
                session.addInput(input)

                let output = AVCaptureVideoDataOutput()
                output.videoSettings = [
                    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
                ]
                output.alwaysDiscardsLateVideoFrames = true
                output.setSampleBufferDelegate(self, queue: self.sessionQueue)
                guard session.canAddOutput(output) else {
                    call.reject("output_failed")
                    return
                }
                session.addOutput(output)

                if let conn = output.connection(with: .video),
                   conn.isVideoOrientationSupported {
                    conn.videoOrientation = .portrait
                }

                self.framesSeen = 0
                self.pendingCall = call
                self.session = session
                session.startRunning()

                self.sessionQueue.asyncAfter(deadline: .now() + 5.0) { [weak self] in
                    guard let self = self else { return }
                    if let pc = self.pendingCall, pc.callbackId == call.callbackId {
                        self.finish(reject: "capture_timeout")
                    }
                }
            } catch {
                call.reject("start_failed", error.localizedDescription, error)
            }
        }
    }

    private func cameraDevice(position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera],
            mediaType: .video,
            position: position
        )
        return discovery.devices.first ?? AVCaptureDevice.default(for: .video)
    }

    public func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard pendingCall != nil else { return }
        framesSeen += 1
        if framesSeen < warmupFrames { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return }
        let uiImage = UIImage(cgImage: cgImage)
        guard let jpeg = uiImage.jpegData(compressionQuality: 0.7) else { return }

        let dataUrl = "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
        finish(resolve: dataUrl)
    }

    private func finish(resolve dataUrl: String? = nil, reject message: String? = nil) {
        if let session = self.session {
            if session.isRunning { session.stopRunning() }
            for input in session.inputs { session.removeInput(input) }
            for output in session.outputs { session.removeOutput(output) }
        }
        self.session = nil
        let call = self.pendingCall
        self.pendingCall = nil
        self.framesSeen = 0
        if let dataUrl = dataUrl {
            call?.resolve(["dataUrl": dataUrl])
        } else {
            call?.reject(message ?? "capture_failed")
        }
    }
}
