

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

  // Buffer size 128 matches the Web Audio API render quantum (approx 8ms at 16kHz)
  buffer = new Int16Array(128);
  bufferWriteIndex = 0;
  
  // Metrics
  sumSquares = 0;
  clipped = false;
  
  // Biquad Filter Coefficients (High Pass)
  b0 = 0; b1 = 0; b2 = 0;
  a1 = 0; a2 = 0;
  
  // Filter State
  x1 = 0; x2 = 0;
  y1 = 0; y2 = 0;

  // Analog saturation drive
  // Increased to 3.8 to boost low-level details (whispers/breaths) while saturating peaks
  preGain = 3.8; 

  // Noise Gate
  // Lowered to 0.003 to capture subtle human nuances while still silencing digital silence
  gateThreshold = 0.003; 
  gateRelease = 0.999; 
  gateEnvelope = 0.0;

  constructor() {
    super();
    // Calculate 2nd-Order Butterworth High-Pass Filter at 100Hz
    // Adjusted from 120Hz to 100Hz to retain more vocal body/warmth while still cutting rumble.
    this.calculateBiquadFilter(100);
    
    this.port.onmessage = this.handleMessage.bind(this);
  }

  calculateBiquadFilter(frequency) {
    const nyquist = sampleRate / 2;
    const normalizedFreq = frequency / nyquist;
    
    // Butterworth Q
    const Q = 0.7071; 
    const w0 = 2 * Math.PI * frequency / sampleRate;
    const alpha = Math.sin(w0) / (2 * Q);
    const cosw0 = Math.cos(w0);

    const a0 = 1 + alpha;
    
    // HPF Coefficients
    this.b0 = ((1 + cosw0) / 2) / a0;
    this.b1 = (-(1 + cosw0)) / a0;
    this.b2 = ((1 + cosw0) / 2) / a0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  handleMessage(event) {
    if (event.data.type === 'configure') {
      if (event.data.threshold !== undefined) this.gateThreshold = event.data.threshold;
      if (event.data.release !== undefined) this.gateRelease = event.data.release;
    }
  }

  process(inputs) {
    if (inputs[0].length) {
      const channel0 = inputs[0][0];
      this.processChunk(channel0);
    }
    return true;
  }

  sendAndClearBuffer(){
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
      
      // 1. Apply Biquad High-Pass Filter (Direct Form I)
      const x = sample;
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      
      // Shift state
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      
      sample = y;

      // 2. Noise Gate
      const absSample = Math.abs(sample);
      let targetGain = 0.0;
      
      if (absSample > this.gateThreshold) {
        targetGain = 1.0;
        this.gateEnvelope = 1.0; 
      } else {
        this.gateEnvelope *= this.gateRelease;
        targetGain = this.gateEnvelope;
      }
      sample *= targetGain;

      // 3. Pre-gain for analog drive
      sample *= this.preGain;

      // 4. Soft Clipping (Analog Saturation)
      sample = Math.tanh(sample);

      // 5. RMS accumulation
      this.sumSquares += sample * sample;

      // 6. Output conversion
      let int16Value = sample * 32767;

      if (Math.abs(int16Value) >= 32700) {
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