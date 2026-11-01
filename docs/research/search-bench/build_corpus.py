#!/usr/bin/env python3
"""Build corpus.jsonl (~50k docs) from the Simple English Wikipedia XML dump.
Usage: python3 -I build_corpus.py data/simplewiki.xml.bz2 data/corpus.jsonl [N]
Domain/collection/content_type are SYNTHETIC (hash-assigned) so that filters can be benchmarked."""
import bz2, sys, re, json, random, hashlib, urllib.parse
import xml.etree.ElementTree as ET
src, dst = sys.argv[1], sys.argv[2]
MINLEN = int(__import__('os').environ.get('MINLEN', 2000))
N = int(sys.argv[3]) if len(sys.argv) > 3 else 50000
DOMAINS = ["simple.wikipedia.org"]*8 + [f"site{i}.example.org" for i in range(1, 17)]  # skewed: 8/24 = 33% on one domain
COLL = ["reading-list", "research", "science", "history", "geography", "misc"]
CT = ["article"]*8 + ["reference"]*2
def strip_templates(s):
    out, depth, i = [], 0, 0
    while i < len(s):
        if s.startswith("{{", i): depth += 1; i += 2
        elif s.startswith("}}", i) and depth: depth -= 1; i += 2
        else:
            if depth == 0: out.append(s[i])
            i += 1
    return "".join(out)
def clean(text):
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"<ref[^>/]*/>|<ref[^>]*>.*?</ref>", "", text, flags=re.S)
    text = strip_templates(text)
    text = re.sub(r"\{\|.*?\|\}", "", text, flags=re.S)
    text = re.sub(r"\[\[(?:File|Image|Category|Media):[^\]]*(?:\[\[[^\]]*\]\][^\]]*)*\]\]", "", text, flags=re.I)
    text = re.sub(r"\[\[([^\]|]*)\|([^\]]*)\]\]", r"\2", text)
    text = re.sub(r"\[\[([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[https?://\S+ ([^\]]*)\]|\[https?://\S+\]", r"\1", text)
    text = re.sub(r"'{2,}", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    return text
docs, seen = [], 0
random.seed(42)
with bz2.open(src, "rb") as f:
    for ev, el in ET.iterparse(f):
        if not el.tag.endswith("}page"): continue
        ns = el.find("{*}ns"); title = el.findtext("{*}title")
        rev = el.find("{*}revision"); txt = rev.findtext("{*}text") if rev is not None else None
        ts = rev.findtext("{*}timestamp") if rev is not None else None
        el.clear()
        if ns is None or ns.text != "0" or not txt or txt.lstrip().lower().startswith("#redirect"): continue
        if "disambig" in txt.lower()[:3000]: continue
        heads, body_lines = [], []
        for line in clean(txt).splitlines():
            m = re.match(r"^(={2,6})\s*(.*?)\s*\1\s*$", line)
            if m:
                if m.group(2).lower() not in ("references", "other websites", "related pages", "notes", "sources", "external links"): heads.append(m.group(2))
                continue
            line = line.strip()
            if not line or line[0] in "*#:;|!}{" or line.startswith("__"): continue
            body_lines.append(line)
        body = "\n".join(body_lines)
        if len(body) < MINLEN: continue
        if len(body) > 5000:
            cut = body.rfind("\n", 0, 5000); body = body[:cut if cut > MINLEN else 5000]
        docs.append({"title": title, "headings": heads, "body": body, "ts": ts})
        seen += 1
random.shuffle(docs)
docs = docs[:N]
with open(dst, "w") as out:
    for i, d in enumerate(docs):
        h = int(hashlib.md5(d["title"].encode()).hexdigest(), 16)
        dom = DOMAINS[h % len(DOMAINS)]
        d.update(id=i, domain=dom, url=f"https://{dom}/wiki/{urllib.parse.quote(d['title'].replace(' ', '_'))}",
                 collection=COLL[(h >> 8) % len(COLL)], content_type=CT[(h >> 16) % len(CT)], language="en",
                 date=int(__import__('datetime').datetime.fromisoformat(d["ts"].replace("Z", "+00:00")).timestamp()))
        del d["ts"]
        out.write(json.dumps(d, ensure_ascii=False) + "\n")
print("eligible", seen, "written", len(docs))
