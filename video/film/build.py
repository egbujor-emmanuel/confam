"""Writes the Confam demo film (index.html + compositions/) from one beat list.

The voice is the clock: each beat lasts LEAD + its narration + TAIL. Footage segments are retimed so a
named moment lands on a named word (e.g. the NOT CHARGED stamp on "Not"). Click sounds come from the
tap log the recorder wrote; captions come from the TTS word timings. Run: python build.py
"""
import html
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).parent
FPS = 30
FRAME = 1 / FPS
LEAD, TAIL = 0.5, 0.7
W, H = 1920, 1080
# Phone screen: the 430x932 capture scaled to fit the right half with room for captions below.
SRC_W, SRC_H = 644, 1398  # footage recorded at 1.5x the 430x932 phone layout
SCR_H = 980
SCR_W = round(SCR_H * SRC_W / SRC_H)
SCR_X, SCR_Y = 1440 - SCR_W // 2, 50
BEZEL = 14
SFX_PEAK = {"click-a": 0.073, "click-b": 0.067, "click-c": 0.078, "key": 0.054, "pop": 0.12, "stamp": 0.162, "riser": 1.986}
STAMP_LANDS_AFTER = 0.95  # the app's stamp tween: 0.5 s delay + 0.45 s

words = json.loads((ROOT / "assets/voice/words.json").read_text(encoding="utf-8"))
narration = {n["id"]: n["text"] for n in json.loads((ROOT.parent / "voice/narration.json").read_text(encoding="utf-8"))}
stats = json.loads((ROOT / "assets/stats.json").read_text(encoding="utf-8"))
clicks = {c: json.loads((ROOT / f"assets/footage/{c}.clicks.json").read_text(encoding="utf-8")) for c in ["wallet", "airtime", "fail", "woyofal"]}


def duration(path: Path) -> float:
    out = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(out.decode().strip())


def mark(clip: str, label: str) -> float:
    return next(e["atMs"] for e in clicks[clip] if e["label"] == label) / 1000


def word_time(beat_id: str, text: str) -> float:
    """Beat-local time of the first word equal to `text` in that beat's narration."""
    w = next(w for w in words[beat_id] if w["text"].lower() == text.lower())
    return LEAD + w["start"]


