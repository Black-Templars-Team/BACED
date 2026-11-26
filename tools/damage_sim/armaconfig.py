"""Read Arma 3 PBO archives and binarized (rapified) configs. Stdlib only.

CLI: python3 armaconfig.py <file.pbo> [--class CfgAmmo]
"""
import re
import struct
import sys

PACK_VERS = 0x56657273
PACK_COMPRESSED = 0x43707273


class PboError(Exception):
    pass


class ArrayAppend(list):
    """Value of a `name[] += {...}` entry."""


class ConfigClass:
    __slots__ = ("name", "base", "entries", "_lower", "externs", "deletes")

    def __init__(self, name, base=None):
        self.name = name
        self.base = base
        self.entries = {}
        self._lower = {}
        self.externs = []
        self.deletes = []

    def set(self, key, value):
        old = self._lower.get(key.lower())
        if old is not None and old != key:
            del self.entries[old]
        self.entries[key] = value
        self._lower[key.lower()] = key

    def get(self, key, default=None):
        real = self._lower.get(key.lower())
        return default if real is None else self.entries[real]

    def classes(self):
        return [v for v in self.entries.values() if isinstance(v, ConfigClass)]

    def __repr__(self):
        return f"<ConfigClass {self.name}: {self.base} ({len(self.entries)})>"


# ---------------------------------------------------------------- PBO

def _asciiz(f):
    out = bytearray()
    while True:
        c = f.read(1)
        if not c:
            raise PboError("unexpected end of header")
        if c == b"\0":
            return out.decode("utf-8", "replace")
        out += c
        if len(out) > 1024:
            raise PboError("header string too long (encrypted/obfuscated PBO?)")


def read_pbo_index(path):
    entries = []
    props = {}
    with open(path, "rb") as f:
        first = True
        while True:
            name = _asciiz(f)
            raw = f.read(20)
            if len(raw) < 20:
                raise PboError("truncated header")
            packing, orig, _res, _ts, size = struct.unpack("<5I", raw)
            if first and name == "" and packing == PACK_VERS:
                while True:
                    k = _asciiz(f)
                    if k == "":
                        break
                    props[k] = _asciiz(f)
                first = False
                continue
            first = False
            if name == "":
                break
            entries.append({"name": name, "packing": packing, "orig": orig, "size": size})
        offset = f.tell()
    for e in entries:
        e["offset"] = offset
        offset += e["size"]
    return entries, props


def _lzss(data, out_len):
    out = bytearray()
    i = 0
    n = len(data)
    while len(out) < out_len and i < n:
        flags = data[i]
        i += 1
        for bit in range(8):
            if len(out) >= out_len or i >= n:
                break
            if flags & (1 << bit):
                out.append(data[i])
                i += 1
            else:
                b1, b2 = data[i], data[i + 1]
                i += 2
                rpos = len(out) - (b1 | ((b2 & 0xF0) << 4))
                length = (b2 & 0x0F) + 3
                for _ in range(length):
                    out.append(out[rpos] if rpos >= 0 else 0x20)
                    rpos += 1
    return bytes(out[:out_len])


def read_pbo_file(path, entry):
    with open(path, "rb") as f:
        f.seek(entry["offset"])
        data = f.read(entry["size"])
    if entry["packing"] == PACK_COMPRESSED and entry["orig"] > entry["size"]:
        return _lzss(data, entry["orig"])
    return data


def list_files(path):
    return [e["name"] for e in read_pbo_index(path)[0]]


def find_config(path):
    """Return (bytes, is_binary) for the root config, or (None, None)."""
    entries, _ = read_pbo_index(path)
    by_name = {e["name"].lower(): e for e in entries}
    for name, binary in (("config.bin", True), ("config.cpp", False)):
        if name in by_name:
            return read_pbo_file(path, by_name[name]), binary
    return None, None


# ---------------------------------------------------------------- rapify

class _Reader:
    __slots__ = ("d", "p")

    def __init__(self, data, pos=0):
        self.d = data
        self.p = pos

    def byte(self):
        b = self.d[self.p]
        self.p += 1
        return b

    def u32(self):
        v = struct.unpack_from("<I", self.d, self.p)[0]
        self.p += 4
        return v

    def cint(self):
        v = 0
        shift = 0
        while True:
            b = self.byte()
            v |= (b & 0x7F) << shift
            if not b & 0x80:
                return v
            shift += 7

    def sz(self):
        end = self.d.index(b"\0", self.p)
        s = self.d[self.p:end].decode("utf-8", "replace")
        self.p = end + 1
        return s

    def scalar(self, t):
        if t == 0:
            return self.sz()
        if t == 1:
            v = struct.unpack_from("<f", self.d, self.p)[0]
            self.p += 4
            return v
        if t == 2:
            v = struct.unpack_from("<i", self.d, self.p)[0]
            self.p += 4
            return v
        if t == 6:
            v = struct.unpack_from("<q", self.d, self.p)[0]
            self.p += 8
            return v
        if t == 4:
            return self.sz()
        raise ValueError(f"bad value type {t} at {self.p}")

    def array(self):
        out = []
        for _ in range(self.cint()):
            t = self.byte()
            out.append(self.array() if t == 3 else self.scalar(t))
        return out


