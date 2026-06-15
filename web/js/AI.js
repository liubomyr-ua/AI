/**
 * AI plugin — browser-side bootstrap.
 *
 * Loaded into every page that has the AI plugin enabled (via
 * AI/handlers/AI/before/Q_responseExtras.php).
 *
 * Responsibilities:
 *
 *   1. Install the configured Q.Speech.Recognition backend.
 *      The Deepgram adapter at AI/web/js/AI/Speech/Deepgram.js implements
 *      the { start, stop, abort } interface that
 *      Q.Speech.Recognition.implement() expects. Until this bootstrap
 *      runs, the browser default backend is what callers like
 *      Media's control.js _startMic() get. With the adapter installed,
 *      the same caller code routes through Deepgram instead.
 *
 *      Provider is picked from Q.plugins.AI.speech.provider, which
 *      Q_responseExtras.php injects from server config
 *      `AI/speech/provider`. Set to null to keep the browser default.
 *
 *      The install happens on Q.onInit (before user gestures), so by the
 *      time a tool's first mic-tap fires, the adapter is already in
 *      place. Q.Speech.Recognition.start() then routes through it.
 *
 *   2. Provide the AI namespace on the client side.
 *      AI.Speech.Deepgram and similar adapters attach themselves into
 *      this namespace as they load.
 *
 * @module AI
 */
"use strict";

(function (Q, $) {

    Q.text.AI = Q.text.AI || {};
    Q.Text.addFor(['Q.Tool.define', 'Q.Template.set'], 'AI/', ['AI/content']);

    var AI = Q.AI = Q.plugins.AI = Q.plugins.AI || {};

    /**
     * Install the configured speech-recognition adapter onto
     * Q.Speech.Recognition. Idempotent — safe to call more than once.
     *
     * Reads Q.plugins.AI.speech for { provider, sampleRate, chunkMs }.
     * If provider is null/undefined/'browser', leaves the browser default
     * in place.
     *
     * @method installSpeechAdapter
     * @static
     */
    AI.installSpeechAdapter = function () {
        if (AI._speechInstalled) return;
        AI._speechInstalled = true;

        var cfg = (AI.speech || {});
        var provider = cfg.provider;
        if (!provider || provider === 'browser') return;

        if (provider !== 'deepgram') {
            console.warn('AI: unsupported speech provider "' + provider + '"');
            return;
        }

        // Wait for Q.Speech.Recognition to exist before installing.
        // It's defined by Q core; the loader file lives elsewhere and is
        // safe to invoke here — calling it with a callback both loads it
        // if needed and gives us the moment to install our adapter.
        if (!Q.Speech || !Q.Speech.Recognition) {
            console.warn('AI: Q.Speech.Recognition not available; skipping speech adapter install');
            return;
        }

        Q.Speech.Recognition(function () {
            Q.require(Q.url('{{AI}}/js/AI/Speech/Deepgram.js'), function (Deepgram) {
                if (!Deepgram && Q.AI && Q.AI.Speech && Q.AI.Speech.Deepgram) {
                    Deepgram = Q.AI.Speech.Deepgram;
                }
                if (!Deepgram) {
                    console.warn('AI: failed to load Deepgram adapter');
                    return;
                }
                try {
                    var adapter = new Deepgram({
                        socketNs:   '/Q',
                        socketUrl:  (Q.info && Q.info.nodeUrl) || '',
                        sampleRate: cfg.sampleRate || 16000,
                        chunkMs:    cfg.chunkMs    || 100
                    });
                    Q.Speech.Recognition.implement(adapter);
                    AI._speechAdapter = adapter;
                } catch (e) {
                    console.warn('AI: speech adapter install failed:', e && e.message);
                }
            });
        });
    };

    /**
     * Uninstall the speech adapter, reverting to the browser default.
     * @method uninstallSpeechAdapter
     * @static
     */
    AI.uninstallSpeechAdapter = function () {
        if (!AI._speechInstalled) return;
        AI._speechInstalled = false;
        if (Q.Speech && Q.Speech.Recognition && Q.Speech.Recognition.unimplement) {
            try { Q.Speech.Recognition.unimplement(); } catch (e) {}
        }
        AI._speechAdapter = null;
    };

    Q.onInit.add(function () {
        AI.installSpeechAdapter();
    }, 'AI');

})(Q, Q.jQuery);