# ---------------------------------------------------------------- beats
# Footage segments: (clip, media_from, media_to, beat_from, beat_to); beat_to None = end of beat.
BEATS = [
    {"id": "s01", "kind": "card", "card": "problem"},
    {"id": "s02", "kind": "card", "card": "numbers"},
    {"id": "s03", "kind": "footage", "eyebrow": "Confam", "headline": "E no land?<br>You no pay.", "sub": "Airtime, data and electricity, paid with Bitcoin.",
     "segments": [("wallet", mark("wallet", "country Nigeria") - 3.6, mark("wallet", "country Nigeria") - 0.3, 0, None)]},
    {"id": "s04", "kind": "footage", "eyebrow": "Step 1", "headline": "Connect a wallet", "sub": "A free test wallet: 25,000 test sats.",
     "segments": [("wallet", mark("wallet", "country Nigeria") - 0.3, mark("wallet", "balance shown") + 1.6, 0, None)],
     "zoom": (0.84, 0.035, 1.9, "m:get test wallet+0.9", "end-0.55")},
    {"id": "s05", "kind": "footage", "eyebrow": "Step 2", "headline": "Number, network,<br>amount", "sub": "The exact price in sats, before you pay.",
     "segments": [("airtime", mark("airtime", "airtime tile") - 0.8, mark("airtime", "pay with wallet") - 0.4, 0, None)],
     "zoom": (0.5, 0.9, 1.55, "m:amount 200+0.5", "end-0.55")},
    {"id": "s06", "kind": "footage", "eyebrow": "Lightning hold invoice", "headline": "Locked,<br>not sent.", "sub": "Confam cannot take your sats yet.",
     "segments": [("airtime", mark("airtime", "pay with wallet") - 0.4, mark("airtime", "final state"), 0, None)],
     "zoom": (0.5, 0.62, 1.45, 1.4, "end-0.55")},
    {"id": "s07", "kind": "footage", "eyebrow": "Provider confirms", "headline": "Delivered first.<br>Paid second.", "sub": "Only then does the payment complete.",
     "segments": [("airtime", mark("airtime", "final state"), mark("airtime", "result card shown") + 4.2, 0, None)], "stamp": ("airtime", "pop"),
     "zoom": (0.5, 0.5, 1.45, "m:result card shown+0.5", "end-0.55")},
    {"id": "s08", "kind": "footage", "eyebrow": "Proof", "headline": "A signed<br>receipt", "sub": "Signed with Nostr, checked in your browser.",
     "segments": [("airtime", mark("airtime", "result card shown") + 7.6, mark("airtime", "result card shown") + 13.0, 0, None)],
     "zoom": (0.5, 0.66, 1.6, 0.5, "end-0.55")},
    {"id": "s09", "kind": "footage", "eyebrow": "The bad day", "headline": "Failed?<br>Not charged.", "sub": "The lock opens. Your sats never left.",
     "segments": [("fail", mark("fail", "continue to pay") - 0.3, mark("fail", "final state") + STAMP_LANDS_AFTER, 0, "w:Not"),
                  ("fail", mark("fail", "final state") + STAMP_LANDS_AFTER, mark("fail", "result card shown") + 4.4, "w:Not", None)],
     "payoff": "w:Not",
     "zoom": (0.5, 0.45, 1.5, "w:Not-0.9", "end-0.55")},
    {"id": "s10", "kind": "footage", "eyebrow": "Dakar · Français", "headline": "Woyofal<br>electricity", "sub": "Same guarantee, in CFA, token on screen.",
     "segments": [("woyofal", mark("woyofal", "numéro de compteur") - 0.4, mark("woyofal", "meter checked") + 0.6, 0, 3.4),
                  ("woyofal", mark("woyofal", "final state"), mark("woyofal", "result card shown") + 4.4, 3.4, None)], "stamp": ("woyofal", "pop"),
     "zoom": (0.5, 0.6, 1.45, 4.0, "end-0.5")},
    {"id": "s11", "kind": "card", "card": "coverage"},
    {"id": "s12", "kind": "card", "card": "stats"},
    {"id": "s13", "kind": "card", "card": "next"},
    {"id": "s14", "kind": "card", "card": "end"},
]

t = 0.0
for b in BEATS:
    b["voice"] = duration(ROOT / f"assets/voice/{b['id']}.mp3")
    b["start"] = round(t, 3)
    b["dur"] = round(LEAD + b["voice"] + TAIL, 3)
    t += b["dur"]
TOTAL = round(t, 3)


def _split_offset(v: str) -> tuple[str, float]:
    m = re.match(r"^(.*?)([+-]\d+(?:\.\d+)?)?$", v)
    return m.group(1), float(m.group(2) or 0)


def resolve(b: dict, v) -> float:
    if v is None:
        return b["dur"]
    if isinstance(v, str) and v.startswith("end"):
        return b["dur"] + float(v[3:] or 0)
    if isinstance(v, str) and v.startswith("w:"):
        word, off = _split_offset(v[2:])
        return word_time(b["id"], word) + off
    if isinstance(v, str) and v.startswith("m:"):
        label, off = _split_offset(v[2:])
        for clip, m0, m1, f0, f1 in b["segments"]:
            t = mark(clip, label)
            if m0 <= t <= m1:
                bf0, bf1 = resolve(b, f0), resolve(b, f1)
                return bf0 + (t - m0) * (bf1 - bf0) / (m1 - m0) + off
        raise ValueError(f"{b['id']}: tap {label!r} is outside this beat's footage")
    return float(v)


# ---------------------------------------------------------------- media, sounds, captions
videos, sounds = [], []
take = 0


def add_sound(name: str, at: float, volume: float) -> None:
    """Place a sound so its peak lands one frame after `at` (absolute seconds)."""
    start = round(max(0.0, at - SFX_PEAK[name] + FRAME), 3)
    sounds.append({"name": name, "start": start, "volume": volume})


