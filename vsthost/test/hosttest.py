#!/usr/bin/env python3
"""Tests the BeatForge Plugin Host over its stdin/stdout protocol (Linux, Windows and Mac).
usage: hosttest.py <host binary> <folder with BFTest* VST2 plugins> [VST3 folder with the SDK's sample plugins]"""
import json, math, os, struct, subprocess, sys, tempfile, time

host, t2 = sys.argv[1], os.path.abspath(sys.argv[2])
v3 = os.path.abspath(sys.argv[3]) if len(sys.argv) > 3 else None
cache = os.path.join(tempfile.mkdtemp(), 'vst-cache.txt')
p = subprocess.Popen([host], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=dict(os.environ, BF_VST_CACHE=cache))
seq = 0
fails = []

def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what, flush=True)
    if not ok: fails.append(what)

def read_frame():
    hd = p.stdout.read(8)
    if len(hd) < 8: raise SystemExit('host closed its output')
    hl, bl = struct.unpack('<II', hd)
    return json.loads(p.stdout.read(hl)), p.stdout.read(bl)

def call(*fields, bin=b''):
    global seq
    seq += 1
    rid = f'm{seq}'
    head = '\t'.join([rid] + [str(f) for f in fields]).encode()
    p.stdin.write(struct.pack('<II', len(head), len(bin)) + head + bin); p.stdin.flush()
    while True:
        h, b = read_frame()
        if h.get('ev'):
            if h['ev'] == 'log': print('     log:', h['msg'])
            continue
        if h.get('id') == rid: return h, b

def render(inst, frames, events=(), params=(), inp=None, tempo=120, playing=1, pos=0):
    b = b''.join(struct.pack('<iiif', *e) for e in events) + b''.join(struct.pack('<Id', *q) for q in params)
    if inp: b += struct.pack(f'<{frames}f', *inp[0]) + struct.pack(f'<{frames}f', *inp[1])
    h, out = call('render', inst, frames, len(events), len(params), tempo, playing, pos, bin=b)
    vals = struct.unpack(f'<{frames * 2}f', out)
    return h, vals[:frames], vals[frames:]

peak = lambda x: max(abs(v) for v in x) if x else 0
def freq(x, rate=44100):
    z = sum(1 for i in range(1, len(x)) if x[i - 1] < 0 <= x[i])
    return z * rate / len(x)

h, _ = call('ping'); check(h.get('ok') and h.get('version') == 2, 'ping, protocol version 2')
folders = [t2] + ([v3] if v3 else [])
t0 = time.time(); h, _ = call('scan', *folders); first = time.time() - t0
pl = h.get('plugins', [])
by = {x['name']: x for x in pl}
check('BF Test Synth 2' in by and by['BF Test Synth 2']['fmt'] == 'VST2' and by['BF Test Synth 2']['kind'] == 'instrument', 'scan finds the VST2 synth as an instrument')
check('BF Test Gain 2' in by and by['BF Test Gain 2']['kind'] == 'effect', 'scan finds the VST2 effect')
check(not any('Crash' in x['path'] or 'NotAPlugin' in x['path'] for x in pl), 'a crashing plugin and a junk file are skipped, the scan survives')
if v3: check(any(x['fmt'] == 'VST3' for x in pl), f"scan still finds VST3 plugins ({sum(1 for x in pl if x['fmt'] == 'VST3')})")
check(os.path.exists(cache) and 'BFTestSynth' in open(cache).read(), 'scan cache written')
t0 = time.time(); h2, _ = call('scan', *folders); second = time.time() - t0
check(len(h2['plugins']) == len(pl), f'second scan from cache gives the same list ({first:.2f}s first, {second:.2f}s cached)')

s = by['BF Test Synth 2']
h, _ = call('load', 's1', s['path'], s['cid'], 44100, 512)
check(not h.get('error') and h['kind'] == 'instrument' and h['params'][0]['title'] == 'Level', f"load VST2 synth: {h.get('error') or h['params']}")
_, L, R = render('s1', 4410, events=[(0, 0, 69, 1.0)])
check(abs(freq(L) - 440) < 15 and abs(peak(L) - 0.5) < 0.02, f'note A4 plays at 440 Hz, level 0.5 (got {freq(L):.0f} Hz, {peak(L):.3f})')
call('setparam', 's1', 0, 1.0)
_, L, R = render('s1', 4410)
check(abs(peak(L) - 1.0) < 0.02, f'knob from BeatForge: level 1.0 (got {peak(L):.3f})')
_, L, R = render('s1', 4410, events=[(100, 1, 69, 0)])
check(peak(L[200:]) < 1e-6, 'note off stops the note')
h, st = call('getstate', 's1')
cn = struct.unpack('<I', st[:4])[0]
check(st[4:5] == b'C' and b'level=1.0' in st[5:4 + cn], f'state uses the plugin chunk: {st[5:4+cn]!r}')
call('setparam', 's1', 0, 0.2)
h, _ = call('setstate', 's1', bin=st)
check(h.get('values') == [[0, 1.0]], f"setstate restores the chunk: {h.get('values')}")

g = by['BF Test Gain 2']
h, _ = call('load', 'g1', g['path'], g['cid'], 44100, 256)
check(not h.get('error') and h['kind'] == 'effect' and h['ins'] == 1, 'load VST2 effect')
n = 2048
sig = [math.sin(i * 0.05) * 0.4 for i in range(n)]
_, L, R = render('g1', n, inp=(sig, sig))
check(abs(peak(L) - 0.4) < 0.01 and abs(L[500] - sig[500]) < 1e-5, f'effect processes the input (gain 1: {peak(L):.3f})')
_, L, R = render('g1', n, params=[(0, 0.25)], inp=(sig, sig))
check(abs(peak(L) - 0.2) < 0.01, f'automation from BeatForge: gain 0.5 (got {peak(L):.3f})')
h, st = call('getstate', 'g1')
check(st[4:5] == b'P', 'state without a chunk = the knob values')
call('setparam', 'g1', 0, 0.9)
h, _ = call('setstate', 'g1', bin=st)
check(h.get('values') and abs(h['values'][0][1] - 0.25) < 1e-6, f"setstate restores knob values: {h.get('values')}")
h, _ = call('edit', 'g1', 'Test window')
if sys.platform.startswith('linux'): check('error' in h, 'edit on Linux: says windows are for Windows and Mac')
else:
    check(h.get('ok'), f"edit opens the plugin's window: {h}")
    time.sleep(0.5)
    h, _ = call('edit', 'g1', 'Test window'); check(h.get('ok'), 'edit again brings it to the front')
    h, _ = call('closeedit', 'g1'); check(h.get('ok'), 'closeedit closes it')
call('unload', 'g1'); call('unload', 's1')
h, _, _ = render('s1', 64)
check(h.get('error') == 'not loaded', 'unloaded instance is gone')

if v3:
    synth = next((x for x in pl if x['fmt'] == 'VST3' and x['kind'] == 'instrument'), None)
    if synth:
        h, _ = call('load', 'v3', synth['path'], synth['cid'], 44100, 512)
        check(not h.get('error'), f"VST3 instrument still loads: {synth['name']}")
        _, L, R = render('v3', 8820, events=[(0, 0, 60, 0.9)])
        check(peak(L) > 0.01, f"VST3 {synth['name']} plays a note (peak {peak(L):.3f})")
        call('unload', 'v3')
p.stdin.close(); p.wait(timeout=10)
print('\n' + (f'{len(fails)} FAILED' if fails else 'all passed'))
sys.exit(1 if fails else 0)
