#!/usr/bin/env python3
"""Make a macOS .icns from a PNG (PNG-compressed icon entries, which macOS 10.7+ reads): mkicns.py in.png out.icns"""
import io, struct, sys
from PIL import Image

src = Image.open(sys.argv[1]).convert('RGBA')
chunks = b''
for kind, size in ((b'ic07', 128), (b'ic08', 256), (b'ic09', 512), (b'ic10', 1024)):
    buf = io.BytesIO()
    src.resize((size, size), Image.LANCZOS).save(buf, 'PNG')
    data = buf.getvalue()
    chunks += kind + struct.pack('>I', len(data) + 8) + data
open(sys.argv[2], 'wb').write(b'icns' + struct.pack('>I', len(chunks) + 8) + chunks)