for b in BEATS:
    if b["kind"] != "footage":
        continue
    for i, (clip, m0, m1, f0, f1) in enumerate(b["segments"]):
        bf0, bf1 = resolve(b, f0), resolve(b, f1)
        rate = (m1 - m0) / (bf1 - bf0)
        assert 0.1 <= rate <= 10, (b["id"], rate)
        videos.append({"id": f"v-{b['id']}-{i}", "clip": clip, "start": round(b["start"] + bf0, 3), "dur": round(bf1 - bf0, 3), "media": round(m0, 3), "rate": round(rate, 4)})
        for e in clicks[clip]:
            at_media = e["atMs"] / 1000
            if not (m0 <= at_media < m1):
                continue
            at = b["start"] + bf0 + (at_media - m0) / rate
            if e["kind"] == "click":
                add_sound(["click-a", "click-b", "click-c"][take % 3], at, 0.9)
                take += 1
            elif e["kind"] == "typing":
                per_char = 0.085 / rate
                for c in range(0, e.get("chars", 0), 2):  # a soft tick every second character
                    add_sound("key", at + c * per_char, 0.5 if c % 4 else 0.62)
    if "stamp" in b:
        clip, kind = b["stamp"]
        seg = b["segments"][-1]
        rate = (seg[2] - seg[1]) / (resolve(b, seg[4]) - resolve(b, seg[3]))
        landed = b["start"] + resolve(b, seg[3]) + (STAMP_LANDS_AFTER) / rate
        add_sound(kind, landed, 0.8)
    if "payoff" in b:
        impact = b["start"] + resolve(b, b["payoff"])
        add_sound("riser", impact, 0.55)
        add_sound("stamp", impact, 0.9)


def caption_groups() -> list[dict]:
    """Groups of 3-5 words; break at sentence ends, pauses of 150 ms+, or 5 words."""
    groups = []
    for b in BEATS:
        text = narration[b["id"]].replace("Con-fam", "Confam").replace("C F A", "CFA")
        tokens = text.split()
        ws = words[b["id"]]
        # Re-attach punctuation and real spelling to the TTS word timings, by position.
        display, ti = [], 0
        for wi, w in enumerate(ws):
            if w["text"] in ("C", "F", "A") and ti < len(tokens) and tokens[ti].startswith("CFA"):
                if w["text"] == "A":
                    display.append((tokens[ti], ws[wi - 2]["start"], w["end"]))
                    ti += 1
                continue
            tok = tokens[ti] if ti < len(tokens) else w["text"]
            display.append((tok, w["start"], w["end"]))
            ti += 1
        cur = []
        for i, (tok, s, e) in enumerate(display):
            cur.append((tok, s, e))
            nxt = display[i + 1] if i + 1 < len(display) else None
            end_sentence = re.search(r"[.?!]$", tok) is not None
            pause = nxt is not None and nxt[1] - e >= 0.15 and len(cur) >= 3
            if nxt is None or end_sentence or pause or len(cur) >= 5:
                base = b["start"] + LEAD
                groups.append({"text": " ".join(x[0] for x in cur), "start": round(base + cur[0][1] - 0.05, 3), "end": round(base + cur[-1][2] + 0.12, 3), "left": b["kind"] == "footage"})
                cur = []
    for g, nxt in zip(groups, groups[1:]):  # one group at a time
        g["end"] = min(g["end"], nxt["start"] - 0.02)
    return groups


# ---------------------------------------------------------------- compositions
STYLE_BASE = """
#root { position: absolute; inset: 0; color: #fbf8f1; font-family: 'Inter', sans-serif; }
.eyebrow { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 26px; letter-spacing: 0.12em; text-transform: uppercase; color: #c6f432; }
.display { font-family: 'Outfit', sans-serif; font-weight: 900; letter-spacing: -0.02em; line-height: 0.98; }
.sub { font-size: 34px; line-height: 1.35; color: rgba(251, 248, 241, 0.82); }
.src { font-family: 'JetBrains Mono', monospace; font-size: 20px; color: rgba(251, 248, 241, 0.55); }
"""


def scene(cid: str, dur: float, style: str, body: str, js: str) -> str:
    return f"""<template>
  <style>{STYLE_BASE}{style}</style>
  <div id="root" data-composition-id="{cid}" data-width="{W}" data-height="{H}">
{body}
  </div>
  <script>
    const tl = gsap.timeline({{ paused: true }});
{js}
    window.__timelines["{cid}"] = tl;
  </script>
</template>
"""


