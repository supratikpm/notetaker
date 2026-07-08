import struct, zlib, os

def make_png(size, r, g, b):
    def chunk(name, data):
        c = zlib.crc32(name + data) & 0xffffffff
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", c)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    rows = b""
    for _ in range(size):
        rows += b"\x00" + bytes([r, g, b] * size)
    idat = zlib.compress(rows)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

icons_dir = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
for size in [16, 48, 128]:
    data = make_png(size, 29, 78, 216)
    path = os.path.join(icons_dir, f"icon{size}.png")
    with open(path, "wb") as f:
        f.write(data)
    print(f"Written: icon{size}.png ({len(data)} bytes)")
