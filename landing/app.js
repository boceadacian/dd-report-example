(function () {
    'use strict';

    // ---- Configuration: fill these in before the campaign goes live ----
    // On localhost the API is the local compose stack (API_PORT, default 18081), whatever serves the
    // page: Caddy from the compose, IntelliJ's built-in server, `npx serve`. Override once with
    // ?api=http://localhost:PORT, which is remembered in localStorage.
    var LOCAL_API_BASE = 'http://localhost:18081';
    var API_BASE = resolveApiBase();

    function resolveApiBase() {
        var local = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        if (!local) {
            return 'https://api.raportcf.ro';
        }
        var override = new URLSearchParams(window.location.search).get('api');
        if (override != null && /^https?:\/\//.test(override)) {
            try {
                localStorage.setItem('dd_api_base', override);
            } catch (e) {
                // storage blocked
            }
            return override.replace(/\/$/, '');
        }
        try {
            var stored = localStorage.getItem('dd_api_base');
            if (stored != null) {
                return stored.replace(/\/$/, '');
            }
        } catch (e) {
            // storage blocked
        }
        return LOCAL_API_BASE;
    }
    // Google Tag Manager container. Every ad tag (Google Ads conversion + linker, Meta pixel, GA4 if
    // wanted) is configured inside the container; this script only pushes events to the dataLayer.
    // The tag names and the events they listen to are documented in ANALYSIS/google-ads/tracking-setup.md.
    var GTM_ID = 'GTM-T66H6C4R';       // tagmanager.google.com, account Knoha, container raportcf.ro
    // Microsoft Clarity stays loaded directly: it was live before the container existed and its
    // custom tags (variant, lead id) are set from here.
    var CLARITY_ID = 'yfm5ue7y4a';     // e.g. 'abcd1234ef' (Microsoft Clarity project id)

    var ATTR_KEY = 'dd_attr';
    var CONSENT_KEY = 'dd_consent';
    var LEAD_KEY = 'dd_lead';
    var PENDING_KEY = 'dd_pending';       // events and tags fired before the consent choice, flushed on accept
    var PENDING_LIMIT = 50;

    // Hero copy is the approved text in the HTML; the A/B swap was disabled on 2026-09-10. The id is
    // still recorded on leads and in Clarity so existing reports keep their column.
    var LANDING_VARIANT = 'a';

    function readStore(store, key) {
        try {
            var raw = store.getItem(key);
            if (raw == null) {
                return null;
            }
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    function writeStore(store, key, value) {
        try {
            store.setItem(key, JSON.stringify(value));
        } catch (e) {
            // storage blocked, nothing to do
        }
    }

    function readCookie(name) {
        var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        if (match == null) {
            return undefined;
        }
        return decodeURIComponent(match[1]);
    }

    // ---- Attribution: first touch wins, kept for the session ----
    function captureAttribution() {
        var existing = readStore(sessionStorage, ATTR_KEY) || {};
        var params = new URLSearchParams(window.location.search);
        var map = {
            utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign',
            utm_content: 'utmContent', utm_term: 'utmTerm', gclid: 'gclid', fbclid: 'fbclid'
        };
        var changed = false;
        Object.keys(map).forEach(function (param) {
            var value = params.get(param);
            if (value != null && value !== '' && existing[map[param]] == null) {
                existing[map[param]] = value;
                changed = true;
            }
        });
        if (existing.landingUrl == null) {
            existing.landingUrl = window.location.href.slice(0, 500);
            existing.referrer = document.referrer.slice(0, 500);
            changed = true;
        }
        if (changed) {
            writeStore(sessionStorage, ATTR_KEY, existing);
        }
        return existing;
    }

    function currentAttribution() {
        var attribution = readStore(sessionStorage, ATTR_KEY) || {};
        var fbp = readCookie('_fbp');
        var fbc = readCookie('_fbc');
        if (fbp != null) {
            attribution.fbp = fbp;
        }
        if (fbc != null) {
            attribution.fbc = fbc;
        } else if (attribution.fbclid != null) {
            attribution.fbc = 'fb.1.' + Date.now() + '.' + attribution.fbclid;
        }
        attribution.landingVariant = pickVariant();
        return attribution;
    }

    function pickVariant() {
        return LANDING_VARIANT;
    }

    // ---- Consent + tags ----
    function loadScript(src) {
        var script = document.createElement('script');
        script.async = true;
        script.src = src;
        document.head.appendChild(script);
    }

    function enableTags() {
        if (window.__ddTagsLoaded) {
            return;
        }
        window.__ddTagsLoaded = true;
        // The consent default (all denied) is inline in every page's <head>; this update is pushed to the
        // dataLayer before the container loads, so the Google tags inside it start in the granted state.
        gtag('consent', 'update', {
            ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted', analytics_storage: 'granted'
        });
        if (GTM_ID !== '') {
            // The standard GTM snippet, minus the inline function: the container is loaded only after the
            // visitor accepted, so there is no <noscript> iframe either (it would bypass the banner).
            window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
            loadScript('https://www.googletagmanager.com/gtm.js?id=' + GTM_ID);
        }
        if (CLARITY_ID !== '' && window.clarity == null) {
            window.clarity = function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
            loadScript('https://www.clarity.ms/tag/' + CLARITY_ID);
            window.clarity('consent');
            window.clarity('set', 'variant', pickVariant());
        }
        flushPending();
    }

    // Maps a blocking message to a short reason code, for the submit_blocked event.
    function issueCode(msg) {
        if (msg === MSG.email) { return 'email'; }
        if (msg === MSG.phone) { return 'phone'; }
        if (msg === MSG.cadastralMissing) { return 'cadastral_missing'; }
        if (msg === MSG.cadastralInvalid) { return 'cadastral_invalid'; }
        if (msg === MSG.cfFile || msg === MSG.cfPhotos) { return 'cf_missing'; }
        if (msg === MSG.terms) { return 'terms'; }
        if (msg === MSG.ai) { return 'ai'; }
        return 'unknown';
    }

    // One dataLayer message per event: { event: name, ...data }. GTM triggers match on `event`, the
    // other keys are read with Data Layer Variables (lead_id, event_id, value, currency, property_type).
    // `done`, when given, runs once the container has fired the event's tags (or after a short timeout
    // when the container never answers, e.g. blocked), so a navigation can wait for a conversion hit.
    function pushEvent(name, data, done) {
        if (GTM_ID === '') {
            if (done != null) {
                done();
            }
            return;
        }
        var payload = { event: name };
        Object.keys(data || {}).forEach(function (key) {
            payload[key] = data[key];
        });
        if (done != null) {
            var called = false;
            var finish = function () {
                if (!called) {
                    called = true;
                    done();
                }
            };
            payload.eventCallback = finish;
            payload.eventTimeout = 500;
            window.setTimeout(finish, 700);
        }
        window.dataLayer.push(payload);
    }

    // Interaction events: Clarity custom events (name only) plus a dataLayer message for the container,
    // both no-ops until the tags are loaded, i.e. only after cookie consent. `done` is called after
    // the container handled the event (see pushEvent), or immediately when nothing is loaded.
    function track(name, data, done) {
        if (window.__ddTagsLoaded !== true) {
            queuePending({ kind: 'event', name: name, data: data || {} });
            if (done != null) {
                done();
            }
            return;
        }
        if (window.clarity != null) {
            window.clarity('event', name);
        }
        pushEvent(name, data, done);
    }

    // Clarity custom tags are what the session filters work on (events are only markers on the timeline).
    function tag(key, value) {
        if (window.__ddTagsLoaded !== true) {
            queuePending({ kind: 'tag', key: key, value: String(value) });
            return;
        }
        if (window.clarity != null) {
            window.clarity('set', key, String(value));
        }
    }

    // Before the visitor answers the cookie banner nothing may be sent, but a CTA click on the landing
    // followed by "Accept" on the form page is still one visit: keep the events in sessionStorage and
    // replay them once the tags load. A "Doar cele necesare" answer discards the queue.
    function queuePending(entry) {
        if (readStore(localStorage, CONSENT_KEY) === 'denied') {
            return;
        }
        var pending = readStore(sessionStorage, PENDING_KEY);
        if (!Array.isArray(pending)) {
            pending = [];
        }
        if (pending.length >= PENDING_LIMIT) {
            return;
        }
        pending.push(entry);
        writeStore(sessionStorage, PENDING_KEY, pending);
    }

    function flushPending() {
        var pending = readStore(sessionStorage, PENDING_KEY);
        try {
            sessionStorage.removeItem(PENDING_KEY);
        } catch (e) {
            // storage blocked
        }
        if (!Array.isArray(pending)) {
            return;
        }
        pending.forEach(function (entry) {
            if (entry.kind === 'tag') {
                tag(entry.key, entry.value);
            } else if (entry.kind === 'event') {
                track(entry.name, entry.data);
            }
        });
    }

    // Short reason for a failed request, safe to put in an event name.
    function failureCode(error) {
        var message = error != null && typeof error.message === 'string' ? error.message : '';
        return /^http_\d{3}$/.test(message) ? message : 'network';
    }

    function initConsent() {
        var banner = document.getElementById('cookie');
        var settings = document.getElementById('cookie-settings');
        if (settings != null && banner != null) {
            // "Setări cookie" on the privacy page: forget the stored choice and ask again.
            settings.addEventListener('click', function (event) {
                event.preventDefault();
                try {
                    localStorage.removeItem(CONSENT_KEY);
                } catch (e) {
                    // storage blocked
                }
                banner.hidden = false;
                banner.scrollIntoView({ block: 'end' });
            });
        }
        var stored = readStore(localStorage, CONSENT_KEY);
        if (stored === 'granted') {
            enableTags();
            return;
        }
        if (stored === 'denied' || banner == null) {
            return;
        }
        banner.hidden = false;
        document.getElementById('cookie-accept').addEventListener('click', function () {
            writeStore(localStorage, CONSENT_KEY, 'granted');
            banner.hidden = true;
            enableTags();
        });
        document.getElementById('cookie-reject').addEventListener('click', function () {
            writeStore(localStorage, CONSENT_KEY, 'denied');
            try {
                sessionStorage.removeItem(PENDING_KEY);
            } catch (e) {
                // storage blocked
            }
            banner.hidden = true;
        });
    }

    // The lead conversion. In the container: Google Ads conversion (transaction id = lead_id, so Ads
    // deduplicates too) and the Meta "Lead" pixel event with eventID = event_id, the same id the intake
    // sends through the Conversions API, so Meta keeps one of the two.
    function fireConversion(leadId) {
        if (window.__ddTagsLoaded !== true) {
            return;
        }
        pushEvent('lead_converted', { lead_id: leadId, event_id: leadId });
        if (window.clarity != null) {
            window.clarity('event', 'lead_converted');
            window.clarity('identify', leadId);
        }
    }

    // ---- Landing page wiring (the markup is the Angular build's own) ----
    var EXAMPLE_REPORT_URL = 'https://static.knoha.eu/static/example-report.pdf';

    function setLabel(button, text) {
        var label = button.querySelector('.button-label');
        if (label != null) {
            label.textContent = text;
        } else {
            button.textContent = text;
        }
    }

    // Clarity "page" tag: landing, request, thanks, report, or the legal page's file name.
    function pageName() {
        var declared = document.body.getAttribute('data-page');
        if (declared != null) {
            return declared;
        }
        if (document.getElementById('lead-form') != null) {
            return 'request';
        }
        var file = window.location.pathname.replace(/^.*\//, '').replace(/\.html$/, '');
        return file === '' || file === 'index' ? 'landing' : file;
    }

    // Which "Obține raportul" was clicked: the hero, the CF service card, or something else.
    function ctaPosition(element) {
        if (element.closest('app-due-diligence-hero') != null) {
            return 'hero';
        }
        if (element.closest('app-due-diligence-guide-right') != null) {
            return 'cf_card';
        }
        return 'other';
    }

    function initLandingActions() {
        document.querySelectorAll('[data-action]').forEach(function (element) {
            element.addEventListener('click', function (event) {
                var action = element.getAttribute('data-action');
                if (action === 'request') {
                    event.preventDefault();
                    // `cta_request` is the primary Google Ads conversion: the navigation waits for the
                    // container to fire its tag, otherwise the page unload would cut the hit short.
                    track('cta_request_' + ctaPosition(element));
                    track('cta_request', { cta_position: ctaPosition(element) }, function () {
                        window.location.href = 'cerere.html' + window.location.search;
                    });
                } else if (action === 'example') {
                    event.preventDefault();
                    track('example_report');
                    window.open(EXAMPLE_REPORT_URL, '_blank', 'noopener');
                } else if (action === 'home') {
                    window.location.href = './' + window.location.search;
                }
            });
        });
        var back = document.getElementById('back-home');
        if (back != null) {
            back.addEventListener('click', function () {
                window.location.href = './';
            });
        }
    }

    function initAccordions() {
        document.querySelectorAll('app-accordion .accordion-layout').forEach(function (layout, index) {
            layout.addEventListener('click', function () {
                var wrapper = layout.querySelector('.message-wrapper');
                var chevron = layout.querySelector('.chevron-icon');
                var open = wrapper.classList.toggle('message-wrapper--expanded');
                if (open) {
                    track('faq_opened_' + (index + 1));
                }
                if (chevron != null) {
                    chevron.classList.toggle('chevron-rotated', open);
                }
            });
        });
    }

    function initGuideToggle() {
        var controls = document.querySelectorAll('[data-guide]');
        if (controls.length === 0) {
            return;
        }
        controls.forEach(function (control) {
            control.addEventListener('click', function () {
                var key = control.getAttribute('data-guide');
                track('cf_guide_tab_' + key);
                controls.forEach(function (other) {
                    var selected = other === control;
                    other.classList.toggle('item-container-selected', selected);
                    var text = other.querySelector('.item-text');
                    if (text != null) {
                        text.classList.toggle('item-text-selected', selected);
                        text.classList.toggle('item-text-unselected', !selected);
                    }
                });
                document.querySelectorAll('[data-guide-list]').forEach(function (list) {
                    list.hidden = list.getAttribute('data-guide-list') !== key;
                });
            });
        });
    }

    // "Cum obții CF-ul?" on the request page opens the landing's CF guide in a popup, so the form is not lost.
    function initCfGuide() {
        var link = document.getElementById('cf-guide-link');
        var modal = document.getElementById('cf-guide-modal');
        if (link == null || modal == null) {
            return;
        }
        var close = document.getElementById('cf-guide-close');
        function hide() {
            modal.hidden = true;
        }
        link.addEventListener('click', function (event) {
            event.preventDefault();
            modal.hidden = false;
            track('cf_guide_opened', {});
            if (close != null) {
                close.focus();
            }
        });
        if (close != null) {
            close.addEventListener('click', hide);
        }
        modal.addEventListener('click', function (event) {
            if (event.target === modal) {
                hide();
            }
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && !modal.hidden) {
                hide();
            }
        });
    }

    // ---- Request form: contact + CF documents on one screen ----
    // Same rules as the app: DueDiligenceSubmitConstants.CADASTRAL_NR_PATTERN, EmailValidationStrategy,
    // PhoneNumberValidationStrategy for +40 (10 digits starting 07, or 9 digits starting 7).
    var CADASTRAL_PATTERN = /^\d{1,10}-C\d{1,4}-U\d{1,4}$/;
    var EMAIL_PATTERN = /^(?=.{0,255}$)(?=.{0,64}@)(?:[a-zA-Z0-9!#$%&'*+/=?^_'{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_'{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f]){1,62}")@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?=[a-zA-Z0-9-]*[a-zA-Z][a-zA-Z0-9-]*$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    var MSG = {
        email: 'Adresă de email invalidă',
        phone: 'Număr de telefon invalid',
        cadastralMissing: 'Te rugăm să introduci numărul cadastral.',
        cadastralInvalid: 'Format invalid. Se așteaptă: XXXXXX-CX-UX',
        cfFile: 'Te rugăm să încarci documentul CF.',
        cfPhotos: 'Te rugăm să încarci cel puțin o fotografie a extrasului CF.',
        terms: 'Te rugăm să accepți Termenii și Condițiile & Politica de Confidențialitate.',
        ai: 'Te rugăm să accepți prelucrarea datelor tale cu caracter personal și utilizarea sistemelor de Inteligență Artificială.'
    };

    function normalizeRomanianPhone(raw) {
        var digits = (raw || '').replace(/[\s().-]/g, '');
        if (digits.charAt(0) === '+') {
            digits = digits.slice(1);
        }
        if (!/^\d+$/.test(digits)) {
            return null;
        }
        if (digits.indexOf('0040') === 0) {
            digits = digits.slice(4);
        } else if (digits.indexOf('40') === 0 && digits.length >= 11) {
            digits = digits.slice(2);
        }
        var valid = (digits.length === 10 && digits.indexOf('07') === 0) || (digits.length === 9 && digits.charAt(0) === '7');
        return valid ? '+40' + digits.slice(-9) : null;
    }
    var MAX_FILE_BYTES = 10 * 1024 * 1024;
    var PHOTO_LIMIT = { cf: 12, parkingCf: 4, other: 10 };
    var FIELD_NAMES = { cf: { pdf: 'cf', photo: 'cfPhotos' }, parkingCf: { pdf: 'parkingCf', photo: 'parkingCfPhotos' }, other: { any: 'otherDocuments' } };
    var STATUS_ICON = {
        pending: 'https://static.knoha.eu/static/svg/spinner.svg',
        success: 'https://static.knoha.eu/static/svg/checkmark_green.svg',
        error: 'https://static.knoha.eu/static/svg/alert_error.svg',
        canceled: 'https://static.knoha.eu/static/svg/alert_warning.svg'
    };
    var STATUS_TEXT = { pending: 'Se procesează...', success: 'Succes', error: 'Eroare', canceled: 'Anulat' };
    var docs = {
        cf: { mode: 'pdf', pdf: null, photos: [] },
        parkingCf: { mode: 'pdf', pdf: null, photos: [] },
        // "Alte documente": PDFs and photos mixed, kept in the photos list, no mode toggle.
        other: { mode: 'any', pdf: null, photos: [] }
    };

    function setFieldError(form, name, on) {
        var field = form.querySelector('[data-field="' + name + '"]');
        if (field != null) {
            field.classList.toggle('invalid', on);
        }
    }

    function showFormError(id, message) {
        var box = document.getElementById(id);
        box.textContent = message;
        box.classList.toggle('show', message !== '');
    }

    function docBlock(block) {
        return document.querySelector('[data-block="' + block + '"]');
    }

    function blockActive(block) {
        var element = docBlock(block);
        return element != null && !element.hidden;
    }

    function configureDocStep(propertyType) {
        var title = document.getElementById('cf-title');
        var parking = document.getElementById('parking-block');
        if (title != null) {
            title.textContent = propertyType === 'land' ? 'CF terenului' : 'CF apartamentului';
        }
        if (parking != null) {
            parking.hidden = propertyType === 'land';
        }
        updateTips();
    }

    function updateTips() {
        var anyPhotoMode = Object.keys(docs).some(function (key) {
            return docs[key].mode === 'photo' && blockActive(key);
        });
        document.getElementById('photo-tips').hidden = !anyPhotoMode;
    }

    function setDocMode(block, mode) {
        if (docs[block].mode === 'any') {
            renderDoc(block);
            return;
        }
        docs[block].mode = mode;
        document.querySelectorAll('[data-seg-group="' + block + '"]').forEach(function (control) {
            var selected = control.getAttribute('data-seg') === mode;
            control.classList.toggle('item-container-selected', selected);
            var text = control.querySelector('.item-text');
            if (text != null) {
                text.classList.toggle('item-text-selected', selected);
                text.classList.toggle('item-text-unselected', !selected);
            }
        });
        var input = document.querySelector('[data-file-input="' + block + '"]');
        var desc = document.querySelector('[data-drop-desc="' + block + '"]');
        if (mode === 'pdf') {
            input.accept = '.pdf,application/pdf';
            input.multiple = false;
            desc.textContent = 'Format compatibil: PDF.';
        } else {
            input.accept = '.jpg,.jpeg,.png,.heic,image/jpeg,image/png,image/heic';
            input.multiple = true;
            desc.textContent = 'Formate compatibile: JPG, PNG. Maximum ' + PHOTO_LIMIT[block] + ' fotografii.';
        }
        renderDoc(block);
        updateTips();
    }

    function addDocFiles(block, fileList) {
        var state = docs[block];
        var added = 0;
        Array.prototype.forEach.call(fileList, function (file) {
            if (file.size > MAX_FILE_BYTES) {
                showFormError('lead-error', file.name + ' depășește 10 MB.');
                track('file_too_large_' + block);
                return;
            }
            if (state.mode === 'pdf') {
                // A PDF is the single selection for this document; it replaces any photos held.
                state.pdf = file;
                state.photos = [];
                added++;
            } else if (state.photos.length < PHOTO_LIMIT[block]) {
                // Adding a photo replaces a held PDF (only the first add clears it).
                state.pdf = null;
                state.photos.push(file);
                added++;
            } else {
                showFormError('lead-error', 'Maximum ' + PHOTO_LIMIT[block] + ' fișiere la ' + (block === 'other' ? 'alte documente' : 'fotografii') + '.');
                track('file_limit_' + block);
            }
        });
        if (added > 0) {
            track('file_added_' + block + '_' + (state.mode === 'any' ? 'mixed' : state.mode), { block: block, count: added });
        }
        renderDoc(block);
    }

    var refreshSubmitState = function () {};

    function renderDoc(block) {
        refreshSubmitState();
        var state = docs[block];
        var list = document.querySelector('[data-file-list="' + block + '"]');
        var grid = document.querySelector('[data-photo-grid="' + block + '"]');
        var drop = document.querySelector('[data-drop="' + block + '"]');
        var dropMobile = document.querySelector('[data-drop-mobile="' + block + '"]');
        list.innerHTML = '';
        grid.innerHTML = '';
        // A held PDF is shown whatever the toggle says, so switching tabs never hides the selection.
        if (state.pdf != null) {
            var item = document.createElement('li');
            var name = document.createElement('span');
            name.textContent = state.pdf.name + ' (' + Math.round(state.pdf.size / 1024) + ' KB)';
            var remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'dd-file-remove';
            remove.textContent = 'Șterge';
            remove.addEventListener('click', function () {
                state.pdf = null;
                renderDoc(block);
            });
            item.appendChild(name);
            item.appendChild(remove);
            list.appendChild(item);
        }
        // Dropzone visibility follows the current toggle: hide it once that kind already has content.
        if (state.mode === 'pdf') {
            drop.hidden = state.pdf != null;
        } else {
            drop.hidden = state.photos.length >= PHOTO_LIMIT[block];
        }
        dropMobile.hidden = drop.hidden;
        state.photos.forEach(function (photo, index) {
            if (state.mode === 'any' && !/^image\//.test(photo.type)) {
                var row = document.createElement('li');
                var label = document.createElement('span');
                label.textContent = photo.name + ' (' + Math.round(photo.size / 1024) + ' KB)';
                var removeRow = document.createElement('button');
                removeRow.type = 'button';
                removeRow.className = 'dd-file-remove';
                removeRow.textContent = 'Șterge';
                removeRow.addEventListener('click', function () {
                    state.photos.splice(index, 1);
                    track('file_removed_' + block);
                    renderDoc(block);
                });
                row.appendChild(label);
                row.appendChild(removeRow);
                list.appendChild(row);
                return;
            }
            var cell = document.createElement('div');
            cell.className = 'dd-photo-item';
            var img = document.createElement('img');
            img.alt = photo.name;
            img.src = URL.createObjectURL(photo);
            img.addEventListener('load', function () {
                URL.revokeObjectURL(img.src);
            });
            var remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'dd-photo-remove';
            remove.setAttribute('aria-label', 'Șterge ' + photo.name);
            remove.textContent = '×';
            remove.addEventListener('click', function () {
                state.photos.splice(index, 1);
                track('file_removed_' + block);
                renderDoc(block);
            });
            cell.appendChild(img);
            cell.appendChild(remove);
            grid.appendChild(cell);
        });
    }

    function buildFilesBody() {
        var body = new FormData();
        var count = 0;
        Object.keys(docs).forEach(function (block) {
            if (!blockActive(block)) {
                return;
            }
            var state = docs[block];
            if (state.mode === 'any') {
                state.photos.forEach(function (photo) {
                    body.append(FIELD_NAMES[block].any, photo, photo.name);
                    count++;
                });
            } else if (state.pdf != null) {
                body.append(FIELD_NAMES[block].pdf, state.pdf, state.pdf.name);
                count++;
            } else {
                state.photos.forEach(function (photo) {
                    body.append(FIELD_NAMES[block].photo, photo, photo.name);
                    count++;
                });
            }
        });
        return count > 0 ? body : null;
    }

    function collectRequest(form, fetchCf) {
        var data = new FormData(form);
        var request = {
            email: (data.get('email') || '').trim(),
            phone: normalizeRomanianPhone(data.get('phone')) || (data.get('phone') || '').trim(),
            propertyType: data.get('propertyType'),
            termsAccepted: data.get('termsAccepted') === 'on',
            aiConsentAccepted: data.get('aiConsentAccepted') === 'on',
            website: (data.get('website') || '').trim() || undefined,
            attribution: currentAttribution(),
            // Whether the visitor accepted measurement cookies; the intake sends the lead to the Meta
            // Conversions API only when this is true.
            marketingConsent: readStore(localStorage, CONSENT_KEY) === 'granted'
        };
        if (fetchCf) {
            request.cadastralNumber = (data.get('cadastralNumber') || '').toUpperCase().replace(/\s+/g, '');
        }
        return request;
    }

    // Returns the first problem, in the order the app checks them, or null when the request can be sent.
    function requestIssue(form, fetchCf, touched) {
        var email = form.querySelector('#email').value.trim();
        var phone = form.querySelector('#phone').value;
        var emailOk = email.length > 0 && EMAIL_PATTERN.test(email);
        var phoneOk = normalizeRomanianPhone(phone) != null;
        setFieldError(form, 'email', touched.email === true && !emailOk);
        setFieldError(form, 'phone', touched.phone === true && !phoneOk);
        var cadastral = form.querySelector('#cadastralNumber').value.toUpperCase().replace(/\s+/g, '');
        var cadastralOk = CADASTRAL_PATTERN.test(cadastral);
        setFieldError(form, 'cadastralNumber', fetchCf && touched.cadastralNumber === true && cadastral.length > 0 && !cadastralOk);
        if (!emailOk) {
            return MSG.email;
        }
        if (!phoneOk) {
            return MSG.phone;
        }
        if (fetchCf) {
            if (cadastral.length === 0) {
                return MSG.cadastralMissing;
            }
            if (!cadastralOk) {
                return MSG.cadastralInvalid;
            }
        } else {
            var cf = docs.cf;
            if (cf.pdf == null && cf.photos.length === 0) {
                return cf.mode === 'photo' ? MSG.cfPhotos : MSG.cfFile;
            }
        }
        if (!form.querySelector('#termsAccepted').checked) {
            return MSG.terms;
        }
        if (!form.querySelector('#aiConsentAccepted').checked) {
            return MSG.ai;
        }
        return null;
    }

    // ---- Progress modal: one row per request, run in sequence, retry per row ----
    var progress = { leadId: null, request: null, filesBody: null, paymentRequired: false, priceRon: 150 };

    function setStep(step, status, message) {
        var row = document.querySelector('[data-step="' + step + '"]');
        var box = row.querySelector('.dd-progress-status');
        box.setAttribute('data-status', status);
        row.querySelector('.dd-progress-text').textContent = status === 'idle' ? '' : (message || STATUS_TEXT[status]);
        row.querySelector('.dd-progress-icon').src = STATUS_ICON[status] || '';
        row.querySelector('.dd-progress-retry').hidden = status !== 'error';
    }

    function setModalClosable(closable) {
        var close = document.getElementById('progress-close');
        close.disabled = !closable;
    }

    function openProgress(withFiles) {
        var modal = document.getElementById('progress-modal');
        document.querySelector('[data-step="files"]').hidden = !withFiles;
        document.querySelector('[data-step="payment"]').hidden = true;
        setStep('lead', 'idle');
        setStep('files', 'idle');
        setStep('payment', 'idle');
        setModalClosable(false);
        modal.hidden = false;
    }

    function closeProgress() {
        document.getElementById('progress-modal').hidden = true;
        var submit = document.getElementById('lead-submit');
        setLabel(submit, 'Trimite cererea');
        refreshSubmitState();
    }

    function runLeadStep() {
        setStep('lead', 'pending');
        if (progress.filesBody != null) {
            setStep('files', 'idle');
        }
        fetch(API_BASE + '/leads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(progress.request)
        }).then(function (response) {
            return response.json().then(function (body) {
                return { ok: response.ok, status: response.status, body: body };
            }, function () {
                return { ok: false, status: response.status, body: {} };
            });
        }).then(function (result) {
            if (!result.ok || result.body.id == null) {
                throw new Error('http_' + result.status);
            }
            progress.leadId = result.body.id;
            progress.paymentRequired = result.body.paymentRequired === true;
            progress.priceRon = result.body.priceRon || progress.priceRon;
            writeStore(sessionStorage, LEAD_KEY, progress.leadId);
            setStep('lead', 'success');
            if (progress.paymentRequired) {
                // Second report for this email or phone: the modal grows a payment step before the redirect.
                document.querySelector('[data-step="payment"] .dd-progress-label').textContent = 'Plata raportului (' + progress.priceRon + ' RON)';
                document.querySelector('[data-step="payment"]').hidden = false;
                track('payment_required', { price_ron: progress.priceRon });
            }
            track('lead_submitted', { property_type: progress.request.propertyType, fetch_cf: progress.request.cadastralNumber != null });
            if (progress.filesBody != null) {
                runFilesStep();
            } else {
                finishSequence();
            }
        }).catch(function (error) {
            track('lead_failed_' + failureCode(error));
            setStep('lead', 'error', 'Nu am putut salva cererea. Verifică conexiunea și reîncearcă.');
            if (progress.filesBody != null) {
                setStep('files', 'canceled');
            }
            setModalClosable(true);
        });
    }

    function runFilesStep() {
        setStep('files', 'pending');
        fetch(API_BASE + '/leads/' + encodeURIComponent(progress.leadId) + '/files', { method: 'POST', body: progress.filesBody })
            .then(function (response) {
                return response.json().then(function (data) {
                    return { ok: response.ok, body: data };
                });
            })
            .then(function (result) {
                var stored = (result.body && result.body.stored) || [];
                var rejected = (result.body && result.body.rejected) || [];
                if (!result.ok && rejected.length === 0) {
                    throw new Error('rejected');
                }
                track('files_uploaded', { count: stored.length });
                if (stored.length === 0) {
                    track('upload_rejected');
                    setStep('files', 'error', rejected.map(function (entry) { return entry.name + ': ' + entry.reason; }).join('; '));
                    setModalClosable(true);
                    return;
                }
                setStep('files', 'success');
                finishSequence();
            })
            .catch(function (error) {
                track('upload_failed_' + failureCode(error));
                setStep('files', 'error', 'Nu am putut încărca documentele. Reîncearcă.');
                setModalClosable(true);
            });
    }

    function finishSequence() {
        if (progress.paymentRequired) {
            runPaymentStep();
            return;
        }
        setModalClosable(true);
        window.setTimeout(function () {
            window.location.href = 'multumim.html?id=' + encodeURIComponent(progress.leadId);
        }, 700);
    }

    // Asks the API for a Stripe Checkout session and sends the browser there; Stripe returns to multumim.html.
    function startCheckout(leadId) {
        return fetch(API_BASE + '/leads/' + encodeURIComponent(leadId) + '/checkout', { method: 'POST' })
            .then(function (response) {
                return response.json().then(function (body) {
                    return { ok: response.ok, body: body };
                });
            })
            .then(function (result) {
                if (!result.ok) {
                    throw new Error('rejected');
                }
                if (result.body.paymentRequired !== true || result.body.paid === true) {
                    return false;
                }
                if (result.body.url == null) {
                    throw new Error('no url');
                }
                track('checkout_started', { price_ron: progress.priceRon });
                window.location.href = result.body.url;
                return true;
            });
    }

    function runPaymentStep() {
        setStep('payment', 'pending', 'Te ducem la plată...');
        startCheckout(progress.leadId).then(function (redirected) {
            if (!redirected) {
                setStep('payment', 'success', 'Nu este necesară');
                progress.paymentRequired = false;
                finishSequence();
            }
        }).catch(function (error) {
            track('checkout_failed_' + failureCode(error));
            setStep('payment', 'error', 'Nu am putut deschide plata. Reîncearcă sau plătește din pagina următoare.');
            setModalClosable(true);
        });
    }

    function initRequestForm() {
        var form = document.getElementById('lead-form');
        if (form == null || document.getElementById('progress-modal') == null) {
            return;
        }
        var submit = document.getElementById('lead-submit');
        var fetchCf = document.getElementById('fetch-cf');
        var cadastralBlock = document.getElementById('cadastral-block');
        var uploadBlocks = document.getElementById('upload-blocks');

        var tooltip = document.getElementById('submit-tooltip');
        var tooltipText = document.getElementById('submit-tooltip-text');
        var host = document.getElementById('submit-host');
        var touched = {};
        var currentIssue = null;

        refreshSubmitState = function () {
            currentIssue = requestIssue(form, fetchCf.checked, touched);
            submit.disabled = currentIssue != null;
            if (currentIssue == null) {
                tooltip.hidden = true;
            } else {
                tooltipText.textContent = currentIssue;
            }
        };
        function showTooltip() {
            if (currentIssue != null) {
                tooltipText.textContent = currentIssue;
                tooltip.hidden = false;
            }
        }
        function hideTooltip() {
            tooltip.hidden = true;
        }
        // A disabled button swallows pointer events, so the wrapper owns hover, focus and tap.
        host.addEventListener('mouseenter', showTooltip);
        host.addEventListener('mouseleave', hideTooltip);
        host.addEventListener('touchstart', function () {
            if (tooltip.hidden) {
                showTooltip();
                window.setTimeout(hideTooltip, 2500);
            }
        }, { passive: true });
        host.addEventListener('focusin', showTooltip);
        host.addEventListener('focusout', hideTooltip);

        ['email', 'phone', 'cadastralNumber'].forEach(function (name) {
            var input = form.querySelector('#' + name);
            input.addEventListener('input', refreshSubmitState);
            input.addEventListener('blur', function () {
                touched[name] = true;
                refreshSubmitState();
                var field = form.querySelector('[data-field="' + name + '"]');
                if (field != null && field.classList.contains('invalid')) {
                    track('invalid_' + name);
                }
            });
        });
        document.getElementById('termsAccepted').addEventListener('change', function (e) {
            track('terms_' + (e.target.checked ? 'checked' : 'unchecked'));
            refreshSubmitState();
        });
        document.getElementById('aiConsentAccepted').addEventListener('change', function (e) {
            track('ai_consent_' + (e.target.checked ? 'checked' : 'unchecked'));
            refreshSubmitState();
        });

        var started = false;
        form.addEventListener('input', function () {
            if (!started) {
                started = true;
                track('form_started');
            }
        });
        form.querySelectorAll('input[name=propertyType]').forEach(function (radio) {
            radio.addEventListener('change', function () {
                tag('property_type', radio.value);
                configureDocStep(radio.value);
            });
        });
        configureDocStep((form.querySelector('input[name=propertyType]:checked') || {}).value);

        Object.keys(docs).forEach(function (block) {
            var input = document.querySelector('[data-file-input="' + block + '"]');
            var drop = document.querySelector('[data-drop="' + block + '"]');
            input.addEventListener('change', function () {
                showFormError('lead-error', '');
                addDocFiles(block, input.files);
                input.value = '';
            });
            ['browse-' + block, 'browse-' + block + '-mobile'].forEach(function (id) {
                document.getElementById(id).addEventListener('click', function () {
                    input.click();
                });
            });
            ['dragenter', 'dragover'].forEach(function (name) {
                drop.addEventListener(name, function (event) {
                    event.preventDefault();
                    drop.classList.add('dd-dropzone-dragover');
                });
            });
            ['dragleave', 'drop'].forEach(function (name) {
                drop.addEventListener(name, function (event) {
                    event.preventDefault();
                    drop.classList.remove('dd-dropzone-dragover');
                });
            });
            drop.addEventListener('drop', function (event) {
                if (event.dataTransfer != null) {
                    addDocFiles(block, event.dataTransfer.files);
                }
            });
            setDocMode(block, 'pdf');
        });

        document.querySelectorAll('[data-seg-group]').forEach(function (control) {
            control.addEventListener('click', function () {
                var group = control.getAttribute('data-seg-group');
                var mode = control.getAttribute('data-seg');
                track('mode_' + group + '_' + mode);
                setDocMode(group, mode);
            });
        });

        fetchCf.addEventListener('change', function () {
            cadastralBlock.hidden = !fetchCf.checked;
            uploadBlocks.hidden = fetchCf.checked;
            showFormError('lead-error', '');
            track(fetchCf.checked ? 'fetch_cf_selected' : 'fetch_cf_deselected');
            tag('fetch_cf', fetchCf.checked ? 'yes' : 'no');
            refreshSubmitState();
        });
        refreshSubmitState();

        document.querySelectorAll('.dd-progress-retry').forEach(function (link) {
            link.addEventListener('click', function (event) {
                event.preventDefault();
                var step = link.closest('[data-step]').getAttribute('data-step');
                track('retry_' + step);
                setModalClosable(false);
                if (step === 'lead' || progress.leadId == null) {
                    runLeadStep();
                } else if (step === 'payment') {
                    runPaymentStep();
                } else {
                    runFilesStep();
                }
            });
        });
        document.getElementById('progress-close').addEventListener('click', closeProgress);

        form.addEventListener('submit', function (event) {
            event.preventDefault();
            showFormError('lead-error', '');
            touched = { email: true, phone: true, cadastralNumber: true };
            refreshSubmitState();
            if (currentIssue != null) {
                showTooltip();
                track('submit_blocked_' + issueCode(currentIssue), { reason: issueCode(currentIssue) });
                return;
            }
            var request = collectRequest(form, fetchCf.checked);
            progress.request = request;
            progress.leadId = null;
            progress.filesBody = fetchCf.checked ? null : buildFilesBody();
            submit.disabled = true;
            setLabel(submit, 'Se trimite...');
            openProgress(progress.filesBody != null);
            runLeadStep();
        });
    }

    // ---- Thank-you page ----
    function initThanks() {
        if (document.body.getAttribute('data-page') !== 'thanks') {
            return;
        }
        var params = new URLSearchParams(window.location.search);
        var leadId = params.get('id') || readStore(sessionStorage, LEAD_KEY) || '';
        var target = document.getElementById('lead-id');
        if (target != null && leadId !== '') {
            target.textContent = leadId;
        }
        // Back from Stripe: ?plata=ok after a payment, ?plata=anulata when the customer left Checkout.
        var payment = params.get('plata');
        if (payment === 'ok') {
            document.getElementById('payment-ok').hidden = false;
            // Purchase conversion for the paid (repeat) report, once per lead like the lead conversion below.
            // event_id matches the intake's Conversions API purchase event; `suma` is appended to the
            // Stripe success URL by the intake.
            var paidKey = 'dd_paid_' + leadId;
            if (leadId !== '' && readStore(sessionStorage, paidKey) == null) {
                writeStore(sessionStorage, paidKey, true);
                var paidRon = Number(params.get('suma'));
                var purchase = { lead_id: leadId, event_id: leadId + '-paid', currency: 'RON' };
                if (paidRon > 0) {
                    purchase.value = paidRon;
                }
                track('payment_completed', purchase);
            }
        } else if (payment === 'anulata' && leadId !== '') {
            var pending = document.getElementById('payment-pending');
            pending.hidden = false;
            track('payment_cancelled', {});
            var payButton = document.getElementById('pay-now');
            if (payButton != null) {
                payButton.addEventListener('click', function () {
                    payButton.disabled = true;
                    document.getElementById('payment-error').hidden = true;
                    startCheckout(leadId).then(function (redirected) {
                        if (!redirected) {
                            pending.hidden = true;
                            document.getElementById('payment-ok').hidden = false;
                        }
                    }).catch(function () {
                        payButton.disabled = false;
                        var error = document.getElementById('payment-error');
                        error.textContent = 'Nu am putut deschide plata. Reîncearcă în câteva momente.';
                        error.hidden = false;
                    });
                });
            }
        }
        var firedKey = 'dd_conv_' + leadId;
        if (leadId !== '' && readStore(sessionStorage, firedKey) == null) {
            writeStore(sessionStorage, firedKey, true);
            // gtag queues events until the tag loads, so this is safe right after enableTags().
            fireConversion(leadId);
        }
    }

    // ---- Report page: raport.html#<leadId>.<token>; the fragment never reaches a server log ----
    function initReport() {
        if (document.body.getAttribute('data-page') !== 'report') {
            return;
        }
        var status = document.getElementById('report-status');
        var actions = document.getElementById('report-actions');
        var note = document.getElementById('report-note');
        var frame = document.getElementById('report-frame');
        var openButton = document.getElementById('report-open');
        var downloadButton = document.getElementById('report-download');
        var match = /^([0-9a-z]{8,32})\.([A-Za-z0-9_-]{16,64})$/.exec(window.location.hash.replace(/^#/, ''));

        function showError(message) {
            status.textContent = message;
            actions.hidden = true;
            note.hidden = true;
            frame.hidden = true;
        }

        if (match == null) {
            track('report_link_invalid');
            showError('Linkul nu este valid. Deschide exact linkul din email; dacă problema persistă, răspunde la emailul primit.');
            return;
        }

        var links = null;
        function load() {
            fetch(API_BASE + '/raport/' + encodeURIComponent(match[1]) + '/' + encodeURIComponent(match[2]) + '/links', {
                headers: { accept: 'application/json' }
            }).then(function (response) {
                if (!response.ok) {
                    throw new Error(String(response.status));
                }
                return response.json();
            }).then(function (data) {
                links = data;
                track('report_viewed');
                status.textContent = 'Raportul este gata. Îl poți descărca sau deschide într-o fereastră nouă.';
                actions.hidden = false;
                var minutes = Math.round((data.expiresInSeconds || 900) / 60);
                note.textContent = 'Butoanele funcționează ' + minutes + ' minute de la deschiderea paginii; dacă au expirat, reîncarcă pagina. Linkul din email rămâne valabil.';
                note.hidden = false;
                frame.src = data.view;
                frame.hidden = false;
            }).catch(function (error) {
                track(error.message === '404' ? 'report_link_not_found' : 'report_load_failed');
                showError(error.message === '404'
                    ? 'Raportul nu a fost găsit. Linkul nu este valid sau raportul nu a fost încă publicat.'
                    : 'Nu am putut încărca raportul. Reîncearcă în câteva momente.');
            });
        }

        if (openButton != null) {
            openButton.addEventListener('click', function () {
                if (links != null) {
                    track('report_opened_tab');
                    window.open(links.view, '_blank', 'noopener');
                }
            });
        }
        if (downloadButton != null) {
            downloadButton.addEventListener('click', function () {
                if (links != null) {
                    track('report_downloaded');
                    window.location.href = links.download;
                }
            });
        }
        load();
    }

    captureAttribution();
    tag('page', pageName());
    initLandingActions();
    initAccordions();
    initGuideToggle();
    initCfGuide();
    initConsent();
    initRequestForm();
    initThanks();
    initReport();
})();