def rise(sel: str, at: float, y: int = 40, d: float = 0.5) -> str:
    return f'    tl.fromTo("{sel}", {{ opacity: 0, y: {y} }}, {{ opacity: 1, y: 0, duration: {d}, ease: "power3.out" }}, {at:.3f});\n'


def out(sel: str, at: float) -> str:
    return f'    tl.to("{sel}", {{ opacity: 0, duration: 0.3, ease: "power2.in" }}, {at:.3f});\n'


def footage_scene(b: dict) -> str:
    cid = b["id"]
    body = f"""    <div id="{cid}-panel" class="clip" data-start="0" data-duration="{b['dur']}" style="position:absolute; left:150px; top:0; width:920px; height:{H}px; display:flex; flex-direction:column; justify-content:center; gap:28px;">
      <div id="{cid}-eyebrow" class="eyebrow">{html.escape(b['eyebrow'])}</div>
      <div id="{cid}-headline" class="display" style="font-size:112px;">{b['headline']}</div>
      <div id="{cid}-sub" class="sub" style="max-width:820px;">{html.escape(b['sub'])}</div>
    </div>"""
    js = rise(f"#{cid}-eyebrow", 0.1, 20) + rise(f"#{cid}-headline", 0.22, 50, 0.6) + rise(f"#{cid}-sub", 0.5, 24) + out(f"#{cid}-panel", b["dur"] - 0.32)
    return scene(cid, b["dur"], "", body, js)


