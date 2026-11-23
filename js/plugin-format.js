/* plugin-format.js: the BeatForge community plugin file format (shared by the app and the website's review server).
 *
 * A plugin is ONE JavaScript file with a header, like this:
 *
 *   // ==BeatForgePlugin==
 *   // @id          bitcrusher
 *   // @name        Bitcrusher
 *   // @kind        effect                    (effect | instrument)
 *   // @version     1.0.0
 *   // @author      your name
 *   // @description Lo-fi: fewer bits and a lower sample rate.
 *   // @param       bits "Bits" 1 16 8 step=1
 *   // @param       mix  "Mix"  0 1 1 unit=%
 *   // @param       mode "Shape" options=Soft|Hard default=0
 *   // ==/BeatForgePlugin==
 *
 *   BeatForge.effect({ create(info) { return {}; }, process(state, input, output, params, frames) { ... } });
 *
 * The code runs inside the browser's audio thread (an AudioWorklet). That thread has no access to the page,
 * the network, files or storage: a plugin can only turn numbers into sound. See the plugin SDK README.
 * This file never runs plugin code; it only reads the header. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.BF = root.BF || {}; root.BF.pluginFormat = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAX_SOURCE = 128 * 1024;
  const MAX_PARAMS = 24;
  const ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
  const PARAM_ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
  const VERSION_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const UNITS = ['', '%', 'dB', 'Hz', 's', 'ms', 'x', 'st', 'ct', '°'];

  function fail(msg) { const e = new Error(msg); e.status = 400; e.expose = true; throw e; }
  const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

  function cmpVersion(a, b) {
    const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  }

  /** Split `bits "Bits" 1 16 8 step=1` into tokens (quoted strings stay together). */
  function tokens(s) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(s))) out.push(m[1] !== undefined ? { q: true, v: m[1] } : { q: false, v: m[2] });
    return out;
  }

  function parseParam(line, n) {
    const t = tokens(line);
    if (t.length < 2) fail(`@param ${n}: write it like  @param cutoff "Cutoff" 20 20000 1000 unit=Hz`);
    const id = t[0].v;
    if (!PARAM_ID_RE.test(id)) fail(`@param ${n}: "${id}" is not a valid parameter id (letters, digits, _; start with a letter).`);
    if (!t[1].q) fail(`@param ${id}: put the display name in quotes, e.g. "Cutoff".`);
    const name = clean(t[1].v, 24) || id;
    const nums = [], opts = {};
    t.slice(2).forEach((x) => {
      const kv = /^([a-z]+)=(.*)$/.exec(x.v);
      if (kv && !x.q) opts[kv[1]] = kv[2];
      else nums.push(x.v);
    });
    const p = { id, name };
    if (opts.options !== undefined) {
      const options = opts.options.split('|').map((o) => clean(o, 16)).filter(Boolean);
      if (options.length < 2 || options.length > 16) fail(`@param ${id}: options needs 2 to 16 choices separated by |.`);
      const def = opts.default === undefined ? 0 : Number(opts.default);
      if (!Number.isInteger(def) || def < 0 || def >= options.length) fail(`@param ${id}: default must be the number of a choice (0 = first).`);
      p.options = options; p.default = def;
      return p;
    }
    if (nums.length !== 3) fail(`@param ${id}: give min, max and default, e.g. 0 1 0.5`);
    const [min, max, def] = nums.map(Number);
    if (![min, max, def].every(Number.isFinite) || !(max > min) || def < min || def > max || Math.abs(min) > 1e6 || Math.abs(max) > 1e6) fail(`@param ${id}: min < max and min ≤ default ≤ max, all plain numbers.`);
    Object.assign(p, { min, max, default: def });
    if (opts.step !== undefined) { const st = Number(opts.step); if (!(st > 0) || st > max - min) fail(`@param ${id}: step must be > 0.`); p.step = st; }
    if (opts.unit !== undefined) { if (!UNITS.includes(opts.unit)) fail(`@param ${id}: unit must be one of ${UNITS.filter(Boolean).join(' ')}`); if (opts.unit) p.unit = opts.unit; }
    if (opts.curve !== undefined) { if (opts.curve !== 'log' || min <= 0) fail(`@param ${id}: curve=log needs min > 0.`); p.curve = 'log'; }
    return p;
  }

  /** Read and check the header. Returns { meta, params, warnings }. Throws a readable Error. */
  function parse(source) {
    if (typeof source !== 'string') fail('The plugin must be text.');
    if (source.length > MAX_SOURCE) fail(`The plugin is ${Math.round(source.length / 1024)} KB; the limit is 128 KB.`);
    const start = source.indexOf('// ==BeatForgePlugin==');
    const end = source.indexOf('// ==/BeatForgePlugin==');
    if (start < 0 || end < start) fail('The header is missing. The file must start with  // ==BeatForgePlugin==  and end the header with  // ==/BeatForgePlugin==');
    if (source.indexOf('// ==BeatForgePlugin==', start + 1) >= 0) fail('The file has two headers.');
    const meta = {};
    const params = [];
    source.slice(start, end).split(/\r?\n/).slice(1).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      const m = /^\/\/\s*@([a-z]+)\s*(.*)$/.exec(line);
      if (!m) { if (/^\/\//.test(line)) return; fail(`Header line not understood: ${line.slice(0, 60)}`); }
      const [, key, value] = m;
      if (key === 'param') { if (params.length >= MAX_PARAMS) fail(`At most ${MAX_PARAMS} parameters.`); params.push(parseParam(value, params.length + 1)); }
      else if (['id', 'name', 'kind', 'version', 'author', 'description', 'homepage', 'license'].includes(key)) meta[key] = value.trim();
      else fail(`Unknown header field @${key}.`);
    });
    if (!ID_RE.test(meta.id || '')) fail('@id must be 3–40 characters: lowercase letters, digits and -, like  my-bitcrusher');
    meta.name = clean(meta.name, 32);
    if (!meta.name) fail('@name is missing.');
    if (!['effect', 'instrument'].includes(meta.kind)) fail('@kind must be effect or instrument.');
    if (!VERSION_RE.test(meta.version || '')) fail('@version must look like 1.0.0');
    meta.author = clean(meta.author, 40);
    if (!meta.author) fail('@author is missing.');
    meta.description = clean(meta.description, 200);
    if (meta.homepage !== undefined) { const h = String(meta.homepage).trim(); if (!/^https:\/\/[^\s"'<>]{4,200}$/.test(h)) fail('@homepage must be an https:// link.'); meta.homepage = h; }
    if (meta.license !== undefined) meta.license = clean(meta.license, 24);
    const ids = new Set();
    params.forEach((p) => { if (ids.has(p.id)) fail(`Parameter id "${p.id}" is used twice.`); ids.add(p.id); });
    const body = source.slice(end);
    const call = meta.kind === 'effect' ? 'BeatForge.effect(' : 'BeatForge.instrument(';
    if (!body.includes(call)) fail(`An ${meta.kind} plugin must call ${call}{ ... }).`);
    // things worth a closer look when reviewing (not forbidden: the audio thread has nothing to steal)
    const warnings = [];
    if (/\beval\s*\(|\bFunction\s*\(/.test(body)) warnings.push('Builds code at run time (eval / Function).');
    if (/WebAssembly/.test(body)) warnings.push('Uses WebAssembly (compiled code you cannot read).');
    if (/registerProcessor|AudioWorkletProcessor|globalThis|\bself\b/.test(body)) warnings.push('Touches the audio thread itself (registerProcessor / globalThis), not just its own sound.');
    if (/\bport\b|postMessage/.test(body)) warnings.push('Mentions port / postMessage.');
    if (body.split('\n').some((l) => l.length > 400)) warnings.push('Has very long lines (minified or obfuscated code is hard to review).');
    if (/[^\x09\x0a\x0d\x20-\x7e]/.test(body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))) warnings.push('Has non-ASCII characters outside comments.');
    return { meta, params, warnings };
  }

  /** The audio-thread module for one plugin: hands the code and its parameter list to the BeatForge host. */
  function wrap(meta, params, source) {
    const key = `${meta.id}@${meta.version}`;
    return `/* BeatForge plugin ${key} */\n(function(){var d=globalThis.__bfDefine;if(!d)return;d(${JSON.stringify(key)},${JSON.stringify(meta.kind)},${JSON.stringify(params)},function(BeatForge){"use strict";\n${source}\n});})();\n`;
  }

  return { parse, wrap, cmpVersion, MAX_SOURCE, ID_RE, VERSION_RE };
});
