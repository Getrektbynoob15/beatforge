/* export2.js: compressed exports for sharing (Discord etc.):
 *  - MP3 with lamejs (js/vendor/lame-min.js, LGPL, loaded only when needed)
 *  - OGG Opus with the browser's built-in WebCodecs encoder and a small Ogg muxer (no extra code) */
(function () {
  'use strict';
  const BF = window.BF;
  const X = (BF.exporter = {});
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  const safeName = (s) => (s || 'project').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'project';
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.lamejs) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('The MP3 encoder could not be loaded.'));
      document.head.append(s);
    });
  }

  const toInt16 = (f32) => {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); out[i] = v < 0 ? v * 32768 : v * 32767; }
    return out;
  };

  /** MP3 at `kbps` (constant bit rate). */
  X.mp3 = async function (buf, kbps = 192) {
    await loadScript('js/vendor/lame-min.js');
    const ch = Math.min(2, buf.numberOfChannels);
    const enc = new window.lamejs.Mp3Encoder(ch, buf.sampleRate, kbps);
    const L = toInt16(buf.getChannelData(0)), R = ch > 1 ? toInt16(buf.getChannelData(1)) : null;
    const parts = [];
    const block = 1152 * 20;
    for (let i = 0; i < L.length; i += block) {
      const d = ch > 1 ? enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block)) : enc.encodeBuffer(L.subarray(i, i + block));
      if (d.length) parts.push(new Uint8Array(d));
      if ((i / block) % 20 === 0) { BF.ui.busy(`Encoding MP3… ${Math.round((i / L.length) * 100)}%`); await yieldUI(); }
    }
    const end = enc.flush();
    if (end.length) parts.push(new Uint8Array(end));
    return new Blob(parts, { type: 'audio/mpeg' });
  };

  // ---------- Ogg container (RFC 3533) with Opus (RFC 7845) ----------
  const CRC = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; CRC[i] = r >>> 0; }
  function crc32(bytes) { let c = 0; for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ bytes[i]) & 255]) >>> 0; return c; }

  function oggPage(packets, granule, serial, seq, flags) {
    const lacing = [];
    packets.forEach((p) => { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); });
    const bodyLen = packets.reduce((a, p) => a + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + bodyLen);
    const v = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
    page[4] = 0; page[5] = flags;
    v.setUint32(6, granule % 4294967296, true); v.setUint32(10, Math.floor(granule / 4294967296), true);
    v.setUint32(14, serial, true); v.setUint32(18, seq, true); v.setUint32(22, 0, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    let o = 27 + lacing.length;
    packets.forEach((p) => { page.set(p, o); o += p.length; });
    v.setUint32(22, crc32(page), true);
    return page;
  }

  /** OGG Opus via WebCodecs. `buf` must be 48 kHz. */
  X.ogg = async function (buf, kbps = 128) {
    if (typeof AudioEncoder === 'undefined') throw new Error('This browser has no built-in Opus encoder. Use MP3, or Chrome / Edge / the desktop app.');
    const ch = Math.min(2, buf.numberOfChannels);
    const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: ch, bitrate: kbps * 1000 };
    const sup = await AudioEncoder.isConfigSupported(cfg);
    if (!sup.supported) throw new Error('Opus encoding is not supported here. Use MP3 instead.');
    const packets = [];
    let preSkip = 312;
    const enc = new AudioEncoder({
      output: (chunk, meta) => {
        const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
        packets.push({ data: d, dur: Math.round(((chunk.duration || 20000) * 48000) / 1e6) });
        const desc = meta?.decoderConfig?.description;
        if (desc && desc.byteLength >= 12) { const dv = new DataView(desc instanceof ArrayBuffer ? desc : desc.buffer); preSkip = dv.getUint16(10, true); }
      },
      error: (e) => { throw e; },
    });
    enc.configure(cfg);
    const frames = 48000 * 0.5; // feed half a second at a time
    for (let i = 0; i < buf.length; i += frames) {
      const n = Math.min(frames, buf.length - i);
      const planar = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) planar.set(buf.getChannelData(c).subarray(i, i + n), c * n);
      enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((i / 48000) * 1e6), data: planar }));
      if ((i / frames) % 20 === 0) { BF.ui.busy(`Encoding OGG… ${Math.round((i / buf.length) * 100)}%`); await yieldUI(); }
    }
    await enc.flush();
    enc.close();
    const serial = (Math.random() * 4294967295) >>> 0;
    const head = new Uint8Array(19);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // OpusHead
    const hv = new DataView(head.buffer);
    head[8] = 1; head[9] = ch; hv.setUint16(10, preSkip, true); hv.setUint32(12, 48000, true); hv.setInt16(16, 0, true); head[18] = 0;
    const vendor = new TextEncoder().encode('BeatForge');
    const title = new TextEncoder().encode(`TITLE=${BF.project.name}`);
    const tags = new Uint8Array(8 + 4 + vendor.length + 4 + 4 + title.length);
    const tv = new DataView(tags.buffer);
    tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // OpusTags
    tv.setUint32(8, vendor.length, true); tags.set(vendor, 12);
    tv.setUint32(12 + vendor.length, 1, true); tv.setUint32(16 + vendor.length, title.length, true); tags.set(title, 20 + vendor.length);
    const pages = [oggPage([head], 0, serial, 0, 0x02), oggPage([tags], 0, serial, 1, 0)];
    let seq = 2, granule = preSkip, group = [], segs = 0;
    const total = buf.length + preSkip;
    packets.forEach((p, idx) => {
      const need = Math.floor(p.data.length / 255) + 1;
      if (segs + need > 255 && group.length) { pages.push(oggPage(group, Math.min(granule, total), serial, seq++, 0)); group = []; segs = 0; }
      group.push(p.data); segs += need; granule += p.dur;
      if (idx === packets.length - 1) pages.push(oggPage(group, total, serial, seq++, 0x04));
    });
    return new Blob(pages, { type: 'audio/ogg' });
  };

  /** File menu entry: render the song and save it compressed. */
  X.export = async function (format) {
    try {
      BF.transport.stop();
      BF.ui.busy('Rendering song…');
      const buf = await BF.renderSong('song', format === 'ogg' ? 48000 : 44100);
      const blob = format === 'ogg' ? await X.ogg(buf) : await X.mp3(buf);
      const name = `${safeName(BF.project.name)}.${format === 'ogg' ? 'ogg' : 'mp3'}`;
      BF.io.download(blob, name);
      BF.ui.toast(`Exported ${name} (${buf.duration.toFixed(1)} s, ${mb(blob.size)})${blob.size > 10 * 1048576 ? '. Over 10 MB: Discord may need Nitro for this one.' : '. Small enough for Discord.'}`);
    } catch (e) {
      BF.ui.toast(`Export failed: ${e.message || e}`, true);
    } finally {
      BF.ui.busy(null);
    }
  };
})();
