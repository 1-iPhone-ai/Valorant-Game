#!/usr/bin/env node
'use strict';
// V2.3 (WP10) audio-render: renders Sage's and Omen's palette sounds to WAV files and reports their peak and RMS levels
// (a tool, not a test; listening is not verifiable in this environment, so the files are for a person to hear).
//
// Usage (from the repository root): NODE_PATH=tests/node_modules node tests/tools/audio-render.js --out <dir>
//   [--file '(V2.3) valorant-fps.html'] [--only sage.motif.c,omen.ult]
// How: the game boots once (tests/harness.js); a click (the first user gesture) makes the AudioContext and the shared
// noise and reverb buffers (V23.audio.prebuild). Each sound is then rendered offline: soundFX.ctx is swapped for an
// OfflineAudioContext at the live sample rate and soundFX._out for a gain on it, so every voice the game builds for
// that call lands in the offline graph (with _out set, soundFX._route skips the live shared reverb; the renders are dry)
// and the listener is copied from the camera for the positional ones; soundFX.ctx and _out are restored at once and
// the offline context renders. Each render is written as 16-bit PCM stereo WAV, with its peak, RMS over the file and
// RMS over the part that sounds (from the first to the last sample above -80 dBFS), in dBFS.
// Renders: the motif for C, Q and E, the ultimate sting, the previews (intro, the single cues, an ability preview with
// the cast's own method), a bot's 300 ms warning sting and the mortar arming (positional), the V2.2 per-ability sounds
// the motifs sit under (iceWall, omenTeleport, ult), and enemy steps (V2.2's, and surface x footwear recipes).
const path = require('path'), fs = require('fs'), os = require('os');
const { boot, closeBrowser } = require(path.join(__dirname, '..', 'harness'));

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const eq = a.indexOf('='); if (eq > 0) opt[a.slice(2, eq)] = a.slice(eq + 1); else { opt[a.slice(2)] = argv[i + 1]; i++; } } }
const OUT = path.resolve(opt.out || path.join(os.tmpdir(), 'v23-wav'));
const ONLY = opt.only ? new Set(String(opt.only).split(',')) : null;
fs.mkdirSync(OUT, { recursive: true });

// name, seconds, the page-side call (a string evaluated in the page, with soundFX.ctx the offline context)
const RENDERS = [
    ['sage.motif.c', 1.2, "V23.audio.motif('sage', 'c')"], ['sage.motif.q', 1.2, "V23.audio.motif('sage', 'q')"], ['sage.motif.e', 1.2, "V23.audio.motif('sage', 'e')"],
    ['omen.motif.c', 1.2, "V23.audio.motif('omen', 'c')"], ['omen.motif.q', 1.2, "V23.audio.motif('omen', 'q')"], ['omen.motif.e', 1.2, "V23.audio.motif('omen', 'e')"],
    ['sage.ult', 2.0, "V23.audio.ultSting('sage')"], ['omen.ult', 2.0, "V23.audio.ultSting('omen')"],
    ['sage.preview.intro', 2.8, "V23.audio.preview('sage', 'intro')"], ['omen.preview.intro', 2.4, "V23.audio.preview('omen', 'intro')"],
    ['sage.preview.chime', 2.2, "V23.audio.preview('sage', 'chime')"], ['omen.preview.tear', 0.8, "V23.audio.preview('omen', 'tear')"], ['omen.preview.clack', 0.4, "V23.audio.preview('omen', 'clack')"],
    ['sage.preview.c', 1.4, "V23.audio.preview('sage', 'c')"], ['omen.preview.x', 2.2, "V23.audio.preview('omen', 'x')"],
    ['sage.bot.arm.mortar', 0.9, "__cue('sage', 'arm.mortar')"], ['omen.bot.warn.flash', 0.9, "__cue('omen', 'windup.flash')"], ['omen.bot.cast.smoke', 1.0, "__cue('omen', 'cast.smoke')"],
    ['v22.iceWall', 1.2, 'soundFX.iceWall()'], ['v22.omenTeleport', 1.2, 'soundFX.omenTeleport()'], ['v22.ult', 1.2, 'soundFX.ult()'],
    ['step.v22', 0.5, '__step(null)'], ['step.concrete.boot', 0.5, "__step('concrete', 'boot')"], ['step.metal.plated', 0.5, "__step('metal', 'plated')"],
    ['step.wood.soft', 0.5, "__step('wood', 'soft')"], ['step.stone.heavy', 0.5, "__step('stone', 'heavy')"], ['step.snow.runner', 0.5, "__step('snow', 'runner')"]
].filter((r) => !ONLY || ONLY.has(r[0]));

function wav(int16, channels, rate) {
    const data = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength), h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
    h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
}

