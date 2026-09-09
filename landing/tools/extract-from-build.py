#!/usr/bin/env python3
"""
Generates the static landing pages from the Angular frontend's prerendered
/ro/verificare-proprietate page, so the HTML and the component CSS are the
real ones, not a port.

    python3 tools/extract-from-build.py [path/to/frontend/dist/frontend/browser/ro]

Outputs (next to this script's parent):
    index.html            the landing, Angular runtime stripped, buttons wired
    cerere.html           the lead form, same header + styles
    multumim.html         thank-you page
    raport.html           the customer's report page (id + token in the URL fragment, links from the API)
    confidentialitate.html privacy policy
    styles.css            the global stylesheet from the build
"""
import re
import sys
from pathlib import Path

LANDING = Path(__file__).resolve().parent.parent
DEFAULT_BUILD = LANDING.parent.parent / 'frontend' / 'dist' / 'frontend' / 'browser' / 'ro'
build = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_BUILD
page_path = build / 'verificare-proprietate' / 'index.html'
html = page_path.read_text(encoding='utf-8')

CONSENT_SCRIPT = """<script>
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('consent', 'default', {ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied', wait_for_update: 500});
</script>"""

COOKIE_BANNER = """<div class="dd-cookie" id="cookie" hidden>
<div class="dd-cookie-inner">
<span class="dd-cookie-text">Folosim cookie-uri de măsurare ca să vedem dacă reclamele noastre ajung la oamenii potriviți. Nu le folosim pentru altceva.</span>
<div class="dd-cookie-actions">
<button type="button" class="dd-btn dd-btn-primary" id="cookie-accept">Accept</button>
<button type="button" class="dd-btn dd-btn-secondary" id="cookie-reject">Doar cele necesare</button>
</div>
</div>
</div>"""

WITH_CADASTRAL_STEPS = [
    ('Mergi la ', 'https://epay.ancpi.ro/epay/SelectProd.action?prodId=1420'),
    ('Apasă pe "Adaugă în coș"', None),
    ('Apasă pe "Cumpără" în secțiunea din dreapta sus', None),
    ('Apasă pe "Configurează"', None),
    ('Introdu numărul cadastral', 'SUB'),
    ('Apasă pe butonul "Cumpără"', None),
]
CADASTRAL_SUB = [
    'Numărul cadastral al apartamentului are formatul XXXXXX-CX-UXX (XXXXXX-CX este numărul copiat la pasul 1)',
    'Unde U este numărul unității (de obicei numărul apartamentului, dar poate diferi)',
    'Numărul cadastral poate fi găsit în contractul de vânzare-cumpărare sau la OCPI',
]


def strip_runtime(fragment: str) -> str:
    fragment = re.sub(r'<!--container-->', '', fragment)
    fragment = re.sub(r'<!---->', '', fragment)
    fragment = re.sub(r'\s(ngh|ng-version|ng-server-context|jsaction|appfasttap|apptooltip|ngsrc|ng-img)="[^"]*"', '', fragment)
    fragment = re.sub(r'\s(appfasttap|apptooltip|fill)=""', '', fragment)
    return fragment


def wire_button(fragment: str, label: str, attr: str) -> str:
    """Adds an attribute to the <button> whose label span carries `label`."""
    label_pos = fragment.find('>' + label + '<')
    if label_pos < 0:
        raise SystemExit(f'label not found: {label}')
    button_pos = fragment.rfind('<button', 0, label_pos)
    if button_pos < 0:
        raise SystemExit(f'no <button before label: {label}')
    return fragment[:button_pos] + '<button ' + attr + fragment[button_pos + len('<button'):]


# ---- head ----
head_end = html.index('<body')
head = html[:head_end]
styles = re.findall(r'<style[^>]*>.*?</style>', head, flags=re.S)
head_no_styles = re.sub(r'<style[^>]*>.*?</style>', '', head, flags=re.S)
head_no_styles = re.sub(r'<base href="[^"]*">', '', head_no_styles)
# Accessibility: let users pinch-zoom. Drop maximum-scale and user-scalable=no.
head_no_styles = re.sub(r'<meta name="viewport"[^>]*>', '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">', head_no_styles)
head_no_styles = re.sub(r'<script>\s*/\* Pre-paint.*?</script>', '', head_no_styles, flags=re.S)
head_no_styles = re.sub(r'<link rel="alternate"[^>]*>', '', head_no_styles)
# The experiment lives on its own domain, at the root.
head_no_styles = head_no_styles.replace('https://knoha.ro/ro/verificare-proprietate', 'https://raportcf.ro/').replace('https://knoha.ro', 'https://raportcf.ro')
head_no_styles = re.sub(r'<link rel="modulepreload"[^>]*>', '', head_no_styles)
# page icon: the round brand mark instead of the site favicon
head_no_styles = re.sub(r'<link rel="icon"[^>]*>',
                        '<link rel="icon" type="image/svg+xml" href="favicon.svg"><link rel="apple-touch-icon" href="apple-touch-icon.png">',
                        head_no_styles)
