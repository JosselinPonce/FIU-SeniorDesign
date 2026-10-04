"""Render the multi-PPG Markdown guide to PDF, without changing Luis's guide.

Install markdown-it-py and weasyprint in a virtual environment, then run:
    python docs/tools/build_multi_ppg_guide.py
"""
from pathlib import Path
import re
from markdown_it import MarkdownIt
from weasyprint import HTML

DOCS = Path(__file__).resolve().parents[1]
SOURCE = DOCS / 'MULTI_PPG_IMPLEMENTATION_GUIDE.md'
OUTPUT = DOCS / 'Team18_Multi_PPG_Implementation_Guide.pdf'
CSS = """
@page { size: Letter; margin: 19mm 16mm 18mm;
 @top-right { content: "ENGINEERING DOCUMENTATION  /  TEAM 18"; font: 7pt sans-serif; letter-spacing: 1pt; color: #53677f; }
 @bottom-left { content: "Multi-PPG Implementation · October 2026"; font: 8pt sans-serif; color: #53677f; }
 @bottom-right { content: counter(page) " / " counter(pages); font: 8pt sans-serif; color: #142d50; }
}
@page :first { @top-right { content: none; } @bottom-left { content: none; } @bottom-right { content: none; } }
body { font: 9.5pt/1.48 'DejaVu Sans', sans-serif; color: #263447; }
.cover { min-height: 240mm; break-after: page; }
.cover-banner { background: #102748; color: white; padding: 14mm 10mm; border-top: 5mm solid #335d89; margin-bottom: 9mm; }
.cover-banner .label { font-size: 9pt; letter-spacing: 2pt; color: #c7d8ed; }
.cover-banner h1 { font-size: 29pt; line-height: 1.15; margin: 8mm 0 4mm; color: white; }
.cover-banner .subtitle { color: #c7d8ed; font-size: 12pt; }
.cover .rule { height: 2mm; width: 40mm; background: #335d89; margin: 9mm 0; }
h2 { font-size: 18pt; break-before: page; border-bottom: 2pt solid #142d50; padding-bottom: 6pt; color: #102748; }
h3 { font-size: 12pt; margin-top: 17pt; break-after: avoid; color: #244d79; }
p,li { orphans: 3; widows: 3; }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 7.7pt; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #eef2f8; border-left: 3pt solid #244d79; padding: 10pt; break-inside: avoid; }
table { width: 100%; border-collapse: collapse; font-size: 7.8pt; margin: 12pt 0; table-layout: fixed; }
th,td { text-align: left; vertical-align: top; padding: 6pt; border-bottom: 1px solid #d5deea; overflow-wrap: anywhere; }
th { background: #142d50; color: white; }
tr:nth-child(even) td { background: #f2f5f9; }
tr { break-inside: avoid; } thead { display: table-header-group; }
a { color: #244d79; text-decoration: none; }
.toc h2 { break-before: auto; }.toc { break-after: page; }
.toc ol { padding-left: 5mm; }.toc li { padding: 6pt 0; border-bottom: 1px solid #d5deea; }
.toc a::after { content: leader('.') target-counter(attr(href), page); }
"""


def main():
    source = SOURCE.read_text(encoding='utf-8')
    md = MarkdownIt('commonmark', {'html': False}).enable('table')
    intro, body = source.split('## 1.', 1)
    body = '## 1.' + body
    headings = re.findall(r'^## (.+)$', body, re.M)
    toc = '<section class="toc"><h2>Contents</h2><ol>'
    for index, heading in enumerate(headings, 1):
        title = re.sub(r'^\d+\.\s*', '', heading)
        toc += f'<li><a href="#section-{index}">' + md.renderInline(title) + '</a></li>'
    toc += '</ol></section>'
    rendered = md.render(body)
    section = 0
    def anchor(match):
        nonlocal section
        section += 1
        return f'<h2 id="section-{section}">' + match[1] + '</h2>'
    rendered = re.sub(r'<h2>(.*?)</h2>', anchor, rendered)
    intro = intro.split('\n', 1)[1]
    cover = ('<section class="cover"><div class="cover-banner">'
             '<div class="label">FIU SENIOR DESIGN · TEAM 18</div>'
             '<h1>Biometric Steering Wheel<br>Multi-PPG Implementation</h1>'
             '<div class="subtitle">Architecture · Firmware · Verification · Operations</div>'
             '</div>' + md.render(intro) + '<div class="rule"></div>'
             '<p>Four optical sources. One selected data stream.<br>'
             'Standalone ESP32 operation with the existing Pi interface.</p></section>')
    page = ('<!doctype html><html lang="en"><meta charset="utf-8">'
            '<title>Team 18 — Multi-PPG Implementation Guide</title>'
            '<style>' + CSS + '</style><body>' + cover + toc + rendered + '</body></html>')
    HTML(string=page, base_url=str(DOCS)).write_pdf(OUTPUT)
    print(OUTPUT)


if __name__ == '__main__':
    main()
