'use strict';
// V2.3 benchmark tool (DESIGN.md section 18). A command-line tool, NOT a test: CI runs `node --test` in tests/
// with Node's default patterns (*.test.js and the like), which do not match tests/tools/bench.js.
//
// Run from the repository root (it uses tests/harness.js and the tests' node_modules):
//   NODE_PATH=tests/node_modules node tests/tools/bench.js --mode D --a '(V2.2) valorant-fps.html' --b '(V2.3) valorant-fps.html'
//   NODE_PATH=tests/node_modules node tests/tools/bench.js --mode R --seconds 60 --res --out /tmp/bench-r.json
//   ... --quick            smoke check: 300 frames, 1 pair (Mode R records 300 frames)
//   ... --bOpts '{"enhancedAnim":true}'   a variant: settings applied after boot (see --help)
// Mode D (default) drives the game's frames itself on a fixed 1000/60 clock with Math.random seeded, so both
// builds render the same frames; Mode R measures the real requestAnimationFrame loop with perfTelemetry.
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..');
const harness = require(path.join(REPO, 'tests', 'harness.js'));

const HELP = `V2.3 benchmark tool (tests/tools/bench.js)

  --mode D|R        D: deterministic driver and scripted route (default); R: the real rAF loop
  --a <file>        build A (default '(V2.2) valorant-fps.html'); a path from the cwd or the repository root
  --b <file>        build B (default '(V2.3) valorant-fps.html'); 'none' runs build A only
  --pairs <n>       interleaved pairs A B, B A, A B ... (default 5); each run is a fresh browser and the
                    first pair is discarded when there is more than one (--keep-first keeps it)
  --frames <n>      Mode D: route length in frames (default 3600). Mode R: record n frames instead of --seconds
  --seconds <s>     Mode R: recording time (default 60)
  --warm <n>        Mode R: frames before perfTelemetry.reset (default 300)
  --res             960x540 instead of 480x270 (dpr 1); --viewport WxH for any other size
  --aOpts/--bOpts   JSON applied after boot. Keys: enhancedAnim (bool), highDetail (bool), quality, botAbilityAI,
                    wingmen, js (code run in the page), or any game.userSettings field (then applyAllSettings)
  --aPre/--bPre     JSON merged into the saved settings written before load (contentTierMode and the like)
  --quick           smoke check: 300 frames and 1 pair
  --out <file>      JSON report (per run, per build, ratios, the frame hashes)
  --chunk <n>       Mode D: frames per page call (default 60)
  --hash-every <n>  Mode D: frames between frame hashes (default frames/24, at least 15)
  --seed <n>        Math.random seed (default 20221)
  --min-health <n>  damage to you is clamped to keep this much health (default 25), except the forced death
  --trace           print where you were at each hashed frame (Mode D)
  --no-render       Mode D route check only: nothing is drawn (frame times are meaningless)
`;

// ---- options ------------------------------------------------------------------------------------------------
function parseArgs(argv) {
    const o = {
        mode: 'D', a: '(V2.2) valorant-fps.html', b: '(V2.3) valorant-fps.html', pairs: 5, frames: null, seconds: 60, warm: 300,
        viewport: { width: 480, height: 270 }, aOpts: {}, bOpts: {}, aPre: {}, bPre: {}, out: null, quick: false, chunk: 60,
        hashEvery: null, seed: 20221, minHealth: 25, trace: false, keepFirst: false, framesGiven: false, pairsGiven: false, noRender: false
    };
    const json = (k, v) => { try { return JSON.parse(v); } catch (e) { throw new Error(k + ': not JSON: ' + v); } };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const val = () => { if (i + 1 >= argv.length) throw new Error(k + ' needs a value'); return argv[++i]; };
        switch (k) {
            case '--mode': o.mode = val().toUpperCase(); break;
            case '--a': o.a = val(); break;
            case '--b': o.b = val(); break;
            case '--pairs': o.pairs = Math.max(1, parseInt(val(), 10)); o.pairsGiven = true; break;
            case '--frames': o.frames = Math.max(2, parseInt(val(), 10)); o.framesGiven = true; break;
            case '--seconds': o.seconds = Math.max(1, parseFloat(val())); break;
            case '--warm': o.warm = Math.max(0, parseInt(val(), 10)); break;
            case '--res': o.viewport = { width: 960, height: 540 }; break;
            case '--viewport': { const m = /^(\d+)x(\d+)$/.exec(val()); if (!m) throw new Error('--viewport WxH'); o.viewport = { width: +m[1], height: +m[2] }; break; }
            case '--aOpts': o.aOpts = json(k, val()); break;
            case '--bOpts': o.bOpts = json(k, val()); break;
            case '--aPre': o.aPre = json(k, val()); break;
            case '--bPre': o.bPre = json(k, val()); break;
            case '--quick': o.quick = true; break;
            case '--out': o.out = val(); break;
            case '--chunk': o.chunk = Math.max(1, parseInt(val(), 10)); break;
            case '--hash-every': o.hashEvery = Math.max(1, parseInt(val(), 10)); break;
            case '--seed': o.seed = parseInt(val(), 10) || 20221; break;
            case '--min-health': o.minHealth = Math.max(1, parseInt(val(), 10)); break;
            case '--trace': o.trace = true; break;
            case '--keep-first': o.keepFirst = true; break;
            case '--no-render': o.noRender = true; break;
            case '-h': case '--help': console.log(HELP); process.exit(0); break;
            default: throw new Error('unknown option ' + k + ' (see --help)');
        }
    }
    if (o.mode !== 'D' && o.mode !== 'R') throw new Error('--mode is D or R');
    if (o.quick) { if (!o.framesGiven) o.frames = 300; if (!o.pairsGiven) o.pairs = 1; }
    if (o.mode === 'D' && !o.frames) o.frames = 3600;
    if (!o.hashEvery) o.hashEvery = Math.max(15, Math.round((o.frames || 3600) / 24));
    o.aFile = resolveBuild(o.a);
    o.bFile = /^none$/i.test(o.b) ? null : resolveBuild(o.b);
    return o;
}
function resolveBuild(f) {
    const cands = path.isAbsolute(f) ? [f] : [path.resolve(process.cwd(), f), path.resolve(REPO, f)];
    for (const c of cands) if (fs.existsSync(c)) return c;
    throw new Error('build not found: ' + f);
}

// ---- in the page, before any game script (page.addInitScript through the harness) --------------------------
// Writes the saved settings the game reads at startup (settingsManager.LS_CONSENT_KEY / LS_DATA_KEY, and the
// Content Tier read by readSavedContentTier), seeds Math.random for the boot, wraps requestAnimationFrame to
// record renderer.info after every frame (Mode R), and in Mode D keeps a list of the real timers still pending
// so the driver can take them over.
const PRE_INIT = (cfg) => {
    try {
        localStorage.setItem('valorant_v16_ls_consent', 'true');
        localStorage.setItem('valorant_v16_user_settings', JSON.stringify(cfg.settings));
    } catch (e) { window.__benchStorageError = String(e && e.message || e); }
    window.__benchRealPerf = performance.now.bind(performance);
    if (cfg.seed) {
        let s = cfg.seed >>> 0 || 1;
        window.__benchBootRandom = true;
        Math.random = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }
    const realRAF = window.requestAnimationFrame.bind(window);
    const N = 60000;
    const rec = window.__benchRec = { on: false, n: 0, N, calls: new Float32Array(N), tris: new Float32Array(N), progs: new Float32Array(N), look: null };
    window.requestAnimationFrame = function (cb) {
        return realRAF(function (t) {
            if (rec.look) { try { rec.look(); } catch (e) { /* the page is not built yet */ } }
            cb(t);
            if (rec.on && rec.n < N) {
                try {
                    const r = renderer.info.render;
                    rec.calls[rec.n] = r.calls; rec.tris[rec.n] = r.triangles;
                    rec.progs[rec.n] = renderer.info.programs ? renderer.info.programs.length : 0;
                    rec.n++;
                } catch (e) { /* renderer not there yet */ }
            }
        });
    };
    if (cfg.track) {
        const rST = window.setTimeout.bind(window), rSI = window.setInterval.bind(window);
        const rCT = window.clearTimeout.bind(window), rCI = window.clearInterval.bind(window);
        const pend = window.__benchPending = new Map();
        window.__benchReal = { setTimeout: rST, setInterval: rSI, clearTimeout: rCT, clearInterval: rCI };
        const call = (fn, args) => (typeof fn === 'function' ? fn.apply(window, args) : (0, eval)(String(fn)));
        window.setTimeout = function (fn, ms, ...args) {
            let id = 0;
            id = rST(() => { pend.delete(id); call(fn, args); }, ms);
            pend.set(id, { fn, args, due: performance.now() + Math.max(0, +ms || 0), every: 0 });
            return id;
        };
        window.setInterval = function (fn, ms, ...args) {
            const every = Math.max(1, +ms || 0);
            const ent = { fn, args, due: performance.now() + every, every };
            const id = rSI(() => { ent.due += every; call(fn, args); }, ms);
            pend.set(id, ent);
            return id;
        };
        window.clearTimeout = function (id) { pend.delete(id); return rCT(id); };
        window.clearInterval = function (id) { pend.delete(id); return rCI(id); };
    }
};

