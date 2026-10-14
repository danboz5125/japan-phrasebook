"""Rewrite every data file in a stable, readable layout: one entry per line.

Usage:  python tools/fmt_data.py
"""
import json
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "web" / "data"


def dump_items(items, indent):
    pad = " " * indent
    lines = [pad + json.dumps(e, ensure_ascii=False) for e in items]
    return "[\n" + ",\n".join(lines) + "\n" + " " * (indent - 2) + "]"


def fmt_phrases(doc):
    out = ['{\n  "sections": [']
    secs = []
    for s in doc["sections"]:
        head = {k: v for k, v in s.items() if k != "items"}
        h = json.dumps(head, ensure_ascii=False)[:-1]
        secs.append("    " + h + ', "items": ' + dump_items(s["items"], 8) + "}")
    out.append(",\n".join(secs))
    out.append("  ]\n}\n")
    return "\n".join(out)


def fmt_vocab(doc):
    return '{\n  "items": ' + dump_items(doc["items"], 4) + "\n}\n"


def main():
    n = 0
    for p in sorted((DATA / "phrases").glob("*.json")):
        p.write_text(fmt_phrases(json.loads(p.read_text(encoding="utf-8"))), encoding="utf-8")
        n += 1
    for p in sorted((DATA / "vocab").glob("*.json")):
        p.write_text(fmt_vocab(json.loads(p.read_text(encoding="utf-8"))), encoding="utf-8")
        n += 1
    print(f"formatted {n} files")


if __name__ == "__main__":
    sys.exit(main())
