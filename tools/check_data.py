"""Validate the phrasebook data.

Checks every entry in web/data:
  * the JSON parses and has the expected shape,
  * ids are unique (id = file id + "|" + Japanese text),
  * the kana field is only kana, and the romaji field is only latin text,
  * the romaji matches the kana reading (a loose Hepburn comparison that
    ignores long-vowel spelling, spaces, and the particles wa/o/e).

The romaji check cannot tell whether the kana is the right reading of the
kanji. That needs a human or review pass.

Usage:  python tools/check_data.py        (exit code 1 on any error)
"""
import itertools
import json
import re
import sys
import unicodedata
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "web" / "data"

BASE = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "ゐ": "i", "ゑ": "e", "を": "wo", "ん": "n", "ゔ": "vu",
    "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o",
}
# Particles that are written one way and said another.
AMBIGUOUS = {"は": ("ha", "wa"), "を": ("wo", "o"), "へ": ("he", "e")}
SMALL_Y = {"ゃ": "a", "ゅ": "u", "ょ": "o"}
SMALL_V = {"ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o"}
PUNCT_KANA = set(" 　。、？！?!・「」『』（）()〜~…,.:：/／")
KANA_OK = re.compile(r"^[぀-ゟ゠-ヿ\s。、？！?!・「」『』（）()〜~…,.:：/／]+$")
ROMAJI_OK = re.compile(r"^[A-Za-zāīūēōĀĪŪĒŌ0-9\s'’\-.,!?;:()/\"~…]+$")
HAS_JA = re.compile(r"[぀-ヿ一-鿿々]")