head_no_styles = re.sub(r'<link[^>]*rel="preload"[^>]*as="image"[^>]*>', lambda m: strip_runtime(m.group(0)), head_no_styles)
head_no_styles = head_no_styles.replace('<link rel="stylesheet" href="styles.css">',
                                        '<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="landing.css">' + CONSENT_SCRIPT)
head_no_styles = head_no_styles.replace('</head>', '')
# Keep the site's meta, then the component styles.
landing_head = head_no_styles + ''.join(styles) + '</head>'

# ---- body ----
body = html[head_end:]
body = re.sub(r'<script id="ng-state"[^>]*>.*?</script>', '', body, flags=re.S)
body = re.sub(r'<script[^>]*id="ng-event-dispatch-contract"[^>]*>.*?</script>', '', body, flags=re.S)
body = re.sub(r'<script src="(polyfills|main)\.js"[^>]*></script>', '', body)
body = re.sub(r'<link rel="modulepreload"[^>]*>', '', body)
body = re.sub(r'<script>\s*window\.__jsaction_bootstrap.*?</script>', '', body, flags=re.S)
body = re.sub(r'<script>(?:(?!</script>).)*?</script>', lambda m: '' if 'jsaction' in m.group(0) or 'ngh' in m.group(0) else m.group(0), body, flags=re.S)
body = strip_runtime(body)

# header: the site header (logo, menu, login) is replaced by a minimal bar with a round brand mark.
BRAND_HEADER = ('<div class="dd-header"><a class="dd-brand" href="./" data-action="home" aria-label="Înapoi la pagina raportului">'
                '<span class="dd-brand-mark">R</span></a></div>')
header_container = re.search(r'(<div[^>]*class="header-container">)<app-header.*?</app-header>(</div>)', body, flags=re.S)
if header_container is None:
    raise SystemExit('site header not found')
header_block = header_container.group(1) + BRAND_HEADER + header_container.group(2)
body = body[:header_container.start()] + header_block + body[header_container.end():]

# hero + guide + example buttons
body = wire_button(body, 'Obține raportul', 'data-action="request"')
body = wire_button(body, 'Vezi un raport exemplu', 'data-action="example"')
body = wire_button(body, 'Cumpără serviciul CF', 'data-action="request"')
body = wire_button(body, 'Descarcă raportul exemplu', 'data-action="example"')

# anchor for the "Cum obții CF-ul?" link on the form page
body = re.sub(r'<app-due-diligence-guide( |>)', r'<app-due-diligence-guide id="ghid-cf"\1', body, count=1)

# hero variant hooks
body = re.sub(r'(<h1[^>]*class="title-text")', r'\1 data-variant-h1', body, count=1)
body = re.sub(r'(<h2[^>]*class="small-text")', r'\1 data-variant-sub', body, count=1)

# guide: tag the two segmented controls, add the "with cadastral number" list
segments = list(re.finditer(r'<div([^>]*)class="item-container user-select-none item-container-small( item-container-selected)?"', body))
if len(segments) != 2:
    raise SystemExit(f'expected 2 segmented controls, found {len(segments)}')
for match, key in reversed(list(zip(segments, ['without', 'with']))):
    body = body[:match.start()] + f'<div data-guide="{key}"' + body[match.start() + len('<div'):]

guide_start = body.index('<app-due-diligence-guide-left')
guide_end = body.index('</app-due-diligence-guide-left>', guide_start)
guide_html = body[guide_start:guide_end]
list_match = re.search(r'<div( _ngcontent-ng-c\d+="") class="list">.*$', guide_html, flags=re.S)
if list_match is None:
    raise SystemExit('guide list not found')
ng = list_match.group(1)
first_list = list_match.group(0)
items = []
for text, link in WITH_CADASTRAL_STEPS:
    if link == 'SUB':
        subs = ''.join(f'<li{ng}>{sub}</li>' for sub in CADASTRAL_SUB)
        items.append(f'<li{ng}>{text} <ul{ng}>{subs}</ul></li>')
    elif link is not None:
        items.append(f'<li{ng}>{text}<a{ng} target="_blank" style="text-decoration: none; color: inherit;" href="{link}">{link}</a></li>')
    else:
        items.append(f'<li{ng}>{text}</li>')
second_list = (f'<div{ng} class="list" data-guide-list="with" hidden><div{ng} class="list-item">'
               f'<span{ng} class="list-text"> Pașii pentru a o obține singur:</span>'
               f'<ol{ng} class="list-text-steps">{"".join(items)}</ol></div></div>')
