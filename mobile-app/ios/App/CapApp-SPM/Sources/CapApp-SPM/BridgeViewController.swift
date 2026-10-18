import Capacitor

public class BridgeViewController: CAPBridgeViewController {
    public override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MicCapturePlugin())
        bridge?.registerPluginInstance(CameraCapturePlugin())
    }
}
