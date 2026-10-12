#!/usr/bin/env python3
"""Pre-translate a Spanish EPUB for Lector, sentence by sentence, on this Mac.

usage: translate_book.py <book.epub> [--model qwen3.8:27b-mlx]

1. Opens the book with Lector's OWN parser and sentence splitter, in headless Chrome,
   so every sentence is keyed exactly as the app will look it up.
2. Translates paragraph by paragraph (sentences numbered, so the model sees context but
   answers one line per sentence) through the local Ollama model. No network, no API key.
3. Writes the translations INTO the EPUB as lector/translations.json, in place. The file is
   still a normal EPUB; Lector reads the extra file, every other reader ignores it.

Progress is cached in ~/lector-build/cache/, so an interrupted run resumes where it stopped.
"""
import hashlib, http.server, json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OLLAMA = "http://127.0.0.1:11434/api/chat"
BATCH = 8

def dump_sentences(epub):
    """Run index.html's parseEpub + splitSentences over the book; return [[sentence,...], ...] per paragraph."""
    tmp = tempfile.mkdtemp(prefix="lector-dump-")
    shutil.copy(os.path.join(HERE, "jszip.min.js"), tmp)
    shutil.copy(epub, os.path.join(tmp, "book.epub"))
    page = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
    harness = """<script>(async()=>{let out;try{const b=await parseEpub(await (await fetch('book.epub')).arrayBuffer());
      out=JSON.stringify({title:b.title,paras:b.chapters.flatMap(c=>c.paras.map(p=>splitSentences(p.replace(/^\\u0001/,'')).map(x=>sentKey(x.s))))})}
      catch(e){out=JSON.stringify({error:String(e.stack||e)})}await fetch('/r',{method:'POST',body:out})})()</script></body>"""
    page = page.replace("renderLibrary();\n</script>", "</script>").replace("</body>", harness)
    open(os.path.join(tmp, "index.html"), "w", encoding="utf-8").write(page)
    result = {}
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(s, *a, **k): super().__init__(*a, directory=tmp, **k)
        def do_POST(s):
            result["body"] = s.rfile.read(int(s.headers["Content-Length"])); s.send_response(200); s.end_headers()
        def log_message(s, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    ch = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", f"--user-data-dir={tmp}/prof",
                           f"http://127.0.0.1:{srv.server_address[1]}/index.html"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(120):
        if "body" in result: break
        time.sleep(1)
    ch.kill(); srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)
    if "body" not in result: sys.exit("headless Chrome never reported back")
    data = json.loads(result["body"])
    if "error" in data: sys.exit("parse failed: " + data["error"])
    return data["title"], [p for p in data["paras"] if p]

def ask(model, title, sents):
    prompt = (f"You are translating the Spanish text of the book \"{title}\" into English for a learner who reads it alongside the Spanish.\n"
              "Translate each numbered sentence into natural, faithful English. Keep names as they are. "
              "Reply with ONLY a JSON object {\"en\": [...]} holding exactly one English string per numbered sentence, in order.\n\n"
              + "\n".join(f"{i+1}. {s}" for i, s in enumerate(sents)))
    body = {"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False, "think": False,
            "format": "json", "options": {"temperature": 0.2}}
    req = urllib.request.Request(OLLAMA, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    out = json.loads(json.load(urllib.request.urlopen(req, timeout=900))["message"]["content"])
    en = out.get("en") if isinstance(out, dict) else out
    return en if isinstance(en, list) and len(en) == len(sents) and all(isinstance(x, str) and x.strip() for x in en) else None

def main():
    args = sys.argv[1:]
    model = args[args.index("--model") + 1] if "--model" in args else "qwen3.8:27b-mlx"
    epub = [a for a in args if a.endswith(".epub")][0]
    title, paras = dump_sentences(epub)
    total = sum(len(p) for p in paras)
    cache_dir = os.path.expanduser("~/lector-build/cache"); os.makedirs(cache_dir, exist_ok=True)
    key = hashlib.sha1(json.dumps(paras, ensure_ascii=False).encode()).hexdigest()[:12]
    cache_path = os.path.join(cache_dir, key + ".json")
    tr = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    print(f"{title}: {len(paras)} paragraphs, {total} sentences, {len(tr)} already done", flush=True)
    t0, done = time.time(), 0
    for p in paras:
        todo = [s for s in dict.fromkeys(p) if s not in tr]
        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            en = None
            for _ in range(2):
                try: en = ask(model, title, chunk)
                except Exception as e: print("  retry:", e, flush=True)
                if en: break
            if not en:  # fall back to one sentence at a time
                en = []
                for s in chunk:
                    one = None
                    try: one = ask(model, title, [s])
                    except Exception as e: print("  skip:", e, flush=True)
                    en.append(one[0] if one else None)
            for s, e in zip(chunk, en):
                if e: tr[s] = e.strip()
            done += len(chunk)
            json.dump(tr, open(cache_path, "w"), ensure_ascii=False)
            rate = done / max(1, time.time() - t0)
            print(f"  {len(tr)}/{total}  ~{int((total - len(tr)) / max(rate, 0.01) / 60)} min left", flush=True)
    # write translations into the EPUB, in place (mimetype stays first and stored)
    tmp = epub + ".tmp"
    with zipfile.ZipFile(epub) as zin, zipfile.ZipFile(tmp, "w") as zout:
        for it in zin.infolist():
            if it.filename == "lector/translations.json": continue
            zout.writestr(it, zin.read(it.filename), compress_type=zipfile.ZIP_STORED if it.filename == "mimetype" else zipfile.ZIP_DEFLATED)
        zout.writestr("lector/translations.json", json.dumps({"v": 1, "model": model, "made": time.strftime("%Y-%m-%d"), "map": tr},
                      ensure_ascii=False), compress_type=zipfile.ZIP_DEFLATED)
    os.replace(tmp, epub)
    print(f"DONE {len(tr)}/{total} sentences written into {os.path.basename(epub)}", flush=True)

if __name__ == "__main__":
    main()