// ---- in the page, after boot: setup, variants, Mode R recording, the Mode D driver and route --------------
const PAGE_LIB = () => {
    if (window.__bench) return true;
    const B = window.__bench = { allowDeath: false, damageClamped: 0, damageCalls: 0 };
    const realPerf = window.__benchRealPerf || performance.now.bind(performance);
    const f5 = (v) => (typeof v === 'number' ? +v.toFixed(5) : v);
    const p3 = (o) => (o && o.position ? [f5(o.position.x), f5(o.position.y), f5(o.position.z)] : null);
    const fnvBytes = (b) => { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
    const fnvStr = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
    const has = (name) => { try { return typeof (0, eval)(name) !== 'undefined'; } catch (e) { return false; } };

    // What is set and what exists (reported, so a missing hook shows up instead of being assumed)
    B.info = () => {
        const gl = renderer.getContext(), us = game.userSettings || {};
        return {
            contentTier: has('contentTier') ? contentTier : null,
            contentTierChoice: has('contentTierChoice') ? contentTierChoice : null,
            enemiesPerTier: has('CONTENT') ? CONTENT.enemies : null,
            quality: adaptiveSettings.currentQuality, autoQuality: qualityController.auto,
            map: game.mapPreset, mode: game.gameMode, botAbilityAI: game.botAbilityAI,
            enemies: enemyObjects.length,
            wingmen: (tacticalEnhancements.wingmanBots || []).length, wingmenOn: !!tacticalEnhancements.wingmanEnabled,
            agent: game.activeAgent, weapon: game.activeWeapon,
            pixelRatio: renderer.getPixelRatio(), buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
            webgl2: !!(renderer.capabilities && renderer.capabilities.isWebGL2),
            shaderWarmupMs: typeof perfTelemetry.shaderWarmupMs === 'number' ? perfTelemetry.shaderWarmupMs : null,
            programs: renderer.info.programs ? renderer.info.programs.length : 0, watermark: perfTelemetry.programWatermark, stalls: perfTelemetry.firstUseStalls,
            saved: { qualityMode: us.qualityMode, contentTierMode: us.contentTierMode, skipMenu: us.skipMenu, animDetail: us.animDetail, mapDetail: us.mapDetail,
                charDetail: us.charDetail, abilityEffects: us.abilityEffects, botMechanics: us.botMechanics, localStorageEnabled: us.localStorageEnabled },
            storageError: window.__benchStorageError || null, bootRandomSeeded: !!window.__benchBootRandom,
            hooks: { exportRun: typeof perfTelemetry.exportRun === 'function', reset: typeof perfTelemetry.reset === 'function',
                runFrame: !!perfTelemetry.runFrame, runCpu: !!perfTelemetry.runCpu, setManual: typeof qualityController.setManual === 'function',
                takeDamage: typeof window.takeDamage === 'function', stepSimulation: typeof window.stepSimulation === 'function',
                gameNow: has('gameNow'), startFire: !!(has('gamepadController') && gamepadController.startFire), enhancedAnim: has('enhancedAnim'), abilityLook: has('abilityLook') }
        };
    };

    // Variants: settings applied after boot
    B.applyOpts = (o) => {
        const res = { applied: [], unknown: [], errors: [] };
        if (!o || typeof o !== 'object') return res;
        const us = game.userSettings;
        let apply = false, refreshLook = false;
        for (const k of Object.keys(o)) {
            const v = o[k];
            try {
                if (k === 'enhancedAnim') { us.animDetail = v ? 'on' : 'off'; apply = true; }
                else if (k === 'highDetail') { us.mapDetail = v ? 'on' : 'off'; us.charDetail = v ? 'on' : 'off'; apply = true; }
                else if (k === 'quality') { us.qualityMode = String(v); apply = true; }
                else if (k === 'botAbilityAI') tacticalDirector.toggleBotAbilityAI(!!v);
                else if (k === 'wingmen') tacticalEnhancements.toggleWingmanAI(!!v);
                else if (k === 'js') (0, eval)(String(v));
                else {
                    const known = (k in us) || (has('DEFAULT_USER_SETTINGS') && k in DEFAULT_USER_SETTINGS);
                    if (!known) res.unknown.push(k);
                    us[k] = v; apply = true;
                    if (k === 'abilityEffects') refreshLook = true;
                }
                res.applied.push(k);
            } catch (e) { res.errors.push(k + ': ' + e.message); }
        }
        if (apply) { try { settingsManager.applyAllSettings(false); } catch (e) { res.errors.push('applyAllSettings: ' + e.message); } }
        if (refreshLook && has('abilityLook') && abilityLook.refresh) { try { abilityLook.refresh(); } catch (e) { res.errors.push('abilityLook.refresh: ' + e.message); } }
        res.state = {
            quality: adaptiveSettings.currentQuality, autoQuality: qualityController.auto,
            enhancedAnim: has('enhancedAnim') ? !!enhancedAnim.on : null, look: has('abilityLook') ? abilityLook.mode : null,
            mapDetail: us.mapDetail, charDetail: us.charDetail, botAbilityAI: game.botAbilityAI
        };
        return res;
    };

    // The common start: Ascent, Wave reset, Bot Ability AI on, you at the route's start, no ability item out,
    // casts never run out, the replay recorder empty (a kill cam then replays only what the run recorded)
    B.setup = (s) => {
        if (game.mapPreset !== 'ascent') tacticalDirector.cycleMapPreset('ascent');
        if (!game.botAbilityAI) tacticalDirector.toggleBotAbilityAI(true);
        game.userSettings.infiniteAbilities = true;
        game.userSettings.infiniteUlt = true;
        const end = (it) => { if (!it || typeof it !== 'object' || it.isObject3D) return; if ('expireAt' in it) it.expireAt = 1; if ('endTime' in it) it.endTime = 1; if ('executeAt' in it) it.executeAt = 1; };
        for (const key of Object.keys(agentSystem)) {
            const v = agentSystem[key];
            if (Array.isArray(v)) { for (const it of v) if (it && typeof it === 'object' && ('inUse' in it || 'active' in it)) end(it); }
            else if (v && typeof v === 'object' && ('inUse' in v || 'active' in v)) end(v);
        }
        if (agentSystem.projectiles) for (const p of agentSystem.projectiles) if (p.inUse) { p.inUse = false; p.mesh.visible = false; }
        game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
        if (castFX.active) { castFX.active = null; castFX.hide(); }
        tacticalDirector.setGameMode('wave');
        agentSystem.selectAgent(s.agent || 'sage');
        const cc = characterController;
        cc.position.set(s.at[0], s.at[1], s.at[2]); cc.prevSimPosition.copy(cc.position); if (cc.velocity) cc.velocity.set(0, 0, 0);
        camera.position.copy(cc.position);
        camera.rotation.set(s.aim[0], s.aim[1], 0, 'YXZ');
        if (cc.targetRotation) cc.targetRotation.y = s.aim[1];
        game.health = 100; game.shield = 50; game.isDead = false;
        (tacticalEnhancements.wingmanBots || []).forEach((w, i) => {
            w.patrolPhase = i * Math.PI; w.lastFireAt = 0;
            w.group.position.set(cc.position.x + w.offsetX, 0, cc.position.z + w.offsetZ); w.group.rotation.set(0, 0, 0);
        });
        if (has('replayRec') && replayRec.init) { replayRec.init(); replayRec.lastAt = -1e9; }
        return { map: game.mapPreset, mode: game.gameMode, agent: game.activeAgent, enemies: enemyObjects.length };
    };

    // Damage to you is clamped to keep minHealth (the forced death sets allowDeath)
    B.installClamp = (minHealth) => {
        if (B._clamp) return true;
        const real = window.takeDamage;
        if (typeof real !== 'function') return false;
        window.takeDamage = function (amount) {
            const args = Array.prototype.slice.call(arguments);
            B.damageCalls++;
            if (!B.allowDeath && typeof amount === 'number') {
                const room = Math.max(0, game.health - minHealth);
                if (amount > room) { B.damageClamped += amount - room; args[0] = room; }
            }
            return real.apply(this, args);
        };
        B._clamp = true;
        return true;
    };

    // ---- Mode R ----
    B.startLook = (base) => {
        window.__benchRec.look = () => {
            const f = frameIndex, y = base + 0.55 * Math.sin(f / 95);
            camera.rotation.set(-0.03 + 0.03 * Math.sin(f / 61), y, 0, 'YXZ');
            characterController.targetRotation.y = y;
        };
        return true;
    };
    B.recStart = () => {
        const rec = window.__benchRec;
        perfTelemetry.reset(performance.now());
        rec.n = 0; rec.on = true;
        B.recT0 = realPerf();
        return true;
    };
    B.recStop = () => {
        const rec = window.__benchRec;
        rec.on = false;
        const n = perfTelemetry.runCount;
        const out = {
            wallMs: realPerf() - B.recT0,
            run: perfTelemetry.exportRun(),
            frame: Array.from(perfTelemetry.runFrame.subarray(0, n), (v) => +v.toFixed(3)),
            cpu: Array.from(perfTelemetry.runCpu.subarray(0, n), (v) => +v.toFixed(3)),
            calls: Array.from(rec.calls.subarray(0, rec.n)), tris: Array.from(rec.tris.subarray(0, rec.n)), progs: Array.from(rec.progs.subarray(0, rec.n)),
            stalls: perfTelemetry.firstUseStalls, glBufferDataBytes: perfTelemetry.glBufferDataBytes, glUploadBytes: perfTelemetry.glUploadBytes,
            clamped: B.damageClamped, damageCalls: B.damageCalls, deaths: game.playerDeaths || 0, round: game.roundNumber,
            quality: adaptiveSettings.currentQuality, autoQuality: qualityController.auto
        };
        return out;
    };

    // ---- Mode D: the driver (the V2.2 everything-off driver's approach) ----
    B.installDriver = () => {
        window.__rafQ = [];
        window.__timers = [];
        window.__timerId = 1e6;
        window.__clock = null;
        const real = window.__benchReal || { setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), clearInterval: window.clearInterval.bind(window) };
        B.realSetTimeout = real.setTimeout;
        // the real timers still pending go into the queue (made due at the first frame, in creation order)
        let taken = 0;
        if (window.__benchPending) {
            for (const [id, t] of window.__benchPending) {
                (t.every ? real.clearInterval : real.clearTimeout)(id);
                __timers.push({ id, at: t.due, fn: t.fn, args: t.args, every: t.every });
                taken++;
            }
            window.__benchPending.clear();
        }
        window.requestAnimationFrame = (cb) => { __rafQ.push(cb); return __rafQ.length; };
        window.cancelAnimationFrame = () => {};
        const addTimer = (fn, ms, args, every) => {
            const id = ++__timerId;
            const at = (__clock === null ? performance.now() : __clock) + Math.max(0, +ms || 0);
            __timers.push({ id, at, fn, args, every: every ? Math.max(1, +ms || 0) : 0 });
            return id;
        };
        window.setTimeout = (fn, ms, ...args) => addTimer(fn, ms, args, false);
        window.setInterval = (fn, ms, ...args) => addTimer(fn, ms, args, true);
        window.clearTimeout = window.clearInterval = (id) => { const i = __timers.findIndex((t) => t.id === id); if (i >= 0) __timers.splice(i, 1); };
        // the sound buffers made on first use take Math.random() calls: made here, before the seeded run
        try {
            const ctx = soundFX.ensureContext && soundFX.ensureContext();
            if (ctx) {
                if (soundFX._ensureReverb) soundFX._ensureReverb(ctx);
                if (!soundFX._noiseBuffer || soundFX._noiseBuffer.sampleRate !== ctx.sampleRate) {
                    const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
                    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
                    soundFX._noiseBuffer = b;
                }
            }
        } catch (e) { B.audioError = e.message; }
        return { takenTimers: taken };
    };

    const runTimers = (errors, k) => {
        for (;;) {
            let best = -1;
            for (let i = 0; i < __timers.length; i++) {
                const t = __timers[i];
                if (t.at <= __clock && (best < 0 || t.at < __timers[best].at || (t.at === __timers[best].at && t.id < __timers[best].id))) best = i;
            }
            if (best < 0) break;
            const t = __timers[best];
            if (t.every) t.at += t.every; else __timers.splice(best, 1);
            try { typeof t.fn === 'function' ? t.fn(...(t.args || [])) : (0, eval)(String(t.fn)); } catch (e) { errors.push(k + ' timer: ' + e.message); }
        }
    };

    // What the game is doing (the driver's snapshot): you, the bots, the wingmen, ability items, hazards, spike, mode
    B.snap = () => {
        const cc = characterController, out = {};
        const cn = has('gameNow') ? gameNow() : performance.now();
        out.you = [p3(cc), f5(cc.velocity ? cc.velocity.x : 0), f5(cc.velocity ? cc.velocity.z : 0), game.health, game.shield, f5(camera.rotation.x), f5(camera.rotation.y)];
        const fx = (e) => (e.blindedUntil > cn ? 'b' : '') + (e.slowedUntil > cn ? 's' : '') + (e.revealedUntil > cn ? 'r' : '') + (e.concussedUntil > cn ? 'c' : '') + (e.suppressedUntil > cn ? 'u' : '');
        out.bots = enemyObjects.map((e) => (e.isActive && !e.hit ? [e.slot, p3(e.mesh), f5(e.mesh.rotation.y), f5(e.health), e.aiState || '', e.archetype || '', fx(e)] : [e.slot, e.isActive ? 1 : 0, e.hit ? 1 : 0]));
        out.wing = (tacticalEnhancements.wingmanBots || []).map((b) => [p3(b.group), f5(b.health)]);
        const items = [];
        for (const k of Object.keys(agentSystem)) {
            const v = agentSystem[k];
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) {
                    const it = v[i];
                    if (!it || typeof it !== 'object' || it.isObject3D) continue;
                    if (it.inUse === true || it.active === true) { const m = it.mesh || it.group; items.push([k, i, p3(m), m && m.scale ? f5(m.scale.x) : null]); }
                }
            } else if (v && typeof v === 'object' && !v.isObject3D && (v.inUse === true || v.active === true)) {
                const m = v.group || v.mesh || v.domeMesh;
                items.push([k, -1, p3(m), m && m.scale ? f5(m.scale.x) : null]);
            }
        }
        out.items = items;
        out.hazards = (tacticalDirector.botHazardsPool || []).filter((h) => h && (h.active || h.inUse)).map((h) => p3(h.mesh || h.group));
        out.spike = [tacticalDirector.spikeState, f5(tacticalDirector.spikePlantProgress || 0), f5(tacticalDirector.spikeDefuseProgress || 0)];
        out.mode = [game.gameMode, game.roundNumber, replayDirector.clip ? replayDirector.clip.kind : 0];
        return out;
    };

    // The scripted route: waypoints walked with the game's own movement (W toward the next point), look sweeps,
    // bursts through the game's fire path, casts, reloads and one forced death, all on fixed frames
    const aimNearest = (R, maxD) => {
        const cc = characterController;
        let best = null, bd = maxD;
        for (const e of enemyObjects) {
            if (!e.isActive || e.hit) continue;
            const d = e.mesh.position.distanceTo(cc.position);
            if (d < bd) { bd = d; best = e; }
        }
        if (!best) return false;
        const dx = best.mesh.position.x - cc.position.x, dz = best.mesh.position.z - cc.position.z, dy = best.mesh.position.y + 1.3 - cc.position.y;
        R.yaw = Math.atan2(-dx, -dz);
        R.pitch = Math.max(-0.6, Math.min(0.4, Math.atan2(dy, Math.hypot(dx, dz))));
        return true;
    };
    const fireStart = () => {
        if (has('gamepadController') && gamepadController.startFire) { gamepadController.startFire(); return; }
        game.mouseDown = true; shoot();
        const w = game.weapons[game.activeWeapon];
        if (w && w.automatic && game.autoShootInterval === null) game.autoShootInterval = setInterval(() => { if (game.mouseDown) shoot(); }, 35);
    };
    const fireStop = () => {
        if (has('gamepadController') && gamepadController.stopFire) { gamepadController.stopFire(); return; }
        game.mouseDown = false;
        if (game.autoShootInterval !== null) { clearInterval(game.autoShootInterval); game.autoShootInterval = null; }
    };
    const alive = () => game.health > 0 && !replayDirector.busy();
    const endUlt = () => { game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0; if (castFX.active) { castFX.active = null; castFX.hide(); } };
    B.routeInit = (spec) => {
        const s = spec.start;
        B.R = { wp: 0, walking: true, yaw: s.aim[1], pitch: s.aim[0], sweep: null, burstUntil: -1, firing: false,
            walkFrames: 0, chkX: s.at[0], chkZ: s.at[2], unstuck: [], casts: [], skipped: [], wpAt: [], deathAt: -1, killer: null };
    };
    B.routeFrame = (k, ev) => {
        const R = B.R, spec = B.D.spec, cc = characterController, W = spec.waypoints;
        const acts = spec.timeline[k];
        if (acts) for (const a of acts) {
            if (a.t === 'sweep') { R.sweep = { k0: k, dur: a.dur, amp: a.amp, base: R.yaw }; ev.push('sweep'); }
            else if (a.t === 'burst') {
                if (alive()) { if (a.aim) aimNearest(R, 35); camera.rotation.set(R.pitch, R.yaw, 0, 'YXZ'); cc.targetRotation.y = R.yaw; camera.updateMatrixWorld(); fireStart(); R.firing = true; R.burstUntil = k + a.dur; ev.push('burst'); }
                else ev.push('skip:burst');
            } else if (a.t === 'agent') { agentSystem.selectAgent(a.id); ev.push('agent:' + a.id); }
            else if (a.t === 'cast') {
                if (alive()) {
                    const slot = a.key.split('.')[1];
                    if (game.activeAgent !== a.key.split('.')[0]) agentSystem.selectAgent(a.key.split('.')[0]);
                    if (typeof a.pitch === 'number') R.pitch = a.pitch;
                    if (a.yawOff) R.yaw += a.yawOff;
                    camera.rotation.set(R.pitch, R.yaw, 0, 'YXZ'); cc.targetRotation.y = R.yaw; camera.updateMatrixWorld();
                    if (slot === 'x') {
                        // one ultimate at a time: an earlier one still running (Sage's Resurrection lasts) ends first
                        if (game.ultActiveUntil > gameNow() || game.ultAgent) { endUlt(); ev.push('ult-ended'); }
                        game.ultPoints = game.maxUltPoints;
                    }
                    agentSystem.castAbility(slot);
                    R.casts.push([k, a.key]); ev.push('cast:' + a.key);
                } else { R.skipped.push([k, a.key]); ev.push('skip:' + a.key); }
            } else if (a.t === 'reload') { reload(); ev.push('reload'); }
            else if (a.t === 'death') {
                let killer = null, bd = 1e9;
                for (const e of enemyObjects) { if (!e.isActive || e.hit) continue; const d = e.mesh.position.distanceTo(cc.position); if (d < bd) { bd = d; killer = e; } }
                if (!killer) killer = enemyObjects[0] || null;
                cc.dashTimer = 0;
                endUlt();   // Sage's Resurrection (or any revive ult) would bring you straight back
                if ('reynaDismissUntil' in agentSystem) agentSystem.reynaDismissUntil = 0;
                if (agentSystem.isoShieldActive) agentSystem.isoShieldActive = false;
                if (R.firing) { fireStop(); R.firing = false; }
                B.allowDeath = true;
                try { takeDamage(1000, killer ? killer.mesh.position : null, killer ? { enemy: killer } : null); } finally { B.allowDeath = false; }
                R.walking = false; R.deathAt = k; R.killer = killer ? enemyObjects.indexOf(killer) : -1;
                ev.push('death');
            }
        }
        if (R.firing && k >= R.burstUntil) { fireStop(); R.firing = false; }
        game.keys.w = false; game.keys.a = false; game.keys.s = false; game.keys.d = false;
        if (!alive()) return;
        if (R.sweep && k < R.sweep.k0 + R.sweep.dur) {
            const u = (k - R.sweep.k0) / R.sweep.dur;
            R.yaw = R.sweep.base + R.sweep.amp * Math.sin(2 * Math.PI * u);
            R.pitch = -0.04 + 0.07 * Math.sin(4 * Math.PI * u);
            R.walkFrames = 0; R.chkX = cc.position.x; R.chkZ = cc.position.z;
        } else if (R.firing) {
            R.walkFrames = 0; R.chkX = cc.position.x; R.chkZ = cc.position.z;
        } else {
            R.sweep = null;
            if (R.walking && R.wp < W.length) {
                const t = W[R.wp], dx = t[0] - cc.position.x, dz = t[1] - cc.position.z;
                if (Math.hypot(dx, dz) < 0.9) { R.wp++; R.wpAt.push(k); ev.push('wp' + R.wp); }
                else {
                    const want = Math.atan2(-dx, -dz);
                    let diff = want - R.yaw;
                    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
                    R.yaw += Math.max(-0.07, Math.min(0.07, diff));
                    R.pitch += (-0.05 - R.pitch) * 0.1;
                    if (Math.abs(diff) < 0.6) {
                        game.keys.w = true;
                        if (++R.walkFrames >= 60) {
                            // stuck (a wall, a bot, a barrier): on to the next point, the same way in every run
                            if (Math.hypot(cc.position.x - R.chkX, cc.position.z - R.chkZ) < 0.6) {
                                cc.position.set(t[0], cc.standHeight, t[1]); cc.prevSimPosition.copy(cc.position); cc.velocity.set(0, 0, 0);
                                R.unstuck.push([k, R.wp]); R.wp++; ev.push('unstuck');
                            }
                            R.walkFrames = 0; R.chkX = cc.position.x; R.chkZ = cc.position.z;
                        }
                    }
                }
            } else R.pitch += (-0.04 - R.pitch) * 0.08;
        }
        camera.rotation.set(R.pitch, R.yaw, 0, 'YXZ');
        cc.targetRotation.y = R.yaw;
        camera.updateMatrixWorld();
    };

    B.begin = (spec, T0) => {
        const D = B.D = { spec, T0, k: 0, seed: spec.seed || 20221, errors: [], realDate: Date.now, realRandom: Math.random,
            realStep: window.stepSimulation, inStep: 0, lastProgs: 0, killcam: false, dead: false, round: 0 };
        window.stepSimulation = function (dt, t) { D.inStep++; try { return D.realStep(dt, t); } finally { D.inStep--; } };
        window.__clock = T0;
        simClock = T0; simAccumulator = 0;
        performance.now = () => (D.inStep ? simClock : simClock + simAccumulator * 1000);
        Date.now = () => 1.7e12 + performance.now();
        Math.random = () => { D.seed = (D.seed * 16807) % 2147483647; return (D.seed - 1) / 2147483646; };
        if (has('gameNow')) { gameTime = T0; gameClock = T0; }
        timingResetPending = true;
        if (spec.noRender) { D.realRender = renderer.render; renderer.render = function () {}; }
        for (const t of __timers) t.at = Math.min(t.at, T0);
        const setup = B.setup(spec.start);
        B.routeInit(spec);
        D.lastProgs = renderer.info.programs ? renderer.info.programs.length : 0;
        D.round = game.roundNumber;
        return { setup, timers: __timers.length, rafQ: __rafQ.length };
    };

    // n frames; each timed with the real clock around the route actions, the due timers, the frame callback and
    // a 1-pixel readPixels (which waits for the GPU, here SwiftShader, to finish the frame)
    B.step = async (n) => {
        await new Promise((r) => B.realSetTimeout(r, 20));   // let the compositor finish the last chunk's frame
        const D = B.D, spec = D.spec, gl = renderer.getContext(), px1 = B.px1 || (B.px1 = new Uint8Array(4));
        const out = { k0: D.k, ms: [], tm: [], calls: [], tris: [], progs: [], ev: {}, hashes: [], done: false };
        for (let j = 0; j < n && D.k < spec.frames; j++, D.k++) {
            const k = D.k;
            __clock = D.T0 + k * (1000 / 60);
            const ev = [];
            const t0 = realPerf();
            try { B.routeFrame(k, ev); } catch (e) { D.errors.push(k + ' route: ' + e.message); }
            const ta = realPerf();
            runTimers(D.errors, k);
            const tb = realPerf();
            const q = __rafQ; __rafQ = [];
            for (const cb of q) { try { cb(__clock); } catch (e) { D.errors.push(k + ': ' + e.message + ' @ ' + String(e.stack || '').split('\n')[1]); } }
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
            const t1 = realPerf();
            const r = renderer.info.render;
            out.calls.push(r.calls); out.tris.push(r.triangles);
            const pc = renderer.info.programs ? renderer.info.programs.length : 0;
            out.progs.push(pc);
            if (pc > D.lastProgs) { ev.push('compile+' + (pc - D.lastProgs)); D.lastProgs = pc; }
            const kc = !!replayDirector.clip;
            if (kc !== D.killcam) { ev.push(kc ? 'killcam-start' : 'killcam-end'); D.killcam = kc; }
            const dead = game.health <= 0;
            if (dead !== D.dead) { ev.push(dead ? 'down' : 'respawn'); D.dead = dead; }
            if (game.roundNumber !== D.round) { ev.push('round' + game.roundNumber); D.round = game.roundNumber; }
            if (ev.length) out.ev[k] = ev;
            out.ms.push(+(t1 - t0).toFixed(3)); out.tm.push(+(tb - ta).toFixed(3));
            if (k % spec.hashEvery === 0 || k === spec.frames - 1) {
                const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
                if (!B.pxFull || B.pxFull.length !== w * h * 4) B.pxFull = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, B.pxFull);
                let s = '';
                try { s = JSON.stringify(B.snap()); } catch (e) { s = 'snap error: ' + e.message; }
                const p = characterController.position;
                out.hashes.push([k, fnvBytes(B.pxFull), fnvStr(s), [f5(p.x), f5(p.y), f5(p.z)], game.health]);
            }
        }
        out.done = D.k >= spec.frames;
        out.errors = D.errors.splice(0);
        return out;
    };

    B.end = () => {
        const D = B.D, R = B.R;
        performance.now = realPerf; Date.now = D.realDate; Math.random = D.realRandom;
        window.stepSimulation = D.realStep;
        if (D.realRender) renderer.render = D.realRender;
        if (R && R.firing) { try { fireStop(); } catch (e) { /* ignore */ } }
        return {
            route: { wpReached: R.wp, wpTotal: D.spec.waypoints.length, wpAt: R.wpAt, unstuck: R.unstuck, casts: R.casts, skipped: R.skipped, deathAt: R.deathAt, killer: R.killer },
            stalls: perfTelemetry.firstUseStalls, glBufferDataBytes: perfTelemetry.glBufferDataBytes, glUploadBytes: perfTelemetry.glUploadBytes,
            programs: renderer.info.programs ? renderer.info.programs.length : 0, watermark: perfTelemetry.programWatermark,
            clamped: B.damageClamped, damageCalls: B.damageCalls, deaths: game.playerDeaths || 0, killcams: replayDirector.played || 0,
            round: game.roundNumber, health: game.health, quality: adaptiveSettings.currentQuality, autoQuality: qualityController.auto,
            audioError: B.audioError || null
        };
    };
    return true;
};