def card_scene(b: dict) -> str:
    cid, d, kind = b["id"], b["dur"], b["card"]
    wt = lambda w: word_time(cid, w)  # noqa: E731
    if kind == "problem":
        lines = [("You pay.", "buy"), ("Debited.", "debited"), ("It never lands.", "never"), ("Refund? Two weeks.", "refund")]
        body = "\n".join(
            f'      <div id="{cid}-l{i}" class="display" style="font-size:{124 if i != 3 else 104}px; color:{"#c6f432" if i == 2 else ("#ff8a7a" if i == 3 else "#fbf8f1")};">{html.escape(txt)}</div>'
            for i, (txt, _) in enumerate(lines)
        )
        body = f'    <div id="{cid}-wrap" class="clip" data-start="0" data-duration="{d}" style="position:absolute; left:180px; top:0; height:{H}px; display:flex; flex-direction:column; justify-content:center; gap:18px;">\n{body}\n    </div>'
        js = "".join(rise(f"#{cid}-l{i}", max(0.1, wt(w) - 0.1), 40) for i, (_, w) in enumerate(lines)) + out(f"#{cid}-wrap", d - 0.32)
    elif kind == "numbers":
        body = f"""    <div id="{cid}-wrap" class="clip" data-start="0" data-duration="{d}" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:140px;">
      <div id="{cid}-a" style="display:flex; flex-direction:column; gap:14px; width:640px;">
        <div class="display" style="font-size:180px; color:#c6f432;">200.3M</div>
        <div class="sub">active mobile lines in Nigeria</div>
        <div class="src">NCC industry statistics · Sep 2026</div>
      </div>
      <div id="{cid}-b" style="display:flex; flex-direction:column; gap:14px; width:640px;">
        <div class="display" style="font-size:180px; color:#fbf8f1;">1.63M</div>
        <div class="sub">Woyofal prepaid meters in Senegal</div>
        <div class="src">Senelec · Aug 2023</div>
      </div>
    </div>"""
        js = rise(f"#{cid}-a", wt("millions") - 0.1) + rise(f"#{cid}-b", wt("meters") - 0.1) + out(f"#{cid}-wrap", d - 0.32)
    elif kind == "coverage":
        cols = [("19", "countries", "airtime", "nineteen"), ("13", "countries", "data", "thirteen"), ("2", "countries", "electricity · Nigeria, Senegal", "electricity")]
        items = "\n".join(
            f'      <div id="{cid}-c{i}" style="display:flex; flex-direction:column; gap:10px; width:440px;"><div class="display" style="font-size:220px; color:{"#c6f432" if i == 0 else "#fbf8f1"};">{n}</div><div class="sub" style="font-weight:700;">{u}</div><div class="sub">{html.escape(what)}</div></div>'
            for i, (n, u, what, _) in enumerate(cols)
        )
        body = f'    <div id="{cid}-wrap" class="clip" data-start="0" data-duration="{d}" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:90px;">\n{items}\n    </div>'
        js = "".join(rise(f"#{cid}-c{i}", max(0.1, wt(w) - 0.15)) for i, (_, _, _, w) in enumerate(cols)) + out(f"#{cid}-wrap", d - 0.32)
    elif kind == "stats":
        s = stats
        rows = [
            ("orders", f"{s['ordersCreated']}"),
            ("completed", f"{s['completed']}"),
            ("released, not charged", f"{s['released']['total']}"),
            ("median seconds to delivery", f"{s['medianSecondsToDelivery']}"),
        ]
        cells = "\n".join(f'        <div id="{cid}-r{i}" style="display:flex; flex-direction:column; gap:6px;"><div class="display" style="font-size:84px;">{v}</div><div class="sub" style="font-size:26px;">{k}</div></div>' for i, (k, v) in enumerate(rows))
        body = f"""    <div id="{cid}-wrap" class="clip" data-start="0" data-duration="{d}" style="position:absolute; left:180px; right:180px; top:0; height:{H}px; display:flex; flex-direction:column; justify-content:center; gap:46px;">
      <div class="eyebrow">Live metrics · last {s['windowDays']} days · test mode</div>
      <div id="{cid}-zero" style="display:flex; align-items:baseline; gap:36px;"><div class="display" style="font-size:260px; color:#c6f432;">{s['chargedWithoutDelivery']}</div><div class="display" style="font-size:72px;">charged without<br>delivery</div></div>
      <div id="{cid}-rows" style="display:flex; gap:110px;">
{cells}
      </div>
      <div class="src">confam-qxdh.onrender.com/api/stats · released orders include our deliberate failure tests</div>
    </div>"""
        js = "".join(rise(f"#{cid}-r{i}", 0.3 + i * 0.25, 24) for i in range(len(rows))) + rise(f"#{cid}-zero", wt("charged") - 0.1, 50, 0.6) + out(f"#{cid}-wrap", d - 0.32)
    elif kind == "next":
        items = [("Real money on our own Lightning node", "real"), ("TV and water bills", "TV"), ("Automatic meter top-ups", "automatic"), ("Agents who accept sats on the street", "agents")]
        lis = "\n".join(f'      <div id="{cid}-i{i}" class="display" style="font-size:76px;"><span style="color:#c6f432;">{i + 1}</span>&nbsp; {html.escape(txt)}</div>' for i, (txt, _) in enumerate(items))
        body = f'    <div id="{cid}-wrap" class="clip" data-start="0" data-duration="{d}" style="position:absolute; left:180px; top:0; height:{H}px; display:flex; flex-direction:column; justify-content:center; gap:30px;">\n      <div class="eyebrow">Next</div>\n{lis}\n    </div>'
        js = "".join(rise(f"#{cid}-i{i}", max(0.1, wt(w) - 0.1), 30) for i, (_, w) in enumerate(items)) + out(f"#{cid}-wrap", d - 0.32)
    else:  # end card
        body = f"""    <div id="{cid}-wrap" class="clip" data-start="0" data-duration="{d}" style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:28px; text-align:center;">
      <img id="{cid}-logo" src="assets/brand.png" style="width:150px; height:150px; border-radius:34px;" alt="" />
      <div id="{cid}-name" class="display" style="font-size:150px;">Confam</div>
      <div id="{cid}-tag" class="display" style="font-size:72px; color:#c6f432;">E no land? You no pay.</div>
      <div id="{cid}-url" class="src" style="font-size:30px; color:rgba(251,248,241,0.85);">confam-qxdh.onrender.com · github.com/egbujor-emmanuel/confam</div>
    </div>"""
        js = rise(f"#{cid}-logo", 0.1, 20) + rise(f"#{cid}-name", 0.25, 30) + rise(f"#{cid}-tag", wt("E") - 0.1, 30) + rise(f"#{cid}-url", 1.2, 16)
    return scene(cid, d, "", body, js)


def phone_scene(dur: float) -> str:
    body = f"""    <div id="phone-body" class="clip" data-start="0" data-duration="{dur}" style="position:absolute; left:{SCR_X - BEZEL}px; top:{SCR_Y - BEZEL}px; width:{SCR_W + 2 * BEZEL}px; height:{SCR_H + 2 * BEZEL}px; border-radius:58px; background:#05140f; box-shadow: 0 0 0 2px rgba(198,244,50,0.25), 0 40px 90px -30px rgba(0,0,0,0.7);"></div>"""
    js = '    tl.fromTo("#phone-body", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out" }, 0);\n'
    return scene("phone", dur, "", body, js)


