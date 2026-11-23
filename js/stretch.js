/* stretch.js: change tempo without changing pitch (WSOLA: waveform-similarity overlap-add).
 * Output grains are placed at a fixed hop. For each grain we read the input near (outPos * speed),
 * searching a small window for the offset that best lines up with the previous grain, so waves stay in phase.
 * The result is rendered once per (sample, speed) and cached by the caller. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});

  BF.timeStretch = function (ctx, buffer, speed) {
    if (Math.abs(speed - 1) < 0.005) return buffer;
    const rate = buffer.sampleRate;
    const N = Math.max(256, Math.round(rate * 0.046)); // grain ~46 ms
    const hop = N >> 1; // 50% overlap with a Hann window sums to a constant
    const tol = Math.round(rate * 0.008); // search +-8 ms
    const inLen = buffer.length;
    const outLen = Math.max(1, Math.round(inLen / speed));
    const chans = buffer.numberOfChannels;
    const inp = [];
    for (let c = 0; c < chans; c++) inp.push(buffer.getChannelData(c));
    const out = ctx.createBuffer(chans, outLen, rate);
    const outData = [];
    for (let c = 0; c < chans; c++) outData.push(out.getChannelData(c));

    // mono guide signal for the similarity search
    const mono = new Float32Array(inLen);
    for (let c = 0; c < chans; c++) { const d = inp[c]; for (let i = 0; i < inLen; i++) mono[i] += d[i] / chans; }

    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const norm = new Float32Array(outLen + N);

    let prevIn = 0; // input start of the previous grain
    for (let outPos = 0; outPos < outLen; outPos += hop) {
      const target = Math.round(outPos * speed);
      let best = target;
      if (outPos > 0) {
        // The "natural continuation" of the previous grain is prevIn + hop. Find the input
        // offset near `target` whose start looks most like that continuation.
        const nat = prevIn + hop;
        let bestScore = -Infinity;
        const cmp = Math.min(hop, 1024);
        for (let d = -tol; d <= tol; d += 2) {
          const cand = target + d;
          if (cand < 0 || cand + cmp >= inLen || nat + cmp >= inLen) continue;
          let s = 0;
          for (let k = 0; k < cmp; k += 4) s += mono[cand + k] * mono[nat + k];
          if (s > bestScore) { bestScore = s; best = cand; }
        }
      }
      best = Math.max(0, Math.min(inLen - 1, best));
      prevIn = best;
      for (let c = 0; c < chans; c++) {
        const src = inp[c], dst = outData[c];
        for (let i = 0; i < N; i++) {
          const o = outPos + i, s = best + i;
          if (o >= outLen) break;
          if (s < inLen) dst[o] += src[s] * win[i];
        }
      }
      for (let i = 0; i < N && outPos + i < outLen; i++) norm[outPos + i] += win[i];
    }
    for (let c = 0; c < chans; c++) {
      const d = outData[c];
      for (let i = 0; i < outLen; i++) d[i] = norm[i] > 1e-3 ? d[i] / norm[i] : d[i];
    }
    return out;
  };
})();