def _parse_body(r, cls, keep_top=None):
    base = r.sz()
    cls.base = base or None
    for _ in range(r.cint()):
        t = r.byte()
        if t == 0:
            name = r.sz()
            offset = r.u32()
            if keep_top is not None and name.lower() not in keep_top:
                continue
            sub = ConfigClass(name)
            saved = r.p
            r.p = offset
            _parse_body(r, sub)
            r.p = saved
            cls.set(name, sub)
        elif t == 1:
            sub_t = r.byte()
            name = r.sz()
            cls.set(name, r.scalar(sub_t))
        elif t == 2:
            name = r.sz()
            cls.set(name, r.array())
        elif t == 3:
            cls.externs.append(r.sz())
        elif t == 4:
            cls.deletes.append(r.sz())
        elif t == 5:
            r.u32()
            name = r.sz()
            cls.set(name, ArrayAppend(r.array()))
        else:
            raise ValueError(f"bad entry type {t} at {r.p}")


def parse_rapified(data, keep_top=None):
    if data[:4] != b"\0raP":
        raise ValueError("not a rapified config")
    root = ConfigClass("")
    _parse_body(_Reader(data, 16), root, keep_top)
    return root


_TOKEN = re.compile(r'\s+|//[^\n]*|/\*.*?\*/|"(?:[^"]|"")*"|\+=|[{}\[\];:=,]|[^\s{}\[\];:=,"]+', re.S)


def _tokens(text):
    for m in _TOKEN.finditer(text):
        tok = m.group(0)
        if tok[0].isspace() or tok.startswith(("//", "/*")):
            continue
        yield tok


def _atom(tok):
    if tok.startswith('"'):
        return tok[1:-1].replace('""', '"')
    try:
        return int(tok)
    except ValueError:
        pass
    try:
        return float(tok)
    except ValueError:
        return tok


class _TextParser:
    def __init__(self, text):
        self.toks = list(_tokens(text))
        self.i = 0

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self, expect=None):
        tok = self.toks[self.i]
        self.i += 1
        if expect is not None and tok != expect:
            raise ValueError(f"expected {expect!r}, got {tok!r} at token {self.i}")
        return tok

    def array(self):
        self.take("{")
        out = []
        while self.peek() != "}":
            if self.peek() == "{":
                out.append(self.array())
            else:
                out.append(_atom(self.take()))
            if self.peek() == ",":
                self.take()
        self.take("}")
        return out

    def body(self, cls, keep_top=None):
        while self.peek() is not None and self.peek() != "}":
            tok = self.take()
            if tok == ";":
                continue
            if tok == "class":
                name = self.take()
                if self.peek() == ";":
                    cls.externs.append(name)
                    continue
                base = None
                if self.peek() == ":":
                    self.take()
                    base = self.take()
                self.take("{")
                sub = ConfigClass(name, base)
                self.body(sub)
                self.take("}")
                if keep_top is None or name.lower() in keep_top:
                    existing = cls.get(name)
                    if isinstance(existing, ConfigClass):  # same class twice in one file: merge
                        existing.base = base or existing.base
                        for k, v in sub.entries.items():
                            existing.set(k, v)
                    else:
                        cls.set(name, sub)
            elif tok == "delete":
                cls.deletes.append(self.take())
            else:
                name = tok
                if self.peek() == "[":
                    self.take("[")
                    self.take("]")
                    op = self.take()
                    value = self.array()
                    cls.set(name, ArrayAppend(value) if op == "+=" else value)
                else:
                    self.take("=")
                    cls.set(name, _atom(self.take()))


def parse_text(text, keep_top=None):
    """Parse preprocessed config text (e.g. `hemtt utils config convert -f cpp` output)."""
    root = ConfigClass("")
    _TextParser(text).body(root, keep_top)
    return root


def _fmt_value(v):
    if isinstance(v, list):
        return "{" + ", ".join(_fmt_value(x) for x in v) + "}"
    if isinstance(v, str):
        return '"' + v.replace('"', '""') + '"'
    if isinstance(v, float):
        return repr(round(v, 7))
    return str(v)


def to_text(cls, indent=0):
    pad = "    " * indent
    lines = []
    for name in cls.externs:
        lines.append(f"{pad}class {name};")
    for name in cls.deletes:
        lines.append(f"{pad}delete {name};")
    for name, v in cls.entries.items():
        if isinstance(v, ConfigClass):
            head = f"{pad}class {name}" + (f": {v.base}" if v.base else "")
            lines.append(head + " {")
            lines.append(to_text(v, indent + 1))
            lines.append(pad + "};")
        elif isinstance(v, ArrayAppend):
            lines.append(f"{pad}{name}[] += {_fmt_value(list(v))};")
        elif isinstance(v, list):
            lines.append(f"{pad}{name}[] = {_fmt_value(v)};")
        else:
            lines.append(f"{pad}{name} = {_fmt_value(v)};")
    return "\n".join(x for x in lines if x)


if __name__ == "__main__":
    pbo = sys.argv[1]
    only = sys.argv[sys.argv.index("--class") + 1] if "--class" in sys.argv else None
    _, props = read_pbo_index(pbo)
    print("// prefix:", props.get("prefix"), "files:", len(list_files(pbo)))
    data, binary = find_config(pbo)
    if data is None:
        sys.exit("no config")
    if not binary:
        print(data.decode("utf-8", "replace"))
        sys.exit()
    root = parse_rapified(data, {only.lower()} if only else None)
    print(to_text(root))
