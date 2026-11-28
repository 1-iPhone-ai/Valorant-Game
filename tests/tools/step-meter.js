'use strict';
// V2.3 (WP10) step-meter: the perceived loudness of an enemy footstep (or any short sound the game makes), shared by
// tests/tools/audio-render.js and tests/audio-identity.test.js. A tool module, not a test.
//
// Why weighted: V2.2's enemy step is a thud (noise low-passed at 520 Hz and a 95 Hz tone), so almost all of its energy
// is below 500 Hz, where the ear is least sensitive; V2.3's surface steps put their noise at 1-3 kHz. Unweighted RMS
// rates the two alike while the ear hears the brighter one as several dB louder, so levels are compared A-weighted
// (IEC 61672-1, the magnitude of the analog weighting, 0 dB at 1 kHz) and K-weighted (ITU-R BS.1770: the high shelf and
// the RLB high-pass, as the 48 kHz biquads' magnitude), as well as unweighted.
//
// install (passed to page.evaluate after the first user gesture, with soundFX.ctx live) defines window.__meter:
//   render(seconds, fn, u)   renders what fn plays offline: soundFX.ctx is an OfflineAudioContext at the live rate,
//                            soundFX._out a gain on it (dry: no shared reverb), a level listener (at the camera's x and z,
//                            1.6 m up, facing the camera's heading, up +y: the geometry does not follow the camera's
//                            pitch, since the HRTF colours a bright step more than a dull one), no wall between
//                            (isOccluded false), and Math.random answers u (a number) while fn runs (an enemy step draws
//                            exactly one: its noise offset); everything is restored at once. -> [L, R]
//   weigh(chs, rate)         { plain, a, k }: the energies (sum of squares over the channels, by Parseval from one FFT
//                            per channel, zero-padded to a power of two), unweighted, A-weighted and K-weighted
//   energy(fn, n, seconds)   weigh(render(seconds, fn, u)) averaged over n noise offsets u = (i + 0.5) / n (the mean
//                            over where the noise buffer is read, so one render's segment does not decide the level)
//   step(surf, foot, n)      energy of an enemy step 3 m ahead of the listener (level) at y 0.1 (inside soundFX.at, HRTF):
//                            V2.2's (surf null: enemyStep()) or the surface x footwear recipe V23.audio.state.step
//                            builds (what surfAt returns there)
//   table(n)                 every surface x footwear step against V2.2's: rows { surf, foot, plain, a, k } in dB
//                            relative to V2.2's step (positive: louder), plus ref (V2.2's energies)
function install() {
    if (window.__meter) return true;
    // an in-place radix-2 FFT
    function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
            for (let i = 0; i < n; i += len) {
                let cr = 1, ci = 0;
                for (let k = 0; k < h; k++) {
                    const a = i + k, b = a + h, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
                    const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
                }
            }
        }
    }
    // A-weighting (IEC 61672-1): the analog magnitude, +2.0 dB so that 1 kHz is 0 dB; squared for power
    const A2 = (f) => {
        const f2 = f * f, ra = (12194 * 12194 * f2 * f2) / ((f2 + 20.6 * 20.6) * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) * (f2 + 12194 * 12194));
        const a = ra * 1.2589254;
        return a * a;
    };
    // K-weighting (ITU-R BS.1770): stage 1 high shelf and stage 2 RLB high-pass, [b0, b1, b2, a1, a2] at 48 kHz; the
    // power response at f (below 24 kHz) is the product of the two biquads' |H(e^jw)|^2 with w = 2 pi f / 48000
    const KS = [[1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
        [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621]];
    const biq2 = (c, w) => {
        const c1 = Math.cos(w), c2 = Math.cos(2 * w), s1 = Math.sin(w), s2 = Math.sin(2 * w);
        const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2), dr = 1 + c[3] * c1 + c[4] * c2, di = -(c[3] * s1 + c[4] * s2);
        return (nr * nr + ni * ni) / (dr * dr + di * di);
    };
    const K2 = (f) => { const w = 2 * Math.PI * Math.min(f, 23999) / 48000; return biq2(KS[0], w) * biq2(KS[1], w); };
    const WCACHE = {};
    function weights(n, rate) {
        const key = n + '@' + rate;
        if (WCACHE[key]) return WCACHE[key];
        const wa = new Float64Array(n), wk = new Float64Array(n);
        for (let j = 0; j < n; j++) { const f = (j <= n / 2 ? j : n - j) * rate / n; wa[j] = A2(f); wk[j] = K2(f); }
        return (WCACHE[key] = { wa, wk });
    }
    function weigh(chs, rate) {
        let len = 0;
        for (const x of chs) len = Math.max(len, x.length);
        let n = 1;
        while (n < len) n <<= 1;
        const W = weights(n, rate);
        let plain = 0, a = 0, k = 0;
        for (const x of chs) {
            const re = new Float64Array(n), im = new Float64Array(n);
            for (let i = 0; i < x.length; i++) re[i] = x[i];
            fft(re, im);
            for (let j = 0; j < n; j++) { const p = re[j] * re[j] + im[j] * im[j]; plain += p; a += p * W.wa[j]; k += p * W.wk[j]; }
        }
        return { plain: plain / n, a: a / n, k: k / n };   // Parseval: sum x^2 = (1/n) sum |X|^2
    }
    async function render(seconds, fn, u) {
        const rate = soundFX.ctx.sampleRate, off = new OfflineAudioContext(2, Math.ceil(rate * seconds), rate), mix = off.createGain();
        mix.connect(off.destination);
        const keep = { ctx: soundFX.ctx, out: soundFX._out, pos: soundFX._pos, occ: soundFX.isOccluded, rnd: Math.random };
        soundFX.ctx = off;
        level(off.listener);
        soundFX._out = mix;
        soundFX._pos = null;
        soundFX.isOccluded = () => false;
        if (typeof u === 'number') Math.random = () => u;
        try { fn(); } finally {
            Math.random = keep.rnd;
            soundFX.ctx = keep.ctx; soundFX._out = keep.out; soundFX._pos = keep.pos; soundFX.isOccluded = keep.occ;
        }
        const buf = await off.startRendering();
        return [buf.getChannelData(0), buf.getChannelData(1)];
    }
    async function energy(fn, n, seconds) {
        const N = Math.max(1, n || 16), rate = soundFX.ctx.sampleRate, acc = { plain: 0, a: 0, k: 0 };
        for (let i = 0; i < N; i++) {
            const w = weigh(await render(seconds || 0.5, fn, (i + 0.5) / N), rate);
            acc.plain += w.plain / N; acc.a += w.a / N; acc.k += w.k / N;
        }
        return acc;
    }
    // the camera's heading on the ground plane (its pitch dropped)
    function heading() {
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), h = Math.hypot(f.x, f.z);
        return h > 1e-6 ? [f.x / h, f.z / h] : [0, -1];
    }
    function level(L) {
        const p = camera.position, f = heading(), set = (prm, v) => { prm.value = v; };
        if (L.positionX) {
            set(L.positionX, p.x); set(L.positionY, 1.6); set(L.positionZ, p.z);
            set(L.forwardX, f[0]); set(L.forwardY, 0); set(L.forwardZ, f[1]);
            set(L.upX, 0); set(L.upY, 1); set(L.upZ, 0);
        } else { L.setPosition(p.x, 1.6, p.z); L.setOrientation(f[0], 0, f[1], 0, 1, 0); }
    }
    function ahead(d) {
        const f = heading();
        return [camera.position.x + f[0] * d, camera.position.z + f[1] * d];
    }
    function step(surf, foot, n) {
        const p = ahead(3), kind = surf ? V23.audio.state.step(surf, foot) : null;
        return energy(() => soundFX.at(p[0], 0.1, p[1], () => soundFX.enemyStep(kind)), n, 0.35);   // the longest step (a metal ring) ends by 0.2 s
    }
    async function table(n) {
        const ref = await step(null, null, n), rows = [], db = (x, r) => +(10 * Math.log10(x / r)).toFixed(2);
        for (const surf of Object.keys(V23.audio.state.surfSteps)) for (const foot of Object.keys(V23.audio.state.footwear)) {
            const e = await step(surf, foot, n);
            rows.push({ surf, foot, plain: db(e.plain, ref.plain), a: db(e.a, ref.a), k: db(e.k, ref.k) });
        }
        return { ref, rows };
    }
    window.__meter = { render, weigh, energy, step, table, ahead };
    return true;
}

module.exports = { install };