# first_list ends with the list's own closing tags plus the guide-left's wrapper </div>
if not first_list.endswith('</div></div></div>'):
    raise SystemExit('unexpected guide list tail')
replacement = first_list.replace(f'<div{ng} class="list">', f'<div{ng} class="list" data-guide-list="without">', 1)
replacement = replacement[:-len('</div>')] + second_list + '</div>'
body = body[:guide_start + list_match.start()] + replacement + body[guide_end:]

# cookie banner + script

FOOTER = """<footer class="dd-footer">
<div class="footer-container">
<div class="top-container">
<div class="about-container">
<div class="footer-text-logo"><span class="dd-brand-mark dd-brand-mark-sm">R</span><span class="footer-wordmark">raportcf.ro</span></div>
<span class="about-text color-strong">Verifică proprietatea înainte să cumperi.</span>
<span class="about-text color-weak">Un raport clar despre acte, sarcini și riscuri, rapid și fără drumuri. În perioada de test, gratuit.</span>
</div>
<div class="links-container">
<div class="topic-column">
<span class="topic-title-text color-strong">Raport</span>
<div class="topic-column-list">
<a class="about-text color-weak" href="/">Acasă</a>
<a class="about-text color-weak" href="cerere.html">Cere raportul</a>
<a class="about-text color-weak" href="mailto:office@knoha.eu">Contact</a>
</div>
</div>
<div class="topic-column">
<span class="topic-title-text color-strong">Legal</span>
<div class="topic-column-list">
<a class="about-text color-weak" href="termeni.html">Termeni și condiții</a>
<a class="about-text color-weak" href="confidentialitate.html">Politica de confidențialitate</a>
<a class="about-text color-weak" href="nota-ai.html">Informare AI</a>
</div>
</div>
</div>
</div>
<div class="bottom-container">
<span class="reserve-logo">© 2026 raportcf.ro · HYCAD SOFTWARE SRL · Cluj-Napoca · CIF 42122453 · J21/149/2020</span>
</div>
</div>
</footer>"""

# Footer only on the landing (the secondary pages carry their own in-card legal nav).
if '</main>' in body:
    body = body.replace('</main>', '</main>' + FOOTER, 1)
body = body.replace('</body>', COOKIE_BANNER + '<script src="app.js" defer></script></body>')
body = re.sub(r'\n\s*\n', '\n', body)

(LANDING / 'index.html').write_text(landing_head + body, encoding='utf-8')
(LANDING / 'styles.css').write_text((build / 'styles.css').read_text(encoding='utf-8'), encoding='utf-8')

# ---- secondary pages: same head (site meta replaced), same header, template body ----
page_open = ''.join(re.search(p, body).group(0) for p in [r'<app-root[^>]*>', r'<app-global-container[^>]*>', r'<app-generic-page[^>]*>'])
page_div_open = re.search(r'<div[^>]*class="page page-header"', body).group(0) + '>'
page_close = '</div></app-generic-page></app-global-container></app-root>'

# Only the style blocks the secondary pages use: page shell, header, menu, buttons.
needed_ids = set()
for pattern in [r'<app-root[^>]*_nghost-ng-c(\d+)', r'<app-global-container[^>]*_nghost-ng-c(\d+)', r'<app-generic-page[^>]*_nghost-ng-c(\d+)',
                r'<app-button[^>]*_nghost-ng-c(\d+)', r'<app-segmented-controls[^>]*_nghost-ng-c(\d+)', r'<app-segmented-control[^>]*_nghost-ng-c(\d+)',
                r'<app-button-content[^>]*_nghost-ng-c(\d+)', r'<app-button-label[^>]*_nghost-ng-c(\d+)']:
    for m in re.finditer(pattern, body):
        needed_ids.add(m.group(1))
secondary_styles = ''.join(s for s in styles if any(f'ng-c{i}' in s for i in needed_ids))

# Button markup templates captured from the hero, so the form buttons are the real app-button.
primary_button = re.search(r'<app-button[^>]*>\s*<button[^>]*button-primary-brand.*?</app-button>', body, flags=re.S).group(0)
secondary_button = re.search(r'<app-button[^>]*>\s*<button[^>]*button-secondary-brand.*?</app-button>', body, flags=re.S).group(0)