def captions_scene(groups: list[dict]) -> str:
    items, js = [], []
    for i, g in enumerate(groups):
        side = " cap-left" if g.get("left") else ""
        items.append(f'    <div id="cap{i}" class="clip cap{side}" data-start="{g["start"]}" data-duration="{round(g["end"] - g["start"], 3)}"><span id="cap{i}-t">{html.escape(g["text"])}</span></div>')
        js.append(f'    tl.fromTo("#cap{i}-t", {{ opacity: 0, y: 8 }}, {{ opacity: 1, y: 0, duration: 0.12, ease: "power2.out" }}, {g["start"]});')
        js.append(f'    tl.to("#cap{i}-t", {{ opacity: 0, duration: 0.1, ease: "power2.in" }}, {round(g["end"] - 0.1, 3)});')
    style = ".cap { position: absolute; left: 0; right: 0; bottom: 108px; text-align: center; overflow: visible; } .cap-left { left: 150px; right: auto; width: 930px; text-align: left; bottom: 150px; } .cap span { display: inline-block; font-family: 'Inter', sans-serif; font-weight: 700; font-size: 54px; line-height: 1.2; color: #fbf8f1; padding: 8px 22px; border-radius: 14px; background: rgba(5, 20, 15, 0.6); }"
    return scene("captions", TOTAL, style, "\n".join(items), "\n".join(js))


# ---------------------------------------------------------------- write
comp = ROOT / "compositions"
comp.mkdir(exist_ok=True)
hosts = []
for z, b in enumerate(BEATS, start=10):
    (comp / f"{b['id']}.html").write_text(footage_scene(b) if b["kind"] == "footage" else card_scene(b), encoding="utf-8")
    hosts.append(f'      <div id="{b["id"]}" data-composition-id="{b["id"]}" data-composition-src="compositions/{b["id"]}.html" data-start="{b["start"]}" data-duration="{b["dur"]}" data-track-index="1" data-track-kind="graphics" data-width="{W}" data-height="{H}" style="z-index:{z};"></div>')
groups = caption_groups()
(comp / "captions.html").write_text(captions_scene(groups), encoding="utf-8")

foot = [b for b in BEATS if b["kind"] == "footage"]
phone_start, phone_end = foot[0]["start"], foot[-1]["start"] + foot[-1]["dur"]
# The phone: one rig (body + screen mask + every footage segment). A push-in scales the whole rig and
# slides it so the focus sits mid-frame; it stays fully visible side to side (the screen is never cropped
# horizontally) and only runs past the frame's top and bottom, like a camera moving closer.
RIG_X, RIG_Y = SCR_X - BEZEL, SCR_Y - BEZEL
RIG_W, RIG_H = SCR_W + 2 * BEZEL, SCR_H + 2 * BEZEL
video_inner = "\n".join(
    f'          <video id="{v["id"]}" class="clip" src="assets/footage/{v["clip"]}.mp4" muted playsinline data-start="{v["start"]}" data-duration="{v["dur"]}" data-media-start="{v["media"]}" data-playback-rate="{v["rate"]}" data-track-index="3" style="position:absolute; left:0; top:0; width:{SCR_W}px; height:{SCR_H}px; object-fit:cover;"></video>'
    for v in videos
)
video_tags = f"""      <div id="rig" data-layout-allow-overflow style="position:absolute; left:{RIG_X}px; top:{RIG_Y}px; width:{RIG_W}px; height:{RIG_H}px; z-index:40; opacity:0;">
        <div id="phone-body" style="position:absolute; inset:0; border-radius:58px; background:#05140f; box-shadow: 0 0 0 2px rgba(198,244,50,0.25), 0 40px 90px -30px rgba(0,0,0,0.7);"></div>
        <div id="screen-mask" style="position:absolute; left:{BEZEL}px; top:{BEZEL}px; width:{SCR_W}px; height:{SCR_H}px; border-radius:44px; overflow:hidden;">
{video_inner}
        </div>
      </div>"""

