/* wav.js: encode an AudioBuffer as a 16-bit PCM WAV (RIFF) file. */
(function () {
  'use strict';
  const BF = (window.BF = window.BF || {});

  BF.encodeWav = function (buffer) {
    const channels = Math.min(2, buffer.numberOfChannels);
    const rate = buffer.sampleRate;
    const frames = buffer.length;
    const bytesPerSample = 2;
    const dataSize = frames * channels * bytesPerSample;
    const out = new ArrayBuffer(44 + dataSize);
    const v = new DataView(out);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

    str(0, 'RIFF');
    v.setUint32(4, 36 + dataSize, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true); // fmt chunk size
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, channels, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * channels * bytesPerSample, true); // byte rate
    v.setUint16(32, channels * bytesPerSample, true); // block align
    v.setUint16(34, 16, true); // bits per sample
    str(36, 'data');
    v.setUint32(40, dataSize, true);

    const data = [];
    for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        // soft clip to avoid wrap-around on overs, then convert to 16-bit with TPDF-free rounding
        let s = data[c][i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        v.setInt16(o, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
        o += 2;
      }
    }
    return new Blob([out], { type: 'audio/wav' });
  };
})();