def to_hiragana(s):
    out = []
    for ch in s:
        o = ord(ch)
        if 0x30A1 <= o <= 0x30F6:
            out.append(chr(o - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def kana_tokens(kana):
    """Kana string -> list of romaji choices (tuples), one per sound."""
    s = to_hiragana(unicodedata.normalize("NFKC", kana))
    toks = []
    pending_sokuon = False
    i = 0
    while i < len(s):
        ch = s[i]
        if ch in PUNCT_KANA:
            i += 1
            continue
        if ch == "ー":
            if toks:
                toks.append((toks[-1][0][-1],))
            i += 1
            continue
        if ch == "っ":
            pending_sokuon = True
            i += 1
            continue
        if ch in AMBIGUOUS:
            choices = AMBIGUOUS[ch]
        elif ch in BASE:
            choices = (BASE[ch],)
        else:
            raise ValueError(f"unknown kana {ch!r}")
        nxt = s[i + 1] if i + 1 < len(s) else ""
        if nxt in SMALL_Y and choices[0].endswith("i") and len(choices[0]) > 1:
            r = choices[0]
            stem = r[:-1] if r in ("shi", "chi", "ji") else r[:-1] + "y"
            choices = (stem + SMALL_Y[nxt],)
            i += 1
        elif nxt in SMALL_Y and choices[0] in ("te", "de"):
            choices = (choices[0][0] + "y" + SMALL_Y[nxt],)  # デュ dyu
            i += 1
        elif nxt in SMALL_V and ch not in SMALL_V:
            r = choices[0]
            if r in ("shi", "chi", "ji") and nxt == "ぇ":
                choices = (r[:-1] + "e",)  # シェ she, チェ che, ジェ je
            elif r in ("te", "de") and nxt == "ぃ":
                choices = (r[0] + "i",)  # ティ ti, ディ di
            elif r in ("to", "do") and nxt == "ぅ":
                choices = (r[0] + "u",)  # トゥ tu
            elif r == "u":
                choices = ("w" + SMALL_V[nxt],)  # ウィ wi, ウェ we, ウォ wo
            elif r == "vu":
                choices = ("v" + SMALL_V[nxt],)  # ヴァ va
            elif r == "fu":
                choices = ("f" + SMALL_V[nxt],)  # ファ fa, フィ fi
            elif r == "tsu":
                choices = ("ts" + SMALL_V[nxt],)  # ツァ tsa
            else:
                choices = (r[:-1] + SMALL_V[nxt],)
            i += 1
        if pending_sokuon:
            choices = tuple(("t" if c.startswith("ch") else c[0]) + c for c in choices)
            pending_sokuon = False
        toks.append(choices)
        i += 1
    return toks


def norm(s):
    s = unicodedata.normalize("NFC", s).lower()
    s = re.sub(r"\([^)]*\)", "", s)  # (food), (name) placeholders
    for a, b in (("ā", "aa"), ("ī", "ii"), ("ū", "uu"), ("ē", "ee"), ("ō", "oo"),
                 ("â", "aa"), ("ô", "oo"), ("û", "uu")):
        s = s.replace(a, b)
    s = re.sub(r"[^a-z]", "", s)
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"([aiueo])\1+", r"\1", s)
        s = s.replace("ou", "o").replace("ei", "e")
    # ん before b/m/p is sometimes written m (shimbun).
    s = re.sub(r"m(?=[bmp])", "n", s)
    return s


def romaji_matches(kana, romaji):
    toks = kana_tokens(kana)
    target = norm(romaji)
    if sum(1 for t in toks if len(t) > 1) > 12:
        return True  # too many particles to expand; skip
    return any(norm("".join(c)) == target for c in itertools.product(*toks))


def main():
    errors = []
    seen = {}
    count = {"phrases": 0, "vocab": 0, "etiquette": 0, "etq": 0}

    def check_entry(where, file_id, e, kind):
        if not isinstance(e, list) or not (4 <= len(e) <= 6):
            errors.append(f"{where}: entry must be [en, ja, kana, romaji, note?, tags?]: {e!r}")
            return
        en, ja, kana, romaji = e[:4]
        for name, val in (("en", en), ("ja", ja), ("kana", kana), ("romaji", romaji)):
            if not isinstance(val, str) or not val.strip():
                errors.append(f"{where}: empty {name}: {e!r}")
                return
        if not HAS_JA.search(ja):
            errors.append(f"{where}: ja has no Japanese: {ja!r}")
        if not KANA_OK.match(kana):
            errors.append(f"{where}: kana has non-kana characters: {kana!r}")
            return
        if not ROMAJI_OK.match(romaji):
            errors.append(f"{where}: romaji has odd characters: {romaji!r}")
        try:
            if not romaji_matches(kana, romaji):
                gen = "".join(t[0] for t in kana_tokens(kana))
                errors.append(f"{where}: romaji/kana mismatch: {romaji!r} vs {kana!r} (kana reads {gen!r})")
        except ValueError as ex:
            errors.append(f"{where}: {ex} in {kana!r}")
        if len(e) >= 5 and not isinstance(e[4], str):
            errors.append(f"{where}: note must be a string")
        if len(e) == 6 and not isinstance(e[5], str):
            errors.append(f"{where}: tags must be a space-separated string")
        eid = f"{file_id}|{ja}"
        if eid in seen:
            errors.append(f"{where}: duplicate id {eid!r} (also {seen[eid]})")
        seen[eid] = where
        count[kind] += 1

    index = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    topic_ids = {t["id"] for t in index["vocab"]}
    for cat in index["categories"]:
        for key in ("id", "name", "icon"):
            if key not in cat:
                errors.append(f"index.json: category missing {key}: {cat}")
        for v in cat.get("vocab", []):
            if v not in topic_ids:
                errors.append(f"index.json: category {cat['id']} links unknown vocab topic {v}")
        p = DATA / "phrases" / f"{cat['id']}.json"
        if not p.exists():
            errors.append(f"missing phrases/{p.name}")
            continue
        doc = json.loads(p.read_text(encoding="utf-8"))
        if not doc.get("sections"):
            errors.append(f"{p.name}: no sections")
        for si, sec in enumerate(doc.get("sections", [])):
            if not sec.get("title") or not sec.get("items"):
                errors.append(f"{p.name}: section {si} needs title and items")
            for ei, e in enumerate(sec.get("items", [])):
                check_entry(f"phrases/{p.name} [{sec.get('title')}] #{ei + 1}", cat["id"], e, "phrases")
    for topic in index["vocab"]:
        for key in ("id", "name", "icon"):
            if key not in topic:
                errors.append(f"index.json: vocab topic missing {key}: {topic}")
        p = DATA / "vocab" / f"{topic['id']}.json"
        if not p.exists():
            errors.append(f"missing vocab/{p.name}")
            continue
        doc = json.loads(p.read_text(encoding="utf-8"))
        for ei, e in enumerate(doc.get("items", [])):
            check_entry(f"vocab/{p.name} #{ei + 1}", "v-" + topic["id"], e, "vocab")
    et = DATA / "etiquette.json"
    if et.exists():
        doc = json.loads(et.read_text(encoding="utf-8"))
        for g in doc["groups"]:
            for c in g["cards"]:
                count["etiquette"] += 1
                if c.get("do") not in (True, False) or not c.get("title") or not c.get("body"):
                    errors.append(f"etiquette.json [{g['title']}]: card needs do/title/body: {c}")
                if "say" in c:
                    check_entry(f"etiquette.json [{g['title']}] {c['title']}", "etq", c["say"], "etq")
    else:
        errors.append("missing etiquette.json")

    for e in errors:
        print("ERROR", e)
    print(f"{count['phrases']} phrases, {count['vocab']} words, "
          f"{count['etiquette']} etiquette cards, {len(errors)} errors")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