MAX_PUSH = 1.4  # wider would run into the headline column
zoom_js = [
    f'      tl.set("#rig", {{ transformOrigin: "50% 50%" }}, 0);',
    f'      tl.fromTo("#rig", {{ opacity: 0, y: 60 }}, {{ opacity: 1, y: 0, duration: 0.6, ease: "power3.out" }}, {phone_start:.3f});',
    f'      tl.to("#rig", {{ opacity: 0, duration: 0.35, ease: "power2.in" }}, {phone_end - 0.35:.3f});',
]
for b in BEATS:
    if "zoom" not in b:
        continue
    fx, fy, scale, t_in, t_out = b["zoom"]
    scale = min(scale, MAX_PUSH)
    a_in = b["start"] + resolve(b, t_in)
    a_out = b["start"] + resolve(b, t_out)
    assert a_out - a_in > 1.0, (b["id"], a_in, a_out)
    focus_y = (RIG_Y + BEZEL + fy * SCR_H) - (RIG_Y + RIG_H / 2)  # focus offset from the rig centre, unscaled
    reach = RIG_H * scale / 2 - (H / 2 - (RIG_Y + RIG_H / 2)) - H / 2  # how far the scaled rig can slide and still fill the frame
    y = max(-abs(reach), min(abs(reach), -focus_y * scale + (H / 2 - (RIG_Y + RIG_H / 2))))
    zoom_js.append(f'      tl.fromTo("#rig", {{ scale: 1, y: 0 }}, {{ scale: {scale}, y: {y:.1f}, duration: 0.8, ease: "power2.inOut" }}, {a_in:.3f});')
    zoom_js.append(f'      tl.to("#rig", {{ scale: 1, y: 0, duration: 0.5, ease: "power2.inOut" }}, {a_out:.3f});')

SFX_LEN = {n: duration(ROOT / f"assets/sfx/{n}.mp3") for n in SFX_PEAK}
voice_tags = "\n".join(f'      <audio id="vo-{b["id"]}" src="assets/voice/{b["id"]}.mp3" data-start="{round(b["start"] + LEAD, 3)}" data-duration="{round(b["voice"], 3)}" data-track-index="5" data-volume="1"></audio>' for b in BEATS)
# Sound effects alternate between two Studio lanes so overlapping ticks never share a lane.
sfx_tags = "\n".join(
    f'      <audio id="fx{i}" src="assets/sfx/{s["name"]}.mp3" data-start="{s["start"]}" data-duration="{round(min(SFX_LEN[s["name"]], TOTAL - s["start"]), 3)}" data-track-index="{7 + i % 2}" data-volume="{s["volume"]}"></audio>'
    for i, s in enumerate(sounds)
)

index = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width={W}, height={H}" />
    <script src="assets/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: {W}px; height: {H}px; overflow: hidden; background: #062a20; }}
      #root {{ width: 100%; height: 100%; position: relative; }}
      #bg {{ position: absolute; inset: 0; background: radial-gradient(1100px 700px at 78% 30%, #0f5a40 0%, #0b3d2e 45%, #062a20 100%); }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="{W}" data-height="{H}">
      <div id="bg"></div>
{chr(10).join(hosts)}
{video_tags}
      <div id="captions" data-composition-id="captions" data-composition-src="compositions/captions.html" data-start="0" data-duration="{TOTAL}" data-track-index="4" data-track-kind="captions" data-width="{W}" data-height="{H}" style="z-index:60;"></div>
{voice_tags}
      <audio id="bed" src="assets/audio/bed.wav" data-start="0" data-duration="{TOTAL}" data-track-index="6" data-volume="0.14" data-fade-in="1" data-fade-out="3"></audio>
{sfx_tags}
    </div>
    <script>
      const tl = gsap.timeline({{ paused: true }});
{chr(10).join(zoom_js)}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
"""
(ROOT / "index.html").write_text(index, encoding="utf-8")
print(f"total {TOTAL:.1f}s, {len(BEATS)} beats, {len(videos)} footage segments, {len(sounds)} sounds, {len(groups)} caption groups")
for b in BEATS:
    print(f"  {b['id']} {b['start']:6.2f}s +{b['dur']:.2f}")
for v in videos:
    print(f"  {v['id']} rate {v['rate']}")