def button_markup(kind: str, button_id: str, label: str, button_type: str, size: str = 'medium', icon: str = '') -> str:
    template = primary_button if kind == 'primary' else secondary_button
    template = re.sub(r'<button data-action="[^"]*"', '<button', template)
    template = template.replace('<button', f'<button type="{button_type}" id="{button_id}"', 1)
    if size == 'small':
        template = template.replace('button-size-medium', 'button-size-small').replace('button-content-medium', 'button-content-small').replace('button-label-medium', 'button-label-small')
    else:
        template = template.replace('class="button button-radius', 'class="button button-full-width button-radius', 1)
        template = template.replace('class="content"', 'class="button-full-width content"', 1)
        template = template.replace('content display-flex-center"', 'content button-full-width display-flex-center"', 1)
    if icon:
        template = re.sub(r'(<app-button-label)', f'<img alt="" width="24" height="24" class="dd-btn-icon" src="https://static.knoha.eu/static/svg/{icon}">\\1', template, count=1)
    return re.sub(r'>(Obține raportul|Vezi un raport exemplu)<', f'>{label}<', template, count=1)


# The PDF / photo toggle of the form reuses the guide's segmented control markup.
segmented_template = re.search(r'<app-segmented-controls[^>]*>.*?</app-segmented-controls>', body, flags=re.S).group(0)


def segmented_markup(group: str, first: str, second: str) -> str:
    markup = segmented_template.replace('data-guide="without"', f'data-seg-group="{group}" data-seg="pdf"')
    markup = markup.replace('data-guide="with"', f'data-seg-group="{group}" data-seg="photo"')
    markup = markup.replace('>Nu știu numărul cadastral<', f'>{first}<').replace('>Știu numărul cadastral<', f'>{second}<')
    return markup


def expand_buttons(content: str) -> str:
    content = re.sub(r'\{\{BTN:(primary|secondary):([a-zA-Z-]+):(submit|button):([^:}]+)(?::(small|medium))?(?::([a-z_.-]+\.svg))?\}\}',
                     lambda m: button_markup(m.group(1), m.group(2), m.group(4), m.group(3), m.group(5) or 'medium', m.group(6) or ''), content)
    return re.sub(r'\{\{SEG:([a-zA-Z]+):([^:}]+):([^}]+)\}\}',
                  lambda m: segmented_markup(m.group(1), m.group(2), m.group(3)), content)


def secondary_head(title: str, description: str) -> str:
    h = head_no_styles
    h = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', h)
    h = re.sub(r'<meta name="robots"[^>]*>', '<meta name="robots" content="noindex,follow">', h)
    h = re.sub(r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{description}">', h)
    h = re.sub(r'<meta property="og:[^"]*" content="[^"]*">', '', h)
    h = re.sub(r'<meta name="twitter:[^"]*" content="[^"]*">', '', h)
    h = re.sub(r'<link rel="canonical"[^>]*>', '', h)
    h = re.sub(r'<script type="application/ld\+json">.*?</script>', '', h, flags=re.S)
    h = re.sub(r'<link[^>]*rel="preload"[^>]*as="image"[^>]*>', '', h)
    return h + secondary_styles + '</head>'


def secondary_page(title: str, description: str, template: str, body_attr: str = '') -> str:
    content = expand_buttons((LANDING / 'src' / template).read_text(encoding='utf-8'))
    return (secondary_head(title, description) + f'<body{body_attr}>' + page_open + header_block
            + page_div_open + content + page_close
            + COOKIE_BANNER + '<script src="app.js" defer></script></body></html>')


(LANDING / 'cerere.html').write_text(secondary_page(
    'Cere raportul de verificare | raportcf.ro',
    'Spune-ne ce proprietate te interesează și îți trimitem raportul de verificare pe email. Gratuit în perioada de test.',
    'cerere.body.html'), encoding='utf-8')
(LANDING / 'multumim.html').write_text(secondary_page(
    'Cerere primită | raportcf.ro', 'Am primit cererea ta.', 'multumim.body.html', ' data-page="thanks"'), encoding='utf-8')
(LANDING / 'raport.html').write_text(secondary_page(
    'Raportul tău | raportcf.ro', 'Raportul tău de verificare a proprietății.', 'raport.body.html', ' data-page="report"'), encoding='utf-8')
(LANDING / 'confidentialitate.html').write_text(secondary_page(
    'Politica de confidențialitate | raportcf.ro', 'Cum prelucrăm datele trimise prin formularul de verificare a proprietății.',
    'confidentialitate.body.html'), encoding='utf-8')
(LANDING / 'termeni.html').write_text(secondary_page(
    'Termeni și Condiții | raportcf.ro', 'Termenii și condițiile serviciului de verificare a proprietății.',
    'termeni.body.html'), encoding='utf-8')
(LANDING / 'nota-ai.html').write_text(secondary_page(
    'Notă privind Inteligența Artificială | raportcf.ro', 'Informare și consimțământ privind utilizarea sistemelor de inteligență artificială.',
    'nota-ai.body.html'), encoding='utf-8')

print(f'index.html {len(landing_head) + len(body)} bytes, {len(styles)} style blocks, {len(needed_ids)} reused on secondary pages')