(async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', file: opt.file, initScript: () => { Element.prototype.requestPointerLock = function () {}; document.exitPointerLock = function () {}; } });
    await page.mouse.click(5, 5);   // the first user gesture: V23.audio.prebuild makes the context and the shared buffers
    await frames(2);
    const ready = await evaluate(() => {
        game.soundEnabled = true;
        if (!soundFX.ctx) V23.audio.prebuild();
        window.updateEnemies = () => {};
        // a stand-in bot for the cues, 6 m in front of the camera (the cue's agent from its look; no game state is touched)
        window.__cue = (agent, kind) => {
            const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            const at = { x: camera.position.x + f.x * 6, y: 0, z: camera.position.z + f.z * 6 };
            const e = { agentId: agent, slot: 99, generation: 0, mesh: { position: at } };
            if (kind === 'arm.mortar') V23.audio.botCue(e, kind, { x: at.x - f.x * 3, y: 0.07, z: at.z - f.z * 3 }); else V23.audio.botCue(e, kind);
        };
        // an enemy step 3 m in front of the camera: V2.2's (null) or a surface x footwear recipe from V23.audio.state
        window.__step = (surf, foot) => {
            const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            const x = camera.position.x + f.x * 3, z = camera.position.z + f.z * 3;
            let kind = null;
            if (surf) { const S = V23.audio.state.surfSteps[surf], W = V23.audio.state.footwear[foot]; kind = { surf, foot, noise: S.noise, tones: S.tones.concat(W).slice(0, 3), mix: S.mix }; }
            soundFX.at(x, 0.1, z, () => soundFX.enemyStep(kind));
        };
        window.__render = async (seconds, code) => {
            const live = soundFX.ctx, rate = live.sampleRate;
            const off = new OfflineAudioContext(2, Math.ceil(rate * seconds), rate), mix = off.createGain();
            mix.connect(off.destination);
            const keep = { ctx: soundFX.ctx, out: soundFX._out, pos: soundFX._pos };
            soundFX.ctx = off;
            soundFX.updateListener();   // the offline listener where the camera is
            soundFX._out = mix;
            soundFX._pos = null;
            try { (0, eval)(code); } finally { soundFX.ctx = keep.ctx; soundFX._out = keep.out; soundFX._pos = keep.pos; }
            const buf = await off.startRendering();
            const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, n = L.length;
            let peak = 0, sum = 0, first = -1, last = -1;
            const pcm = new Int16Array(n * 2);
            for (let i = 0; i < n; i++) {
                const a = L[i], b = R[i], m = Math.max(Math.abs(a), Math.abs(b));
                if (m > peak) peak = m;
                if (m > 1e-4) { if (first < 0) first = i; last = i; }
                sum += a * a + b * b;
                pcm[2 * i] = Math.max(-32768, Math.min(32767, Math.round(a * 32767)));
                pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(b * 32767)));
            }
            let act = 0;
            for (let i = Math.max(0, first); i <= last; i++) act += L[i] * L[i] + R[i] * R[i];
            const db = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -Infinity);
            const bytes = new Uint8Array(pcm.buffer);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            return { rate, n, peak: db(peak), rms: db(Math.sqrt(sum / (2 * n))), rmsActive: first < 0 ? -Infinity : db(Math.sqrt(act / (2 * (last - first + 1)))),
                activeS: first < 0 ? 0 : +((last - first + 1) / rate).toFixed(3), b64: btoa(bin) };
        };
        return { rate: soundFX.ctx && soundFX.ctx.sampleRate, prebuilt: V23.audio.state.prebuilt, identity: V23.core.enabled() };
    });
    console.log(`context ${ready.rate} Hz, prebuilt ${ready.prebuilt}, identity ${ready.identity ? 'on' : 'off'}; writing to ${OUT}`);
    const rows = [];
    for (const [name, seconds, code] of RENDERS) {
        const r = await page.evaluate(([s, c]) => __render(s, c), [seconds, code]);
        const int16 = new Int16Array(new Uint8Array(Buffer.from(r.b64, 'base64')).buffer);
        const file = path.join(OUT, name + '.wav');
        fs.writeFileSync(file, wav(int16, 2, r.rate));
        rows.push({ name, seconds, peak: r.peak, rms: r.rms, rmsActive: r.rmsActive, activeS: r.activeS, file });
        console.log(`${name.padEnd(22)} peak ${String(r.peak).padStart(6)} dBFS  rms ${String(r.rms).padStart(6)} dBFS  active rms ${String(r.rmsActive).padStart(6)} dBFS over ${r.activeS} s`);
    }
    fs.writeFileSync(path.join(OUT, 'levels.json'), JSON.stringify(rows, null, 1));
    if (errors.length) { console.log('page errors:', errors); process.exitCode = 1; }
    await closeBrowser();
})().catch((e) => { console.error(e); process.exit(1); });
