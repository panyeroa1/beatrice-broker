
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const AudioRecordingWorklet = `
class AudioProcessingWorklet extends AudioWorkletProcessor {

  // Reduced buffer to 128 samples (approx 8ms at 16kHz) for lowest possible latency
  // matching the Web Audio API render quantum size
  buffer = new Int16Array(128);
  
  // current write index
  bufferWriteIndex = 0;
  
  // Metrics
  sumSquares = 0;
  clipped = false;
  
  // High-pass filter state (remove DC offset/rumble)
  prevX = 0;
  prevY = 0;
  alpha = 0.97; // ~80Hz cutoff at 16kHz

  constructor() {
    super();
  }

  process(inputs) {
    if (inputs[0].length) {
      const channel0 = inputs[0][0];
      this.processChunk(channel0);
    }
    return true;
  }

  sendAndClearBuffer(){
    // Calculate RMS
    const rms = Math.sqrt(this.sumSquares / this.bufferWriteIndex);
    
    this.port.postMessage({
      event: "chunk",
      data: {
        int16arrayBuffer: this.buffer.slice(0, this.bufferWriteIndex).buffer,
        volume: rms,
        clipped: this.clipped
      },
    });
    this.bufferWriteIndex = 0;
    this.sumSquares = 0;
    this.clipped = false;
  }

  processChunk(float32Array) {
    const l = float32Array.length;
    
    for (let i = 0; i < l; i++) {
      let sample = float32Array[i];
      
      // 1. High-pass filter (80Hz) to clean up low-end mud
      const y = this.alpha * (this.prevY + sample - this.prevX);
      this.prevX = sample;
      this.prevY = y;
      sample = y;

      // 2. Soft Clipping (Analog Saturation)
      // Math.tanh gives a warm, compressed sound at high levels
      sample = Math.tanh(sample);

      // 3. Accumulate squared sum for RMS
      this.sumSquares += sample * sample;

      // 4. Convert float32 to int16
      let int16Value = sample * 32767;

      // Check for clipping (even after tanh, if driven hard, it saturates)
      if (Math.abs(int16Value) >= 32760) {
        this.clipped = true;
      }
      
      this.buffer[this.bufferWriteIndex++] = int16Value;
      if(this.bufferWriteIndex >= this.buffer.length) {
        this.sendAndClearBuffer();
      }
    }
  }
}
`;

export default AudioRecordingWorklet;