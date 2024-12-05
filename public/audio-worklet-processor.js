class PCMPlayerProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.bufferQueue = []; // queue of Float32Array chunks
      this.port.onmessage = (event) => {
        const data = event.data; // Int16Array
        // Convert Int16 samples to Float32 (-1 to 1)
        // const samples = new Float32Array(data.length);
        // for (let i = 0; i < data.length; i++) {
        //   samples[i] = data[i] / 32768;
        // }
        // this.bufferQueue.push(samples);
        this.bufferQueue.push(data);
      };
    }
  
    process(inputs, outputs) {
      const output = outputs[0];
      const outChannel = output[0];
      let samplesNeeded = outChannel.length;
      let sampleIndex = 0;
  
      while (this.bufferQueue.length > 0 && sampleIndex < samplesNeeded) {
        const currentBuffer = this.bufferQueue[0];
        const samplesToCopy = Math.min(samplesNeeded - sampleIndex, currentBuffer.length);
        outChannel.set(currentBuffer.subarray(0, samplesToCopy), sampleIndex);
        sampleIndex += samplesToCopy;
  
        if (samplesToCopy < currentBuffer.length) {
          // Partially consumed this chunk
          this.bufferQueue[0] = currentBuffer.subarray(samplesToCopy);
        } else {
          // Fully consumed this chunk
          this.bufferQueue.shift();
        }
      }
  
      // Fill remaining samples with silence if no data available
      for (; sampleIndex < samplesNeeded; sampleIndex++) {
        outChannel[sampleIndex] = 0;
      }
  
      return true; // Keep processor alive
    }
  }
  
  registerProcessor('pcm-player-processor', PCMPlayerProcessor);
  