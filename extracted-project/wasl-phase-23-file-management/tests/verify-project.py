#!/usr/bin/env python3
"""Dependency-free static verification for the Wasl demo project."""
from html.parser import HTMLParser
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "website" / "index.html"
JS = ROOT / "website" / "app.js"
CSS = ROOT / "website" / "styles.css"

class IdParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])

errors = []
for path in (HTML, JS, CSS):
    if not path.is_file() or path.stat().st_size == 0:
        errors.append(f"Missing or empty required file: {path.relative_to(ROOT)}")

if not errors:
    parser = IdParser()
    parser.feed(HTML.read_text(encoding="utf-8"))
    duplicates = sorted({item for item in parser.ids if parser.ids.count(item) > 1})
    if duplicates:
        errors.append("Duplicate HTML IDs: " + ", ".join(duplicates))
    js = JS.read_text(encoding="utf-8")
    refs = set(re.findall(r"\$\(['\"]([^'\"]+)['\"]\)", js))
    missing = sorted(refs - set(parser.ids))
    if missing:
        errors.append("JavaScript references missing HTML IDs: " + ", ".join(missing))
    css = CSS.read_text(encoding="utf-8")
    if css.count("{") != css.count("}"):
        errors.append("CSS braces are unbalanced")
    result = subprocess.run(["node", "--check", str(JS)], capture_output=True, text=True)
    if result.returncode:
        errors.append("JavaScript syntax check failed: " + result.stderr.strip())

if errors:
    print("FAIL")
    for error in errors:
        print("- " + error)
    sys.exit(1)

print("PASS: required files exist and are non-empty")
print("PASS: no duplicate HTML IDs")
print("PASS: all JavaScript DOM ID references exist in HTML")
print("PASS: CSS braces are balanced")
print("PASS: Node.js JavaScript syntax check")
print("NOTE: these are static checks; they do not prove backend or cross-device messaging works")
