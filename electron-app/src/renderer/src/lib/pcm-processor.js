class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = options.processorOptions || {}
    this.inputSampleRate = opts.inputSampleRate || 48000
    this.outputSampleRate = opts.outputSampleRate || 16000
    this.chunkDurationMs = opts.chunkDurationMs || 100
    this.samplesPerChunk = (this.outputSampleRate * this.chunkDurationMs) / 1000
    this.ratio = this.inputSampleRate / this.outputSampleRate
    this.samplesNeeded = Math.ceil(this.samplesPerChunk * this.ratio)

    this.ringCapacity = this.inputSampleRate
    this.ring = new Float32Array(this.ringCapacity)
    this.writePos = 0
    this.readPos = 0
    this.available = 0

    this.resampled = new Float32Array(this.samplesPerChunk)
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const numChannels = input.length
    const frameCount = input[0].length

    for (let i = 0; i < frameCount; i++) {
      let sample = 0
      for (let ch = 0; ch < numChannels; ch++) {
        sample += input[ch][i]
      }
      if (numChannels > 1) sample /= numChannels
      this.ring[this.writePos] = sample
      this.writePos = (this.writePos + 1) % this.ringCapacity
    }
    this.available += frameCount

    while (this.available >= this.samplesNeeded) {
      for (let i = 0; i < this.samplesPerChunk; i++) {
        const srcIndex = i * this.ratio
        const srcIndexFloor = Math.floor(srcIndex)
        const frac = srcIndex - srcIndexFloor

        const idx0 = (this.readPos + srcIndexFloor) % this.ringCapacity
        const idx1 = (this.readPos + Math.min(srcIndexFloor + 1, this.samplesNeeded - 1)) % this.ringCapacity
        this.resampled[i] = this.ring[idx0] + frac * (this.ring[idx1] - this.ring[idx0])
      }

      const pcm = new Int16Array(this.samplesPerChunk)
      for (let i = 0; i < this.samplesPerChunk; i++) {
        const s = Math.max(-1, Math.min(1, this.resampled[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }

      this.port.postMessage(
        { type: 'pcm', buffer: pcm.buffer },
        [pcm.buffer]
      )

      this.readPos = (this.readPos + this.samplesNeeded) % this.ringCapacity
      this.available -= this.samplesNeeded
    }

    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
