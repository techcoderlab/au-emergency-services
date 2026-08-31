/**
 * BrightSpark Electrical — Lead Funnel Frontend
 *
 * Talks to the same Google Apps Script Web App backend as the previous funnel
 * (config in window.APP_CONFIG, index.html). Webhook behaviour is unchanged:
 * CSRF token fetch -> honeypot check -> POST (text/plain) -> success/error UI.
 *
 * Optimisations in this version:
 *  - Fixed the double-encoding of client_id in the CSRF URL (encodeURIComponent
 *    inside URL.searchParams.set encoded twice).
 *  - new URL(CSRF_ENDPOINT, location.href) so relative fallback endpoints work.
 *  - Australian mobile validation + normalisation to +61 E.164 before submit.
 *  - Bento service cards pre-select the form's service via a single custom event.
 *  - Payload keeps legacy aliases (urgent_issue/address) so an existing Apps
 *    Script sheet mapping continues to receive every lead without changes.
 */

(function () {
    "use strict";

    var CONFIG = window.APP_CONFIG || {};
    var API_ENDPOINT = CONFIG.api_endpoint || "/api/v1/booking-lead";
    var CSRF_ENDPOINT = CONFIG.csrf_endpoint || "/api/v1/csrf-token";
    var HONEYPOT_FIELD = CONFIG.honeypot_field || "client_fax_number";
    var CLIENT_ID_KEY = "brightspark_client_id";
    var THROTTLE_MS = 12000; // client-side guard; server enforces the real 5 req/min limit
    var TIMEOUT_MS = 15000;

    var SERVICE_OPTIONS = [
        "Emergency Electrical",
        "Lighting and Power",
        "Switchboard",
        "Home Electrical",
        "Commercial Electrical",
        "Other"
    ];

    /**
     * Loudly warns in the console about the most common Apps Script
     * misconfiguration: pasting the `script.googleusercontent.com/macros/echo`
     * redirect target instead of the stable deployment URL, which always ends
     * in `/exec`. Requests to the echo URL 404 and never reach doGet/doPost.
     */
    function warnIfEndpointMisconfigured(label, url) {
        if (/googleusercontent\.com\/macros\/echo/.test(url)) {
            console.error(
                "[BrightSpark] " + label + " is set to a script.googleusercontent.com/macros/echo URL: " + url +
                "\nThat's a redirect target, not a stable endpoint — it will 404. " +
                "Use the Web App deployment URL instead (Deploy > Manage deployments), " +
                "which always ends in /exec."
            );
        } else if (/^\/api\/v1\//.test(url)) {
            console.warn(
                "[BrightSpark] " + label + " is still the default relative path (" + url + "). " +
                "This only works if something rewrites it to your Apps Script /exec URL server-side. " +
                "Otherwise, set window.APP_CONFIG in index.html to your deployed .../exec URL directly."
            );
        }
    }

    warnIfEndpointMisconfigured("api_endpoint", API_ENDPOINT);
    warnIfEndpointMisconfigured("csrf_endpoint", CSRF_ENDPOINT);

    /**
     * Stable-but-anonymous per-browser id used only for server-side rate
     * limiting. Not tied to any personal data.
     */
    function getClientId() {
        try {
            var existing = window.localStorage.getItem(CLIENT_ID_KEY);
            if (existing) return existing;
            var id = "c_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 12);
            window.localStorage.setItem(CLIENT_ID_KEY, id);
            return id;
        } catch (e) {
            // localStorage unavailable (private mode, etc.) — per-session id in memory.
            return "c_session_" + Math.random().toString(36).slice(2, 12);
        }
    }

    /**
     * Normalise an Australian mobile number to E.164: +61 4XX XXX XXX.
     * Accepts 0412 345 678, +61 412 345 678, 61412345678, etc.
     * Returns "+61XXXXXXXXX" or null when the value isn't a valid AU mobile.
     */
    function normalizeAUMobile(raw) {
        var value = String(raw || "").trim();
        if (!value) return null;

        var hasPlus = value.charAt(0) === "+";
        var digits = value.replace(/\D/g, "");

        // Strip the 61 country code (only when it's clearly a country code).
        if (digits.indexOf("61") === 0 && (hasPlus || digits.length > 10)) {
            digits = digits.slice(2);
        }
        // Drop the trunk zero (04… -> 4…).
        if (digits.charAt(0) === "0") digits = digits.slice(1);

        // AU mobiles: exactly 9 digits starting with 4.
        return /^4\d{8}$/.test(digits) ? "+61" + digits : null;
    }

    /**
     * Wire the "How Can We Help?" bento cards to the booking form: clicking a
     * card pre-selects its service and the anchor scrolls to #booking-form.
     */
    function initServiceCards() {
        var cards = document.querySelectorAll("[data-service]");
        Array.prototype.forEach.call(cards, function (card) {
            card.addEventListener("click", function () {
                var service = card.getAttribute("data-service");
                if (SERVICE_OPTIONS.indexOf(service) !== -1) {
                    window.dispatchEvent(
                        new CustomEvent("brightspark:select-service", { detail: service })
                    );
                }
            });
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initServiceCards, { once: true });
    } else {
        initServiceCards();
    }

    document.addEventListener("alpine:init", function () {

        /* Booking form: inline validation, honeypot, CSRF, submit states. */
        Alpine.data("bookingForm", () => ({
            form: {
                name: "",
                mobile: "",
                service_type: "",
                suburb: "",
                issue_description: "",
                [HONEYPOT_FIELD]: ""
            },
            errors: { name: "", mobile: "", service_type: "", suburb: "", issue_description: "" },
            touched: { name: false, mobile: false, service_type: false, suburb: false, issue_description: false },
            status: "idle", // idle | loading | success | error
            errorMsg: "",
            lastAttempt: 0,
            csrfToken: "",
            clientId: null,
            _onSelectService: null,
            _onPrefillSuburb: null,

            init() {
                this.form[HONEYPOT_FIELD] = "";
                this.clientId = getClientId();
                this.fetchCsrfToken();

                // Bento card -> pre-select service.
                this._onSelectService = (event) => {
                    this.form.service_type = String(event.detail || "");
                    this.touched.service_type = true;
                    this.validate("service_type");
                };

                // Suburb checker -> prefill suburb.
                this._onPrefillSuburb = (event) => {
                    this.form.suburb = String(event.detail || "").slice(0, 100);
                    this.touched.suburb = true;
                    this.validate("suburb");
                };

                window.addEventListener("brightspark:select-service", this._onSelectService);
                window.addEventListener("brightspark:prefill-suburb", this._onPrefillSuburb);
            },

            destroy() {
                window.removeEventListener("brightspark:select-service", this._onSelectService);
                window.removeEventListener("brightspark:prefill-suburb", this._onPrefillSuburb);
            },

            /**
             * Pulls a one-time CSRF token from the backend before the visitor
             * submits. Fails silently — the backend still enforces validation
             * and rate limiting even if this step didn't complete.
             */
            fetchCsrfToken() {
                var self = this;
                var url = new URL(CSRF_ENDPOINT, window.location.href);
                url.searchParams.set("client_id", this.clientId);

                fetch(url, { method: "GET" })
                    .then((res) => {
                        if (!res.ok) {
                            console.error("[BrightSpark] CSRF token request failed: " + res.status + " " + url);
                            throw new Error("csrf token request failed");
                        }
                        return res.json();
                    })
                    .then((data) => {
                        self.csrfToken = (data && data.token) || null;
                    })
                    .catch(() => {
                        self.csrfToken = null;
                    });
            },

            rules: {
                name(v) {
                    const val = (v || "").trim();
                    if (!val) return "Please enter your name — the electrician will ask for it on arrival.";
                    if (val.length < 2) return "Name must be at least 2 characters.";
                    if (val.length > 80) return "Name must be 80 characters or fewer.";
                    return "";
                },
                mobile(v) {
                    const val = (v || "").trim();
                    if (!val) return "A mobile number is required — the electrician calls you on it.";
                    if (!normalizeAUMobile(val)) {
                        return "Enter a valid Australian mobile (0412 345 678 or +61 412 345 678).";
                    }
                    return "";
                },
                service_type(v) {
                    if (!v) return "Choose the service that best matches your job.";
                    if (SERVICE_OPTIONS.indexOf(v) === -1) return "Choose a service from the list.";
                    return "";
                },
                suburb(v) {
                    const val = (v || "").trim();
                    if (!val) return "Enter your suburb so we can match a local electrician.";
                    if (val.length < 2) return "Suburb must be at least 2 characters.";
                    if (val.length > 100) return "Suburb must be 100 characters or fewer.";
                    return "";
                },
                issue_description(v) {
                    const val = (v || "").trim();
                    if (!val) return "Tell us what you need so we can match the right electrician.";
                    if (val.length < 5) return "A little more detail helps — at least 5 characters.";
                    if (val.length > 1000) return "Please keep it under 1,000 characters.";
                    return "";
                }
            },

            validate(field) {
                this.errors[field] = this.rules[field](this.form[field]);
                return !this.errors[field];
            },

            async submitRequest() {
                if (this.status === "loading") return;

                const fields = ["name", "mobile", "service_type", "suburb", "issue_description"];
                let ok = true;
                fields.forEach((f) => {
                    this.touched[f] = true;
                    if (!this.validate(f)) ok = false;
                });

                if (!ok) {
                    this.$nextTick(() => {
                        const firstBad = fields.find((f) => this.errors[f]);
                        if (firstBad) document.getElementById(firstBad)?.focus();
                    });
                    return;
                }

                // Light client-side throttle (server enforces the real 5 req/min limit).
                const now = Date.now();
                if (this.status !== "error" && now - this.lastAttempt < THROTTLE_MS) {
                    this.status = "error";
                    this.errorMsg = "Your previous request is already being sent — please wait a moment before trying again.";
                    return;
                }
                this.lastAttempt = now;

                // Honeypot: bots get a silent fake success, humans never see this field.
                if (this.form[HONEYPOT_FIELD]) {
                    window.dispatchEvent(new Event("brightspark:lead-success"));
                    this.status = "success";
                    return;
                }

                this.status = "loading";
                this.errorMsg = "";

                const issue = this.form.issue_description.trim();
                const suburb = this.form.suburb.trim();

                const payload = {
                    // Current lead-form schema (CTO spec).
                    name: this.form.name.trim(),
                    mobile: normalizeAUMobile(this.form.mobile) || this.form.mobile.trim(),
                    service_type: this.form.service_type,
                    suburb: suburb,
                    issue_description: issue,

                    // Legacy aliases from the previous funnel so an existing Apps Script
                    // sheet mapping keeps receiving every lead without backend changes.
                    urgent_issue: issue,
                    address: suburb,

                    client_fax_number: this.form[HONEYPOT_FIELD] || "",
                    client_id: this.clientId,
                    csrf_token: this.csrfToken
                };

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

                try {
                    // text/plain keeps this a "simple" CORS request — no preflight,
                    // which is required for Google Apps Script Web App endpoints.
                    const res = await fetch(API_ENDPOINT, {
                        method: "POST",
                        headers: { "Content-Type": "text/plain;charset=utf-8" },
                        body: JSON.stringify(payload),
                        signal: controller.signal
                    });

                    if (!res.ok) {
                        throw new Error(
                            res.status === 429
                                ? "Too many requests right now — please wait a minute and try again."
                                : "The booking service rejected the request (error " + res.status + ")."
                        );
                    }

                    window.dispatchEvent(new Event("brightspark:lead-success"));
                    this.status = "success";
                } catch (err) {
                    this.status = "error";
                    this.errorMsg = err.name === "AbortError"
                        ? "The connection timed out. Check your signal and try again — your details are still here."
                        : (err.message || "Network error — please check your connection and try again.");
                } finally {
                    clearTimeout(timeout);
                }
            }
        }));

        /* Suburb checker (Local Coverage section). Prefills the booking form. */
        Alpine.data("suburbCheck", () => ({
            suburb: "",
            checked: false,
            message: "",

            check() {
                const val = (this.suburb || "").trim();
                this.checked = true;

                if (val.length < 2) {
                    this.message = "Please enter your suburb — at least 2 characters.";
                    return;
                }

                this.message =
                    "Good news — we likely service " + val + " and the surrounding area. " +
                    "We've added it to your request form; add a few details and send it through, and we'll confirm availability straight away.";

                window.dispatchEvent(
                    new CustomEvent("brightspark:prefill-suburb", { detail: val })
                );
            }
        }));

        /* Sticky CTA: hides while the booking form is on screen and after a
           successful submit. */
        Alpine.data("stickyCta", () => ({
            show: false,
            submitted: false,
            formVisible: false,
            onScroll: null,
            onSubmitted: null,

            init() {
                const target = document.getElementById("booking-form");
                if (target) {
                    new IntersectionObserver((entries) => {
                        this.formVisible = entries[0].isIntersecting;
                        this.update();
                    }, { threshold: 0 }).observe(target);
                }

                this.onScroll = () => this.update();
                window.addEventListener("scroll", this.onScroll, { passive: true });

                this.onSubmitted = () => {
                    this.submitted = true;
                    this.update();
                };
                window.addEventListener("brightspark:lead-success", this.onSubmitted);

                this.update();
            },

            update() {
                this.show = !this.submitted && !this.formVisible && window.scrollY > 280;
            },

            destroy() {
                window.removeEventListener("scroll", this.onScroll);
                window.removeEventListener("brightspark:lead-success", this.onSubmitted);
            }
        }));
    });
})();