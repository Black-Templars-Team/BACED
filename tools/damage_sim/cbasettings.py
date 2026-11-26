"""Pull CBA setting definitions (name, type, default, range) out of SQF source.

Handles the literal form (`["HOV_X", "SLIDER", ...] call CBA_fnc_addSetting`) and
ACE/KAT macro names (`QGVAR(x)`, `QEGVAR(module,x)`), given the addon's prefix.
"""
import re

CALL = re.compile(r"call\s+CBA_fnc_addSetting", re.I)
MACRO_NAME = re.compile(r"^Q?Q?(E?)GVAR\((\w+)(?:,(\w+))?\)$")


def _matching_open(text, close_idx):
    depth = 0
    i = close_idx
    in_str = None
    while i >= 0:
        c = text[i]
        if in_str:
            if c == in_str:
                in_str = None
        elif c in "\"'":
            in_str = c
        elif c in "]}":
            depth += 1
        elif c in "[{":
            depth -= 1
            if depth == 0:
                return i if c == "[" else None
        i -= 1
    return None


class _Lit:
    """Tolerant SQF literal reader: strings, numbers, bools, arrays; code and calls become text."""

    def __init__(self, text):
        self.t = text
        self.i = 0

    def ws(self):
        while self.i < len(self.t):
            if self.t[self.i].isspace():
                self.i += 1
            elif self.t.startswith("//", self.i):
                self.i = self.t.find("\n", self.i) % (len(self.t) + 1) or len(self.t)
            elif self.t.startswith("/*", self.i):
                end = self.t.find("*/", self.i)
                self.i = len(self.t) if end < 0 else end + 2
            else:
                break

    def value(self):
        self.ws()
        c = self.t[self.i]
        if c in "\"'":
            q = c
            j = self.i + 1
            out = []
            while True:
                k = self.t.index(q, j)
                out.append(self.t[j:k])
                if self.t.startswith(q * 2, k):
                    out.append(q)
                    j = k + 2
                    continue
                self.i = k + 1
                return "".join(out)
        if c == "[":
            self.i += 1
            items = []
            while True:
                self.ws()
                if self.t[self.i] == "]":
                    self.i += 1
                    return items
                items.append(self.value())
                self.ws()
                if self.t[self.i] == ",":
                    self.i += 1
        if c == "{":
            depth = 0
            start = self.i
            while True:
                ch = self.t[self.i]
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        self.i += 1
                        return {"code": self.t[start:self.i]}
                elif ch in "\"'":
                    self.i = self.t.index(ch, self.i + 1)
                self.i += 1
        # bare token, possibly a macro call like LSTRING(x) or an expression
        start = self.i
        depth = 0
        while self.i < len(self.t):
            ch = self.t[self.i]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif depth == 0 and ch in ",]":
                break
            self.i += 1
        token = self.t[start:self.i].strip()
        low = token.lower()
        if low == "true":
            return True
        if low == "false":
            return False
        if low == "nil":
            return None
        try:
            return float(token) if any(x in token for x in ".eE") else int(token)
        except ValueError:
            return {"expr": token}


def _name(raw, prefix, macros):
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict) and "expr" in raw:
        m = MACRO_NAME.match(raw["expr"].replace(" ", ""))
        if m and prefix:
            ext, a, b = m.groups()
            if ext:
                return f"{prefix.split('_')[0]}_{a}_{b}"
            return f"{prefix}_{a}"
        expr = raw["expr"]
        if expr in macros:
            return macros[expr]
    return None


def _number(v, defines):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    if isinstance(v, dict) and "expr" in v:
        expr = v["expr"]
        if expr in defines:
            return defines[expr]
        try:
            if re.fullmatch(r"[\d.\s*/+()-]+", expr):
                return eval(expr, {"__builtins__": {}})  # arithmetic literals only
        except Exception:
            return None
    return None


def parse_settings(text, prefix=None, defines=None):
    """Return {name: {type, default, min, max, values}} for every addSetting call in text."""
    defines = defines or {}
    out = {}
    for m in CALL.finditer(text):
        close = text.rfind("]", 0, m.start())
        if close < 0:
            continue
        open_idx = _matching_open(text, close)
        if open_idx is None:
            continue
        try:
            args = _Lit(text[open_idx:close + 1]).value()
        except (ValueError, IndexError):
            continue
        if len(args) < 5:
            continue
        name = _name(args[0], prefix, {})
        kind = args[1] if isinstance(args[1], str) else None
        if not name or not kind:
            continue
        info = {"type": kind.upper()}
        spec = args[4]
        if info["type"] == "SLIDER" and isinstance(spec, list) and len(spec) >= 3:
            info.update(min=_number(spec[0], defines), max=_number(spec[1], defines),
                        default=_number(spec[2], defines))
        elif info["type"] == "CHECKBOX":
            if isinstance(spec, list) and spec:  # `[true]` form
                spec = spec[0]
            info["default"] = spec if isinstance(spec, bool) else _number(spec, defines)
        elif info["type"] == "LIST" and isinstance(spec, list) and len(spec) >= 3:
            values = spec[0] if isinstance(spec[0], list) else []
            index = _number(spec[2], defines)
            info["values"] = values
            if isinstance(index, int) and 0 <= index < len(values):
                info["default"] = values[index]
        elif info["type"] == "EDITBOX":
            info["default"] = spec if isinstance(spec, str) else None
        else:
            info["default"] = spec if isinstance(spec, (str, int, float, bool)) else None
        out[name] = info
    return out


DEFINE = re.compile(r"^[ \t]*#define[ \t]+(\w+)[ \t]+(-?(?:\d+(?:\.\d*)?|\.\d+))[ \t\r]*$", re.M)


def parse_defines(text):
    return {k: float(v) if "." in v else int(v) for k, v in DEFINE.findall(text)}


SETTINGS_FILE = re.compile(r"^\s*(?:force\s+)*(\w+)\s*=\s*(.+?);\s*$", re.M | re.I)


def parse_cba_settings_file(text):
    """Parse an exported cba_settings.sqf (`force name = value;` lines)."""
    out = {}
    for name, raw in SETTINGS_FILE.findall(text):
        try:
            out[name] = _Lit(raw).value()
        except (ValueError, IndexError):
            continue
    return out
