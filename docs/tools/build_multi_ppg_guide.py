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
CSS = '''
@page { size: Letter; margin: 19mm 16mm 18mm;
 @bottom-left { content: "Team 18 · Multi-PPG Implementation Guide"; font: 8pt sans-serif; color: #586b69; }
 @bottom-right { content: counter(page) " / " counter(pages); font: 8pt sans-serif; color: #586b69; }
}
@page :first { @bottom-left { content: none; } @bottom-right { content: none; } }
body { font: 10pt/1.45 'DejaVu Sans', sans-serif; color: #142b28; }
h1 { font-size: 30pt; line-height: 1.15; color: #0f766e; }
h2 { font-size: 19pt; break-before: page; border-bottom: 2pt solid #0f766e; padding-bottom: 5pt; }
h3 { font-size: 12pt; margin-top: 18pt; break-after: avoid; color: #0f766e; }
p,li { orphans: 3; widows: 3; }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 8pt; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #eff5f3; border: 1px solid #d5e0dd; padding: 10pt; break-inside: avoid; }
table { width: 100%; border-collapse: collapse; font-size: 8pt; margin: 12pt 0; table-layout: fixed; }
th,td { text-align: left; vertical-align: top; padding: 6pt; border-bottom: 1px solid #d5e0dd; overflow-wrap: anywhere; }
th { background: #e3f0ec; }
tr { break-inside: avoid; } thead { display: table-header-group; }
a { color: #0f766e; text-decoration: none; }
.toc { break-before: page; }.toc h2 { break-before: auto; }
.toc li { padding: 4pt 0; }
'''


def main():
    source = SOURCE.read_text(encoding='utf-8')
    md = MarkdownIt('commonmark', {'html': False}).enable('table')
    intro, body = source.split('## 1.', 1)
    body = '## 1.' + body
    headings = re.findall(r'^## (.+)$', body, re.M)
    toc = '<section class="toc"><h2>Contents</h2><ol>'
    for heading in headings:
        title = re.sub(r'^\d+\.\s*', '', heading)
        toc += '<li>' + md.renderInline(title) + '</li>'
    toc += '</ol></section>'
    page = ('<!doctype html><html lang="en"><meta charset="utf-8">'
            '<title>Team 18 — Multi-PPG Implementation Guide</title>'
            '<style>' + CSS + '</style><body>' + md.render(intro) + toc +
            md.render(body) + '</body></html>')
    HTML(string=page, base_url=str(DOCS)).write_pdf(OUTPUT)
    print(OUTPUT)


if __name__ == '__main__':
    main()