// ---- the route (Mode D) ---------------------------------------------------------------------------------------
// Ascent, from mid (the Wave start, -8 11, facing north) through A Link into A Site, out of its west door into
// A Main to the chokepoint and back to the site. Event frames are for 3600 frames and scale with --frames;
// durations do not.
const ROUTE_START = { at: [-8, 1.7, 11], aim: [-0.04, 0], agent: 'sage' };
const ROUTE_WAYPOINTS = [[-4, 0], [6, -10], [6, -17], [1, -20], [-1.25, -24], [-1.25, -28], [3, -31], [-2, -36.5], [-5.5, -37.5],
    [-10, -37], [-20, -37], [-30, -37], [-20, -37], [-5.5, -37.5], [4, -34]];
function buildRoute(F, args) {
    const s = F / 3600, tl = {};
    // a short route (--quick) keeps every event, with sweeps and bursts shortened so that it still walks
    const add = (f, a) => {
        const k = Math.min(F - 1, Math.max(1, Math.round(f * s)));
        if (a.dur && s < 1) a = Object.assign({}, a, { dur: Math.max(a.t === 'sweep' ? 20 : 8, Math.round(a.dur * s)) });
        (tl[k] = tl[k] || []).push(a);
    };
    add(90, { t: 'sweep', dur: 75, amp: 0.9 });
    add(200, { t: 'burst', dur: 14, aim: true });
    add(260, { t: 'cast', key: 'sage.c', pitch: -0.25, yawOff: 1.3 });   // the wall to one side, off the path
    add(380, { t: 'burst', dur: 18 });
    add(470, { t: 'cast', key: 'sage.q', pitch: -0.15 });
    add(560, { t: 'reload' });
    add(640, { t: 'sweep', dur: 90, amp: 1.2 });
    add(760, { t: 'cast', key: 'sage.e', pitch: -0.4 });
    add(860, { t: 'burst', dur: 14, aim: true });
    add(960, { t: 'cast', key: 'sage.x', pitch: -0.1 });
    add(1080, { t: 'sweep', dur: 75, amp: 0.8 });
    add(1200, { t: 'agent', id: 'omen' });
    add(1260, { t: 'cast', key: 'omen.c', pitch: -0.6 });                // a short step ahead
    add(1380, { t: 'burst', dur: 16, aim: true });
    add(1440, { t: 'cast', key: 'omen.q', pitch: -0.05 });
    add(1560, { t: 'reload' });
    add(1620, { t: 'cast', key: 'omen.e', pitch: -0.2 });
    add(1740, { t: 'sweep', dur: 90, amp: 1.0 });
    add(1860, { t: 'cast', key: 'omen.x', pitch: -0.1 });
    add(1980, { t: 'burst', dur: 18, aim: true });
    add(2100, { t: 'sweep', dur: 75, amp: 1.1 });
    add(2220, { t: 'reload' });
    add(2340, { t: 'burst', dur: 14, aim: true });
    add(2460, { t: 'sweep', dur: 90, amp: 0.9 });
    add(2620, { t: 'burst', dur: 18, aim: true });
    add(2740, { t: 'reload' });
    add(2860, { t: 'sweep', dur: 75, amp: 1.2 });
    add(2980, { t: 'burst', dur: 14, aim: true });
    // the forced death: late enough that the kill cam replays only this run, early enough that it plays
    const death = Math.max(Math.round(F * 0.6), F - 480);
    (tl[death] = tl[death] || []).push({ t: 'death' });
    return { frames: F, start: ROUTE_START, waypoints: ROUTE_WAYPOINTS, timeline: tl, hashEvery: args.hashEvery, seed: args.seed, deathAt: death, noRender: !!args.noRender };
}

