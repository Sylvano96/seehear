// Audio thread side of the capture in listen.js: forwards the mono input in
// blocks of 4096 samples (the processor is called every 128 samples).
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      this.block.set(channel, this.filled);
      this.filled += channel.length;
      if (this.filled >= this.block.length) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(4096);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("seehear-capture", CaptureProcessor);