// ---- statistics ----------------------------------------------------------------------------------------------
function frameStats(ms) {
    const n = ms.length;
    if (!n) return null;
    const sorted = Float64Array.from(ms).sort();
    let sum = 0, max = -1, maxAt = -1;
    for (let i = 0; i < n; i++) { sum += ms[i]; if (ms[i] > max) { max = ms[i]; maxAt = i; } }
    const mean = sum / n;
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil(n * p) - 1))];
    const lowN = Math.min(n, Math.max(36, Math.ceil(n * 0.01)));
    let lowSum = 0;
    for (let i = n - lowN; i < n; i++) lowSum += sorted[i];
    return { n, meanMs: mean, medianMs: median, p95Ms: q(0.95), p99Ms: q(0.99), maxMs: max, maxFrame: maxAt, avgFps: 1000 / mean, low1Fps: 1000 / (lowSum / lowN), low1Frames: lowN };
}
function median(a) { if (!a || !a.length) return null; const s = Float64Array.from(a).sort(), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
function meanSd(a) { const v = a.filter((x) => typeof x === 'number' && isFinite(x)); if (!v.length) return { mean: null, sd: null, n: 0 }; const m = v.reduce((s, x) => s + x, 0) / v.length; const sd = v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1)) : 0; return { mean: m, sd, min: Math.min(...v), max: Math.max(...v), n: v.length }; }
// Spikes: frames over 2x the median, and frames over 50 ms, each with the scripted/game events at or just before it
function spikes(ms, med, events) {
    const near = (i) => {
        if (!events) return undefined;
        const out = [];
        for (let d = 0; d <= 2; d++) { const e = events[i - d]; if (e) for (const x of e) out.push(d ? '-' + d + ':' + x : x); }
        return out;
    };
    const list = (pred) => {
        const idx = [];
        for (let i = 0; i < ms.length; i++) if (pred(ms[i])) idx.push(i);
        return { count: idx.length, frames: idx.slice(0, 60).map((i) => ({ i, ms: +ms[i].toFixed(2), events: near(i) })), truncated: idx.length > 60 };
    };
    return { over2xMedian: list((v) => v > 2 * med), over50ms: list((v) => v > 50) };
}
async function heapUsage(page) {
    try {
        const cdp = await page.context().newCDPSession(page);
        const h1 = await cdp.send('Runtime.getHeapUsage');
        await cdp.send('HeapProfiler.collectGarbage');
        const h2 = await cdp.send('Runtime.getHeapUsage');
        await cdp.detach();
        return { usedMB: +(h1.usedSize / 1048576).toFixed(2), afterGcMB: +(h2.usedSize / 1048576).toFixed(2), totalMB: +(h2.totalSize / 1048576).toFixed(2) };
    } catch (e) { return { error: e.message }; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => (typeof v === 'number' && isFinite(v) ? +v.toFixed(2) : v);

// ---- one run -------------------------------------------------------------------------------------------------
async function bootBuild(args, file, pre) {
    const settings = Object.assign({ contentTierMode: 'medium', skipMenu: true, qualityMode: 'medium' }, pre || {});
    const t0 = Date.now();
    const g = await harness.boot({ file, viewport: args.viewport, quality: 'medium', initScript: PRE_INIT, initArg: { settings, track: args.mode === 'D', seed: args.seed } });
    const bootMs = Date.now() - t0;
    const bootPrograms = await harness.programState(g.page);
    await g.page.evaluate(PAGE_LIB);
    const info = await g.page.evaluate(() => __bench.info());
    return { g, bootMs, bootPrograms, info, settings };
}

async function runD(args, label, file, opts, pre) {
    const { g, bootMs, bootPrograms, info, settings } = await bootBuild(args, file, pre);
    const page = g.page;
    const optsRes = await page.evaluate((o) => __bench.applyOpts(o), opts);
    await g.frames(30);   // lazy builds a variant starts (Enhanced Animations, High Fidelity) settle in real frames
    const clampOk = await page.evaluate((m) => __bench.installClamp(m), args.minHealth);
    const drv = await page.evaluate(() => __bench.installDriver());
    // the real frame already asked for re-registers itself in the queue
    let queued = false;
    for (let i = 0; i < 600 && !(queued = await page.evaluate(() => __rafQ.length > 0)); i++) await sleep(50);
    if (!queued) throw new Error('the game never queued a frame after the driver took over');
    const spec = buildRoute(args.frames, args);
    const begin = await page.evaluate(([spec, T0]) => __bench.begin(spec, T0), [spec, 5e6]);
    const ms = [], tm = [], calls = [], tris = [], progs = [], hashes = [], events = {}, pageErrors = [];
    const tDrive = Date.now();
    for (;;) {
        const r = await page.evaluate((n) => __bench.step(n), args.chunk);
        for (let i = 0; i < r.ms.length; i++) { ms.push(r.ms[i]); tm.push(r.tm[i]); calls.push(r.calls[i]); tris.push(r.tris[i]); progs.push(r.progs[i]); }
        Object.assign(events, r.ev);
        for (const h of r.hashes) hashes.push(h);
        for (const e of r.errors) pageErrors.push(e);
        if (r.done || !r.ms.length) break;
    }
    const driveS = (Date.now() - tDrive) / 1000;
    const end = await page.evaluate(() => __bench.end());
    const heap = await heapUsage(page);
    const endPrograms = await harness.programState(page);
    const errors = g.errors.slice();
    await harness.closeBrowser();
    const st = frameStats(ms);
    const eventCounts = {};
    for (const k of Object.keys(events)) for (const e of events[k]) { const key = e.replace(/^(compile)\+\d+$/, '$1').replace(/^wp\d+$/, 'waypoint').replace(/^round\d+$/, 'round'); eventCounts[key] = (eventCounts[key] || 0) + 1; }
    return {
        build: label, file: path.relative(REPO, file) || file, mode: 'D', viewport: args.viewport, opts, pre: pre || {}, settings, optsResult: optsRes,
        bootMs, shaderWarmupMs: info.shaderWarmupMs, info, bootPrograms: { programs: bootPrograms[0], watermark: bootPrograms[1], stalls: bootPrograms[2] },
        endPrograms: { programs: endPrograms[0], watermark: endPrograms[1], stalls: endPrograms[2] },
        frames: ms.length, driveS: r2(driveS), ...mapStats(st),
        spikes: spikes(ms, st.medianMs, events),
        timersMs: { mean: r2(tm.reduce((s, x) => s + x, 0) / Math.max(1, tm.length)), max: r2(Math.max(...tm)) },
        drawCalls: median(calls), triangles: median(tris), drawCallsMax: Math.max(...calls),
        programsMax: Math.max(...progs), stalls: end.stalls, glBufferDataBytes: end.glBufferDataBytes, glUploadBytes: end.glUploadBytes,
        heap, route: end.route, deaths: end.deaths, killcams: end.killcams, round: end.round, damageClamped: end.clamped, damageCalls: end.damageCalls,
        endState: { quality: end.quality, autoQuality: end.autoQuality, health: end.health, audioError: end.audioError },
        driver: { takenTimers: drv.takenTimers, clamp: clampOk, begin },
        eventCounts, events, hashes, frameMs: ms, errors, pageErrors
    };
}

async function runR(args, label, file, opts, pre) {
    const { g, bootMs, bootPrograms, info, settings } = await bootBuild(args, file, pre);
    const page = g.page;
    const optsRes = await page.evaluate((o) => __bench.applyOpts(o), opts);
    const setup = await page.evaluate((s) => { const r = __bench.setup(s); __bench.installClamp(s.minHealth); __bench.startLook(s.aim[1]); return r; }, Object.assign({}, ROUTE_START, { minHealth: args.minHealth }));
    if (args.warm) await g.frames(args.warm);
    await page.evaluate(() => __bench.recStart());
    const tRec = Date.now();
    if (args.framesGiven || args.quick) {
        const want = args.frames;
        for (;;) {
            await sleep(500);
            const n = await page.evaluate(() => perfTelemetry.runCount);
            if (n >= want) break;
            if (Date.now() - tRec > 30 * 60000) throw new Error('Mode R: ' + want + ' frames not recorded in 30 minutes');
        }
    } else await sleep(args.seconds * 1000);
    const rec = await page.evaluate(() => __bench.recStop());
    const heap = await heapUsage(page);
    const endPrograms = await harness.programState(page);
    const errors = g.errors.slice();
    await harness.closeBrowser();
    let frame = rec.frame, cpu = rec.cpu;
    if (args.framesGiven || args.quick) { frame = frame.slice(0, args.frames); cpu = cpu.slice(0, args.frames); }
    const st = frameStats(frame);
    const sc = frameStats(cpu);
    // compile events from the per-frame program count (the interval i is produced by callback i-1)
    const events = {};
    for (let j = 1; j < rec.progs.length; j++) if (rec.progs[j] > rec.progs[j - 1]) { (events[j + 1] = events[j + 1] || []).push('compile+' + (rec.progs[j] - rec.progs[j - 1])); }
    return {
        build: label, file: path.relative(REPO, file) || file, mode: 'R', viewport: args.viewport, opts, pre: pre || {}, settings, optsResult: optsRes, setup,
        bootMs, shaderWarmupMs: info.shaderWarmupMs, info, bootPrograms: { programs: bootPrograms[0], watermark: bootPrograms[1], stalls: bootPrograms[2] },
        endPrograms: { programs: endPrograms[0], watermark: endPrograms[1], stalls: endPrograms[2] },
        frames: frame.length, recordS: r2(rec.wallMs / 1000), ...mapStats(st),
        cpuMs: sc ? { mean: r2(sc.meanMs), p95: r2(sc.p95Ms), max: r2(sc.maxMs) } : null,
        spikes: spikes(frame, st.medianMs, events),
        drawCalls: median(rec.calls), triangles: median(rec.tris), drawCallsMax: rec.calls.length ? Math.max(...rec.calls) : null,
        stalls: rec.stalls, glBufferDataBytes: rec.glBufferDataBytes, glUploadBytes: rec.glUploadBytes, heap,
        damageClamped: rec.clamped, damageCalls: rec.damageCalls, deaths: rec.deaths, round: rec.round,
        endState: { quality: rec.quality, autoQuality: rec.autoQuality }, exportRun: rec.run,
        frameMs: frame, cpuMsPerFrame: cpu, errors
    };
}
function mapStats(st) {
    return { avgFps: r2(st.avgFps), low1Fps: r2(st.low1Fps), low1Frames: st.low1Frames, meanMs: r2(st.meanMs), medianMs: r2(st.medianMs), p95Ms: r2(st.p95Ms), p99Ms: r2(st.p99Ms), maxMs: r2(st.maxMs), maxFrame: st.maxFrame };
}

// ---- report --------------------------------------------------------------------------------------------------
function buildSummary(runs) {
    if (!runs.length) return null;
    const pick = (f) => runs.map(f);
    return {
        runs: runs.length,
        avgFps: meanSd(pick((r) => r.avgFps)), low1Fps: meanSd(pick((r) => r.low1Fps)), medianMs: meanSd(pick((r) => r.medianMs)),
        maxMs: Math.max(...pick((r) => r.maxMs)),
        spikesOver2xMedian: meanSd(pick((r) => r.spikes.over2xMedian.count)), spikesOver50ms: meanSd(pick((r) => r.spikes.over50ms.count)),
        cpuMsMean: runs[0].cpuMs ? meanSd(pick((r) => r.cpuMs.mean)) : null, cpuMsP95: runs[0].cpuMs ? meanSd(pick((r) => r.cpuMs.p95)) : null,
        drawCalls: median(pick((r) => r.drawCalls)), triangles: median(pick((r) => r.triangles)),
        programs: pick((r) => r.endPrograms.programs), watermark: pick((r) => r.bootPrograms.watermark), stalls: pick((r) => r.stalls),
        heapMB: meanSd(pick((r) => r.heap && r.heap.usedMB)), shaderWarmupMs: meanSd(pick((r) => r.shaderWarmupMs)), bootMs: meanSd(pick((r) => r.bootMs)),
        glBufferDataBytes: meanSd(pick((r) => r.glBufferDataBytes))
    };
}
function determinism(runs) {
    const sig = (r) => r.hashes.map((h) => h[0] + ':' + h[1] + ':' + h[2]).join(',');
    const groups = {};
    runs.forEach((r, i) => { const s = sig(r); (groups[s] = groups[s] || []).push(i); });
    const keys = Object.keys(groups);
    const out = { hashedFrames: runs[0] ? runs[0].hashes.map((h) => h[0]) : [], identical: keys.length === 1, groups: keys.map((k) => groups[k].map((i) => runs[i].build + '#' + i)) };
    if (keys.length > 1) {
        const a = runs[groups[keys[0]][0]], b = runs[groups[keys[1]][0]];
        for (let i = 0; i < Math.max(a.hashes.length, b.hashes.length); i++) {
            const x = a.hashes[i] || [], y = b.hashes[i] || [];
            if (x[1] !== y[1] || x[2] !== y[2]) { out.firstDiff = { frame: x[0], pixels: x[1] !== y[1], state: x[2] !== y[2], a: x, b: y }; break; }
        }
    }
    return out;
}
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function lpad(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function fmt(v, d = 1) { return typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '-'; }
function printTable(report) {
    const R = report.mode === 'R';
    const head = [pad('run', 4), pad('build', 6), lpad('pair', 4), lpad('FPS', 7), lpad('1%low', 7), lpad('med', 6), lpad('max', 7), lpad('@frame', 7), lpad('>2xm', 5), lpad('>50', 5)]
        .concat(R ? [lpad('cpu', 6), lpad('cpu95', 6)] : [])
        .concat([lpad('draws', 6), lpad('tris', 8), lpad('prog/wm', 8), lpad('stall', 5), lpad('heapMB', 7), lpad('warmMs', 7)]).join(' ');
    console.log(head);
    report.runs.forEach((r, i) => {
        console.log([pad(i, 4), pad(r.build + (r.discarded ? '*' : ''), 6), lpad(r.pair, 4), lpad(fmt(r.avgFps), 7), lpad(fmt(r.low1Fps), 7), lpad(fmt(r.medianMs), 6), lpad(fmt(r.maxMs), 7), lpad(r.maxFrame, 7),
            lpad(r.spikes.over2xMedian.count, 5), lpad(r.spikes.over50ms.count, 5)]
            .concat(R ? [lpad(fmt(r.cpuMs && r.cpuMs.mean, 2), 6), lpad(fmt(r.cpuMs && r.cpuMs.p95, 2), 6)] : [])
            .concat([lpad(fmt(r.drawCalls, 0), 6), lpad(fmt(r.triangles, 0), 8), lpad(r.endPrograms.programs + '/' + r.bootPrograms.watermark, 8), lpad(r.stalls, 5),
                lpad(fmt(r.heap && r.heap.usedMB), 7), lpad(fmt(r.shaderWarmupMs, 0), 7)]).join(' '));
    });
    if (report.runs.some((r) => r.discarded)) console.log('(* discarded: the first pair)');
    for (const b of Object.keys(report.builds)) {
        const s = report.builds[b];
        if (!s) continue;
        console.log(`${b}: ${report.files[b]}  runs ${s.runs}  FPS ${fmt(s.avgFps.mean)} ±${fmt(s.avgFps.sd)}  1% low ${fmt(s.low1Fps.mean)} ±${fmt(s.low1Fps.sd)}  ` +
            `spikes >2x median ${fmt(s.spikesOver2xMedian.mean)} >50 ms ${fmt(s.spikesOver50ms.mean)}  max ${fmt(s.maxMs)} ms` + (s.cpuMsMean ? `  cpu ${fmt(s.cpuMsMean.mean, 2)}/${fmt(s.cpuMsP95.mean, 2)} ms` : '') +
            `  draws ${fmt(s.drawCalls, 0)}  tris ${fmt(s.triangles, 0)}`);
    }
    if (report.ratios) console.log(`B/A: avg FPS ${fmt(report.ratios.avgFps, 3)} (per pair median ${fmt(report.ratios.avgFpsPairMedian, 3)}), 1% low ${fmt(report.ratios.low1Fps, 3)} (per pair median ${fmt(report.ratios.low1FpsPairMedian, 3)})`);
    if (report.determinism) {
        const d = report.determinism;
        console.log(`Mode D frames: ${d.identical ? 'IDENTICAL' : 'DIFFER'} across ${report.runs.length} runs at ${d.hashedFrames.length} hashed frames (pixels + game state)` +
            (d.firstDiff ? ` - first difference at frame ${d.firstDiff.frame} (${d.firstDiff.pixels ? 'pixels' : ''}${d.firstDiff.pixels && d.firstDiff.state ? ' and ' : ''}${d.firstDiff.state ? 'state' : ''})` : ''));
    }
    const errs = report.runs.reduce((n, r) => n + r.errors.length + (r.pageErrors ? r.pageErrors.length : 0), 0);
    console.log(`page errors: ${errs}`);
}

// ---- main ----------------------------------------------------------------------------------------------------
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
    const builds = { A: { file: args.aFile, opts: args.aOpts, pre: args.aPre } };
    if (args.bFile) builds.B = { file: args.bFile, opts: args.bOpts, pre: args.bPre };
    const order = [];
    for (let p = 0; p < args.pairs; p++) {
        const pair = builds.B ? (p % 2 === 0 ? ['A', 'B'] : ['B', 'A']) : ['A'];
        for (const b of pair) order.push({ build: b, pair: p });
    }
    const discardFirst = args.pairs > 1 && !args.keepFirst;
    say(`mode ${args.mode}, ${args.viewport.width}x${args.viewport.height}, ${args.mode === 'D' ? args.frames + ' frames' : (args.framesGiven || args.quick ? args.frames + ' frames' : args.seconds + ' s') + ' after ' + args.warm + ' warm frames'}, ` +
        `${args.pairs} pair(s)${discardFirst ? ' (first discarded)' : ''}; A = ${path.relative(REPO, args.aFile)}${builds.B ? ', B = ' + path.relative(REPO, args.bFile) : ''}`);
    const runs = [];
    for (const o of order) {
        const b = builds[o.build];
        say(`run ${runs.length + 1}/${order.length}: ${o.build} (pair ${o.pair})`);
        const fn = args.mode === 'D' ? runD : runR;
        let r;
        try { r = await fn(args, o.build, b.file, b.opts, b.pre); }
        catch (e) { await harness.closeBrowser().catch(() => {}); throw e; }
        r.pair = o.pair;
        r.discarded = discardFirst && o.pair === 0;
        runs.push(r);
        say(`  ${o.build}: ${fmt(r.avgFps)} FPS, 1% low ${fmt(r.low1Fps)}, median ${fmt(r.medianMs)} ms, max ${fmt(r.maxMs)} ms @${r.maxFrame}, ` +
            `spikes ${r.spikes.over2xMedian.count}/${r.spikes.over50ms.count}, draws ${fmt(r.drawCalls, 0)}, programs ${r.endPrograms.programs}/${r.bootPrograms.watermark}, stalls ${r.stalls}, ` +
            `errors ${r.errors.length + (r.pageErrors ? r.pageErrors.length : 0)}, boot ${(r.bootMs / 1000).toFixed(1)} s` + (r.driveS ? `, drive ${r.driveS} s` : ''));
        if (args.trace && r.hashes) for (const h of r.hashes) say(`    frame ${h[0]} pixels ${h[1]} state ${h[2]} you ${JSON.stringify(h[3])} health ${h[4]}`);
    }
    const kept = runs.filter((r) => !r.discarded);
    const report = {
        tool: 'tests/tools/bench.js (V2.3 benchmark)', startedAt: new Date().toISOString(), mode: args.mode, viewport: args.viewport, frames: args.frames,
        seconds: args.mode === 'R' && !(args.framesGiven || args.quick) ? args.seconds : null, warm: args.mode === 'R' ? args.warm : null,
        pairs: args.pairs, discardFirst, files: { A: path.relative(REPO, args.aFile) }, opts: { A: args.aOpts }, pre: { A: args.aPre },
        machine: { cpus: os.cpus().length, loadavg: os.loadavg(), node: process.version },
        route: args.mode === 'D' ? buildRoute(args.frames, args) : null,
        builds: { A: buildSummary(kept.filter((r) => r.build === 'A')) }, runs
    };
    if (builds.B) {
        report.files.B = path.relative(REPO, args.bFile); report.opts.B = args.bOpts; report.pre.B = args.bPre;
        report.builds.B = buildSummary(kept.filter((r) => r.build === 'B'));
        const A = report.builds.A, Bs = report.builds.B;
        const pairRatios = (key) => {
            const v = [];
            for (let p = 0; p < args.pairs; p++) {
                if (discardFirst && p === 0) continue;
                const a = runs.find((r) => r.pair === p && r.build === 'A'), b = runs.find((r) => r.pair === p && r.build === 'B');
                if (a && b) v.push(b[key] / a[key]);
            }
            return v;
        };
        if (A && Bs) report.ratios = {
            avgFps: Bs.avgFps.mean / A.avgFps.mean, low1Fps: Bs.low1Fps.mean / A.low1Fps.mean,
            avgFpsPairMedian: median(pairRatios('avgFps')), low1FpsPairMedian: median(pairRatios('low1Fps')),
            avgFpsPairs: pairRatios('avgFps'), low1FpsPairs: pairRatios('low1Fps')
        };
    }
    if (args.mode === 'D') report.determinism = determinism(runs);
    console.log('');
    printTable(report);
    if (args.out) {
        fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
        fs.writeFileSync(args.out, JSON.stringify(report, null, 1));
        console.log('report: ' + path.resolve(args.out));
    }
}

main().catch(async (e) => {
    console.error(e && e.stack || e);
    try { await harness.closeBrowser(); } catch (x) { /* ignore */ }
    process.exit(1);
});
