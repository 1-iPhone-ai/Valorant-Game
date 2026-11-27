#!/usr/bin/env node
'use strict';
// V2.3: same.js, the determinism driver that compares two builds (a tool, not a test). It generalises the V2.2 final
// check's everything-off driver (alloff.js): two builds side by side, each in its own browser context. The game's
// frames are driven from here: its requestAnimationFrame, setTimeout and setInterval are queued and run only by the
// driver, on one clock that moves 1000/60 ms a frame (performance.now and Date.now too), with Math.random seeded the
// same in both. So a scenario plays the same way twice in one build, and in the two builds where nothing differs.
// After a difference both builds are booted afresh, so the next scenario starts from the same state.
//
// Usage (from the repository root, NODE_PATH=tests/node_modules):
//   node tests/tools/same.js --a '(V2.2) valorant-fps.html' --b '(V2.3) valorant-fps.html' [--parts defaults,game]
//        [--profile defaults|off] [--only wave-ascent,wave-bind] [--keys sage.c,omen.q] [--every 3] [--render]
//        [--dump] [--out <dir>] [--tag <name>]
// Parts (default all four, in this order):
//   defaults   the user-settings keys and values each build starts with (DEFAULT_USER_SETTINGS and game.userSettings):
//              keys only in a, keys only in b, values that differ; plus quality, Enhanced Animations, High Fidelity,
//              bot mechanics, audio and Ultra state
//   views      7 maps x 5 still views, canvas pixels (bots out, wingmen off, the gun hidden)
//   game       wave on every map, match, spike rush, ranked, deathmatch, retake, range and aim scenarios (alloff.js's),
//              plus killcam-ascent: you die to a bot, the kill cam plays to its end and you respawn (the H30 replay
//              and recap hooks)
//   abilities  every agent's C, Q, E and X on Ascent (the High Fidelity kit's recipes)
// Every snapshot holds you, the bots, the wingmen, the ability items, the bots' hazards, the spike, the mode, the
// replay director (clip, time, pending, queue, ghost) and the death recap's rows.
// --profile defaults: each build as it boots. --profile off: the V2.3 settings off where a build has them
//   (agentIdentity 'off', weaponAnims 'classic', botUtility 'classic') and V23.arena.enabled false.
//   Without --profile, 'views' runs with 'off' (design 17.3: views compare the identity-off picture, which is V2.2's)
//   and the other parts with 'defaults'. An explicit --profile defaults for views is honoured, with a warning: from
//   WP11 on, Ascent's views differ there by design.
// Valued options take the next argument or --name=value; --render and --dump take no value (--render=0 turns it off).
// The old environment variables still work: OUT, KEYS, ONLY, EVERY, RENDER, DUMP, TAG.
// Exit code 1 when a views, game or abilities scenario differs (the defaults part only reports).
const path = require('path'), fs = require('fs'), os = require('os');
const REPO = path.resolve(__dirname, '..', '..');
const { chromium } = require('playwright');
const THREE_JS = fs.readFileSync(require.resolve('three/build/three.min.js'));
const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];

// ---- options -------------------------------------------------------------------------------------------------------
const BOOL_FLAGS = new Set(['render', 'dump', 'help']);
function parseArgs(argv) {
    const o = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq > 0) {
                const k = a.slice(2, eq), v = a.slice(eq + 1);
                o[k] = BOOL_FLAGS.has(k) ? !/^(0|false|no|off)$/i.test(v) : v;
                continue;
            }
            const k = a.slice(2), next = argv[i + 1];
            // a boolean flag never takes the next argument (`--render game` keeps 'game' as the part)
            if (BOOL_FLAGS.has(k) || next === undefined || next.startsWith('--')) o[k] = true; else { o[k] = next; i++; }
        } else o._.push(a);
    }
    return o;
}
const ARGS = parseArgs(process.argv.slice(2));
const opt = (k, env) => (ARGS[k] !== undefined ? ARGS[k] : process.env[env || k.toUpperCase()]);
const resolveBuild = (f) => {
    if (!f) return null;
    const c = path.resolve(process.cwd(), f);
    return fs.existsSync(c) ? c : path.resolve(REPO, f);
};
const FILE_A = resolveBuild(opt('a', 'SAME_A') || '(V2.2) valorant-fps.html');
const FILE_B = resolveBuild(opt('b', 'SAME_B') || '(V2.3) valorant-fps.html');
const ALL_PARTS = ['defaults', 'views', 'game', 'abilities'];
const PARTS = String(opt('parts', 'PARTS') || ARGS._[0] || 'all').split(',').flatMap((p) => (p === 'all' ? ALL_PARTS : [p]));
const PROFILE_ARG = opt('profile', 'PROFILE');
const PROFILE = String(PROFILE_ARG || 'defaults');
// the profile a part runs with: --profile when given, else 'off' for views (design 17.3) and 'defaults' for the rest
const profileFor = (part) => (PROFILE_ARG ? PROFILE : (part === 'views' ? 'off' : 'defaults'));
const ONLY = opt('only');
const KEYS = opt('keys');
const EVERY = opt('every');
const boolOpt = (k) => { const v = opt(k); return v === true || (typeof v === 'string' && !/^(0|false|no|off|)$/i.test(v)); };
const RENDER = boolOpt('render');
const DUMP = boolOpt('dump');
const TAG = opt('tag');
const OUT = path.resolve(opt('out') || path.join(os.tmpdir(), 'v23-same'));
for (const p of PARTS) if (ALL_PARTS.indexOf(p) < 0) { console.error(`unknown part '${p}' (parts: ${ALL_PARTS.join(', ')})`); process.exit(2); }
if (ARGS.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 40).filter((l) => l.startsWith('//')).join('\n')); process.exit(0); }
if (PROFILE !== 'defaults' && PROFILE !== 'off') { console.error(`--profile is defaults or off, not '${PROFILE}'`); process.exit(2); }
for (const f of [FILE_A, FILE_B]) if (!fs.existsSync(f)) { console.error(`no such build: ${f}`); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, PARTS.join('+') + (TAG ? '-' + TAG : '') + '.jsonl');
const log = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let differences = 0;

// ---- in the page ---------------------------------------------------------------------------------------------------
const DRIVER = () => {
    // The game's own frame callbacks and timers, queued for the driver
    window.__rafQ = [];
    window.__timers = [];
    window.__timerId = 1e6;
    window.__clock = null;   // null: the real clock (before the first drive)
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

    // The sound buffers made on first use take Math.random() calls: made here, before any seeded run (as in
    // tests/bot-mechanics.test.js)
    const ctx = soundFX.ensureContext && soundFX.ensureContext();
    if (ctx) {
        if (soundFX._ensureReverb) soundFX._ensureReverb(ctx);
        if (!soundFX._noiseBuffer || soundFX._noiseBuffer.sampleRate !== ctx.sampleRate) {
            const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
            for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
            soundFX._noiseBuffer = b;
        }
    }

    const f6 = (v) => (typeof v === 'number' ? +v.toFixed(5) : v);
    const p3 = (o) => (o && o.position ? [f6(o.position.x), f6(o.position.y), f6(o.position.z)] : null);
    // What the game is doing: you, every bot, the wingmen, every ability item out, the bots' hazards, the spike
    // and the mode. Positions to 1e-5 m.
    window.__snap = () => {
        const cc = characterController, out = {};
        const cn = typeof gameNow === 'function' ? gameNow() : performance.now();
        out.you = [p3(cc), f6(cc.velocity ? cc.velocity.x : 0), f6(cc.velocity ? cc.velocity.z : 0), game.health, game.shield, f6(camera.rotation.x), f6(camera.rotation.y)];
        // the bots' effects against this build's own ability clock (game time since V2.2, the real clock before), the
        // same clock in both here: the driver keeps them in step
        const fx = (e) => (e.blindedUntil > cn ? 'b' : '') + (e.slowedUntil > cn ? 's' : '') + (e.revealedUntil > cn ? 'r' : '') + (e.concussedUntil > cn ? 'c' : '') + (e.suppressedUntil > cn ? 'u' : '');
        out.bots = enemyObjects.map((e) => (e.isActive && !e.hit ? [e.slot, p3(e.mesh), f6(e.mesh.rotation.y), f6(e.health), e.aiState || '', e.archetype || '', fx(e)] : [e.slot, e.isActive ? 1 : 0, e.hit ? 1 : 0]));
        out.wing = (tacticalEnhancements.wingmanBots || []).map((b) => [p3(b.group), f6(b.health)]);
        const items = [];
        for (const k of Object.keys(agentSystem)) {
            const v = agentSystem[k];
            if (!Array.isArray(v)) continue;
            for (let i = 0; i < v.length; i++) {
                const it = v[i];
                if (!it || typeof it !== 'object' || it.isObject3D) continue;
                if (it.inUse === true || it.active === true) { const m = it.mesh || it.group; items.push([k, i, p3(m), m && m.scale ? f6(m.scale.x) : null, typeof it.health === 'number' ? f6(it.health) : null, typeof it.startAt === 'number' ? f6(cn - it.startAt) : null]); }
            }
        }
        // the single ability objects too (Viper's Pit, Hunter's Fury's beam, Thrash, the cocoon, ...)
        for (const k of Object.keys(agentSystem)) {
            const it = agentSystem[k];
            if (!it || typeof it !== 'object' || Array.isArray(it) || it.isObject3D) continue;
            if (it.inUse === true || it.active === true) {
                const m = it.group || it.mesh || it.domeMesh;
                items.push([k, -1, p3(m), m && m.scale ? f6(m.scale.x) : null, typeof it.health === 'number' ? f6(it.health) : null, typeof it.startAt === 'number' ? f6(cn - it.startAt) : null,
                    it.position && typeof it.position.x === 'number' ? [f6(it.position.x), f6(it.position.y), f6(it.position.z)] : null]);
            }
        }
        out.items = items;
        out.hazards = (tacticalDirector.botHazardsPool || []).filter((h) => h && (h.active || h.inUse)).map((h) => p3(h.mesh || h.group));
        out.spike = [tacticalDirector.spikeState, f6(tacticalDirector.spikePlantProgress || 0), f6(tacticalDirector.spikeDefuseProgress || 0)];
        out.mode = [game.gameMode, game.roundNumber, matchMode.active ? [matchMode.phase, matchMode.round, matchMode.score ? JSON.stringify(matchMode.score) : ''] : 0, dmMode.active ? 1 : 0];
        // V2.3: the replay director (kill cam and highlights: the H30 hooks) and the death recap. Not replayRec.count:
        // the real frames before the driver took over add a boot-dependent number of captures (the newest one is driven)
        const rd = replayDirector, c = rd.clip, g = rd.ghost;
        out.replay = [c ? [c.kind, f6(rd.pt - c.from), c.killer === undefined ? -1 : c.killer, c.name || '', c.skipped ? 1 : 0] : 0,
            rd.pending ? f6(rd.pending.startAt - cn) : 0, rd.queue.length, rd.after.length, rd.played, replayRec.count ? f6(replayRec.newest() - cn) : 0, replayRec.recording ? 1 : 0,
            g ? [g.visible ? 1 : 0, p3(g), f6(g.rotation.x)] : 0];
        out.recap = [[...deathRecap.taken.values()].map((r) => [r.name, r.dmg, r.hits, r.enemy ? enemyObjects.indexOf(r.enemy) : -1]),
            [...deathRecap.dealt.values()].reduce((t, r) => t + r.dmg, 0), deathRecap.el && deathRecap.el.classList.contains('visible') ? 1 : 0,
            game.isDead ? 1 : 0, game.health, game.playerDeaths || 0];
        return out;
    };

    // One scenario: setup (before the clock starts), then `frames` frames with actions at given frames;
    // a snapshot every `every` frames. Returns { trace, errors }.
    window.__scenario = (spec, T0) => {
        const realPerf = performance.now.bind(performance), realDate = Date.now, realRandom = Math.random;
        let seed = spec.seed || 20221, k = 0;
        const errors = [], trace = [];
        const now = () => T0 + k * (1000 / 60);
        // nothing drawn (spec.noRender): drawing changes nothing the snapshot reads, and it is most of a frame's time
        const realRender = renderer.render;
        if (spec.noRender) renderer.render = function () {};
        // The clock both builds read is game time as V2.2 keeps it: inside a 60 Hz step that step's own time, between
        // steps the step clock plus what waits to be simulated. V2.1 read the real clock there (the same in every step
        // of a frame); V2.2 reads game time. So the timer fix itself (V2.2 PR 1) gives no difference here, and the
        // frames' 0- and 2-step pairs (the frame times round so) give none either.
        const realStep = window.stepSimulation;
        let inStep = 0;
        window.stepSimulation = function (dt, t) { inStep++; try { return realStep(dt, t); } finally { inStep--; } };
        try {
            window.__clock = T0;
            simClock = T0; simAccumulator = 0;
            performance.now = () => (inStep ? simClock : simClock + simAccumulator * 1000);
            Date.now = () => 1.7e12 + performance.now();
            Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
            if (typeof gameNow === 'function') { gameTime = T0; gameClock = T0; }   // V2.2: game time on the same clock
            timingResetPending = true;
            // the old timers are due at once (both builds the same)
            for (const t of __timers) t.at = Math.min(t.at, T0);
            __setup(spec);
            const frame = () => {
                // timers due by this frame's time, in time order
                for (;;) {
                    let best = -1;
                    for (let i = 0; i < __timers.length; i++) if (__timers[i].at <= __clock && (best < 0 || __timers[i].at < __timers[best].at || (__timers[i].at === __timers[best].at && __timers[i].id < __timers[best].id))) best = i;
                    if (best < 0) break;
                    const t = __timers[best];
                    if (t.every) t.at += t.every; else __timers.splice(best, 1);
                    try { typeof t.fn === 'function' ? t.fn(...(t.args || [])) : (0, eval)(String(t.fn)); } catch (e) { errors.push('timer: ' + e.message); }
                }
                const q = __rafQ; __rafQ = [];
                for (const cb of q) { try { cb(__clock); } catch (e) { errors.push(k + ': ' + e.message + ' @ ' + String(e.stack || '').split('\n')[1]); } }
            };
            for (k = 0; k < spec.frames; k++) {
                __clock = now();
                if (spec.keepAlive && !(spec.keepAliveUntil >= 0 && k >= spec.keepAliveUntil)) { game.health = 100; game.shield = 50; game.isDead = false; }
                const acts = spec.acts && spec.acts[k];
                if (acts) for (const a of acts) { try { __act(a); } catch (e) { errors.push('act ' + JSON.stringify(a) + ': ' + e.message); } }
                if (spec.shootEvery && k % spec.shootEvery === 0 && k > 0) { try { __aimShoot(); } catch (e) { errors.push('shoot: ' + e.message); } }
                frame();
                if (k % (spec.every || 6) === 0) trace.push(__snap());
            }
            trace.push(__snap());
        } finally {
            performance.now = realPerf; Date.now = realDate; Math.random = realRandom;
            renderer.render = realRender;
            window.stepSimulation = realStep;
            window.__simT = now();
        }
        return { trace, errors };
    };

    // Setup: map, mode, you, the abilities ready, no ability item out
    window.__setup = (spec) => {
        if (spec.map && game.mapPreset !== spec.map) tacticalDirector.cycleMapPreset(spec.map);
        game.userSettings.infiniteAbilities = !!spec.ability;
        game.userSettings.infiniteUlt = !!spec.ability;
        // no ability item left from before (the kit's clear, through the normal update paths next frame)
        const end = (it) => { if (!it || typeof it !== 'object' || it.isObject3D) return; if ('expireAt' in it) it.expireAt = 1; if ('endTime' in it) it.endTime = 1; if ('executeAt' in it) it.executeAt = 1; };
        for (const key of Object.keys(agentSystem)) {
            const v = agentSystem[key];
            if (Array.isArray(v)) { for (const it of v) if (it && typeof it === 'object' && ('inUse' in it || 'active' in it)) end(it); }
            else if (v && typeof v === 'object' && ('inUse' in v || 'active' in v)) end(v);
        }
        for (const p of agentSystem.projectiles) if (p.inUse) { p.inUse = false; p.mesh.visible = false; }
        game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
        if (castFX.active) { castFX.active = null; castFX.hide(); }
        if (spec.mode) tacticalDirector.setGameMode(spec.mode);
        if (spec.agent) agentSystem.selectAgent(spec.agent);
        const cc = characterController, L = mapLayout();
        const at = spec.at || (L.start ? [L.start.x, cc.standHeight, L.start.z] : [0, cc.standHeight, 22]);
        cc.position.set(at[0], at[1], at[2]); cc.prevSimPosition.copy(cc.position); if (cc.velocity) cc.velocity.set(0, 0, 0);
        camera.position.copy(cc.position);
        const aim = spec.aim || [0, (L.start && typeof L.start.yaw === 'number') ? L.start.yaw : 0];
        camera.rotation.set(aim[0], aim[1], 0, 'YXZ');
        if (cc.targetRotation) cc.targetRotation.y = aim[1];
        game.health = 100; game.shield = 50; game.isDead = false;
        // the wingmen move on the frame clock: before the driver took over they moved on the real one
        (tacticalEnhancements.wingmanBots || []).forEach((w, i) => {
            w.patrolPhase = i * Math.PI; w.lastFireAt = 0;
            w.group.position.set(cc.position.x + w.offsetX, 0, cc.position.z + w.offsetZ); w.group.rotation.set(0, 0, 0);
        });
    };

    // Aim at the nearest live bot you can see and fire three rounds
    window.__aimShoot = () => {
        const cc = characterController;
        let best = null, bd = 1e9;
        for (const e of enemyObjects) {
            if (!e.isActive || e.hit) continue;
            const d = e.mesh.position.distanceTo(cc.position);
            if (d < bd && d < 60) { bd = d; best = e; }
        }
        if (!best) return;
        const dx = best.mesh.position.x - cc.position.x, dz = best.mesh.position.z - cc.position.z, dy = best.mesh.position.y + 1.3 - cc.position.y;
        const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
        camera.rotation.set(pitch, yaw, 0, 'YXZ');
        if (cc.targetRotation) cc.targetRotation.y = yaw;
        for (let i = 0; i < 3; i++) { game.lastShot = 0; shoot(); }
    };

    // The kit's recipes, run inside the scenario (tests/hifi-kit.js cast)
    window.__act = (a) => {
        const cc = characterController;
        if (a.cast) {
            const [agent, slot] = a.cast.split('.'), r = a.r || {};
            agentSystem.selectAgent(agent);
            game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
            if (castFX.active) { castFX.active = null; castFX.hide(); }
            const at = r.at || a.spot, aim = r.aim || [-0.3, 0];
            cc.position.set(at[0], at[1], at[2]); cc.prevSimPosition.copy(cc.position);
            camera.position.copy(cc.position);
            camera.rotation.set(aim[0], aim[1], 0, 'YXZ');
            if (cc.targetRotation) cc.targetRotation.y = aim[1];
            if (r.away) for (const x of enemyObjects) { if (!x.isActive || x.hit) continue; x.mesh.position.set(40, 0, -40); x.poseDirty = true; syncEnemyBroadphase(x); }
            if (r.target) {
                const e = enemyObjects.find((x) => x.isActive && !x.hit);
                if (e) { window.__tgt = e; e.mesh.position.set(r.target[0], 0, r.target[1]); e.poseDirty = true; if (r.tough) e.health = Math.max(e.health, 1e6); syncEnemyBroadphase(e); }
            }
            if (r.orb) agentSystem.onActorEliminated('enemy', new THREE.Vector3(r.orb[0], 0, r.orb[1]));
            if (slot === 'x') { game.ultPoints = game.maxUltPoints; agentSystem.castAbility('x'); if (r.xFire) agentSystem.castAbility('x'); }
            else agentSystem.castAbility(slot);
        }
        if (a.again) agentSystem.castAbility(a.again.split('.')[1]);
        if (a.fire) { game.lastShot = 0; shoot(); }
        // V2.3: a lethal hit from the nearest live bot (the kill cam and the death recap run on it)
        if (a.kill) {
            let best = null, bd = 1e9;
            for (const e of enemyObjects) {
                if (!e.isActive || e.hit) continue;
                const d = e.mesh.position.distanceTo(cc.position);
                if (d < bd) { bd = d; best = e; }
            }
            if (best) takeDamage(999, best.mesh.position.clone(), { enemy: best });
            window.__killedBy = best ? enemyObjects.indexOf(best) : -1;
        }
    };
};

// --profile off: the V2.3 settings off where this build has them, and the arena polish off (design 17.3)
const PROFILE_OFF = () => {
    const u = game.userSettings, changed = [];
    const set = (k, v) => { if (k in u) { u[k] = v; changed.push(k + '=' + v); } };
    set('agentIdentity', 'off');
    set('weaponAnims', 'classic');
    set('botUtility', 'classic');
    if (typeof V23 !== 'undefined') {
        if (V23.arena) { V23.arena.enabled = false; changed.push('V23.arena.enabled=false'); }
        if (V23.core && V23.core.applySettings) V23.core.applySettings(u, null);
    }
    if (typeof settingsManager !== 'undefined' && settingsManager.syncAllUI) settingsManager.syncAllUI();
    return changed;
};

// ---- the builds --------------------------------------------------------------------------------------------------
let browser = null;
const label = (file) => path.basename(file);
async function open(file, viewport, opts = {}) {
    const profile = opts.profile || PROFILE;
    if (!browser) browser = await chromium.launch({ args: LAUNCH_ARGS });
    const ctx = await browser.newContext({ viewport: viewport || { width: 320, height: 180 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.addInitScript(() => { window.__skipMainMenu = true; });
    await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ body: THREE_JS, contentType: 'application/javascript' }));
    await page.route((url) => !url.href.startsWith('file:') && !url.href.startsWith('https://cdnjs.cloudflare.com'), (r) => r.abort());
    await page.goto('file://' + file, { timeout: 300000 });
    await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0, null, { timeout: 300000 });
    const b = { page, errors, file, ctx, T: 5e6, profile: [], profileName: profile };
    if (opts.keepQuality) return b;
    if (profile === 'off') b.profile = await page.evaluate(PROFILE_OFF);
    // the same manual quality in both (Auto would switch on frame times); 'low' keeps the frames cheap
    await page.evaluate(() => setQualitySettings('low'));
    const f0 = await page.evaluate(() => frameIndex);
    await page.waitForFunction((f0) => frameIndex >= f0 + 12, f0, { timeout: 120000, polling: 50 });
    await page.evaluate(DRIVER);
    // the real frame already asked for re-registers itself into the queue
    for (let i = 0; i < 600 && !(await page.evaluate(() => __rafQ.length > 0)); i++) await new Promise((r) => setTimeout(r, 50));
    return b;
}
async function run(b, spec) {
    const r = await b.page.evaluate(([spec, T0]) => __scenario(spec, T0), [spec, b.T]);
    b.T += Math.ceil((spec.frames + 60) * 1000 / 60) + 1000;   // the clock never goes back (both builds the same)
    return r;
}
function firstDiff(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const x = JSON.stringify(a[i]), y = JSON.stringify(b[i]);
        if (x === y) continue;
        // which parts differ
        const parts = [];
        if (a[i] && b[i]) for (const k of Object.keys(Object.assign({}, a[i], b[i]))) if (JSON.stringify(a[i][k]) !== JSON.stringify(b[i][k])) parts.push(k);
        return { at: i, parts, a: a[i] && parts.length ? Object.fromEntries(parts.map((k) => [k, a[i][k]])) : a[i], b: b[i] && parts.length ? Object.fromEntries(parts.map((k) => [k, b[i][k]])) : b[i] };
    }
    return null;
}
const short = (o) => { const s = JSON.stringify(o); return s.length > 900 ? s.slice(0, 900) + '...' : s; };
// keys only in one object, and values that differ
function keyDiff(x, y) {
    x = x || {}; y = y || {};
    const onlyA = Object.keys(x).filter((k) => !(k in y)), onlyB = Object.keys(y).filter((k) => !(k in x));
    const changed = Object.keys(y).filter((k) => k in x && JSON.stringify(x[k]) !== JSON.stringify(y[k]));
    return { onlyA: Object.fromEntries(onlyA.map((k) => [k, x[k]])), onlyB: Object.fromEntries(onlyB.map((k) => [k, y[k]])), changed: Object.fromEntries(changed.map((k) => [k, [x[k], y[k]]])) };
}

// ---- parts ---------------------------------------------------------------------------------------------------------
async function partDefaults() {
    const out = {};
    for (const [lab, file] of [['a', FILE_A], ['b', FILE_B]]) {
        const b = await open(file, null, { keepQuality: true });
        out[lab] = await b.page.evaluate(() => ({
            defaults: typeof DEFAULT_USER_SETTINGS !== 'undefined' ? JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS)) : null,
            settings: JSON.parse(JSON.stringify(game.userSettings)),
            quality: adaptiveSettings.currentQuality, autoQuality: qualityController.auto,
            ea: typeof enhancedAnim !== 'undefined' ? { on: enhancedAnim.on, built: enhancedAnim.built } : null,
            hf: typeof abilityLook !== 'undefined' ? { mode: abilityLook.mode, built: !!abilityLook.root } : null,
            mech: typeof botMechanics !== 'undefined' ? botMechanics.enabled() : null,
            audio: { ctx: !!ambientAudio.ctx, chords: ambientAudio.chordsPlayed, events: ambientAudio.eventsPlayed },
            ultra: ultraRealism.active,
            v23: typeof V23 !== 'undefined' ? { contract: V23.CONTRACT ? V23.CONTRACT.version : null, modules: Object.keys(V23).filter((k) => V23[k] && typeof V23[k] === 'object' && k !== 'CONTRACT') } : null,
            programs: [renderer.info.programs.length, perfTelemetry.programWatermark, perfTelemetry.firstUseStalls]
        }));
        out[lab].errors = b.errors.slice();
        await b.ctx.close();
    }
    const strip = (o) => Object.assign({}, o, { defaults: undefined, settings: undefined });
    const r = {
        part: 'defaults', a: label(FILE_A), b: label(FILE_B),
        defaults: keyDiff(out.a.defaults, out.b.defaults),
        settings: keyDiff(out.a.settings, out.b.settings),
        state: { a: strip(out.a), b: strip(out.b) }
    };
    log(r);
    const fmt = (d) => `only in a ${JSON.stringify(d.onlyA)}, only in b ${JSON.stringify(d.onlyB)}, values differ ${JSON.stringify(d.changed)}`;
    say('defaults DEFAULT_USER_SETTINGS:', fmt(r.defaults));
    say('defaults game.userSettings at start:', fmt(r.settings));
    say('defaults state a', short(r.state.a));
    say('defaults state b', short(r.state.b));
}

async function partViews() {
    // Map views, nothing moving in them: bots out, wingmen off, the gun hidden; the canvas only (no HUD)
    const VIEWS = [[0, 1.7, 0, 0, 0], [0, 1.7, 0, -0.2, Math.PI / 2], [0, 1.7, 0, 0.1, Math.PI], [-30, 4, 30, -0.3, -Math.PI / 4], [30, 8, -30, -0.4, Math.PI * 0.75]];
    const shots = {};
    const profile = profileFor('views');
    if (profile !== 'off') say('views WARNING: --profile defaults; from WP11 on, Ascent differs there by design (design 17.3 compares views with --profile off)');
    say('views profile', profile);
    for (const [lab, file] of [['a', FILE_A], ['b', FILE_B]]) {
        const b = await open(file, { width: 480, height: 270 }, { profile });
        // V2.3: no pointer lock here. mainMenu.resume() asks for it; when the browser grants it, the lock comes and
        // goes asynchronously, between this driver's evaluate calls, and mainMenu.onPointerLockChange opens the pause
        // menu on a lost lock: a real-time event that put one build's later maps in another menu state (seen once:
        // Haven to Skyline differed in one run of three, scene graphs otherwise equal)
        await b.page.evaluate(() => { Element.prototype.requestPointerLock = function () {}; document.exitPointerLock = function () {}; });
        await b.page.evaluate(() => setQualitySettings('medium'));
        shots[lab] = {};
        for (const map of ['ascent', 'bind', 'haven', 'icebox', 'lotus', 'split', 'skyline']) {
            shots[lab][map] = await b.page.evaluate(([map, VIEWS, T0]) => {
                const spec = { map, mode: 'wave', frames: 2 };
                __scenario(spec, T0);
                for (const e of enemyObjects) { e.isActive = false; e.hit = true; e.renderActive = false; if (e.broadKeys) actorBroadphase.remove(e); }
                tacticalEnhancements.toggleWingmanAI(false);
                weaponGroup.visible = false;
                mainMenu.show('pause');   // nothing steps: the frames below only draw
                const out = [];
                for (let vi = 0; vi < VIEWS.length; vi++) {
                    const v = VIEWS[vi];
                    const cc = characterController;
                    cc.position.set(v[0], v[1], v[2]); cc.prevSimPosition.copy(cc.position);
                    camera.position.copy(cc.position);
                    camera.rotation.set(v[3], v[4], 0, 'YXZ');
                    if (cc.targetRotation) cc.targetRotation.y = v[4];
                    const spec2 = { frames: 4 }, setup = window.__setup;
                    window.__setup = () => {};
                    try { __scenario(spec2, T0 + 100000 + vi * 1000); } finally { window.__setup = setup; }
                    const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
                    const px = new Uint8Array(w * h * 4);
                    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
                    out.push(Array.from(px));
                }
                mainMenu.resume();
                return out;
            }, [map, VIEWS, b.T]);
            b.T += 300000;
        }
        log({ part: 'views', build: lab, file: label(file), profileName: profile, profile: b.profile, errors: b.errors.slice() });
        await b.ctx.close();
    }
    for (const map of Object.keys(shots.a)) {
        const res = shots.a[map].map((a, i) => {
            const b = shots.b[map][i];
            let diff = 0, maxd = 0;
            for (let j = 0; j < a.length; j += 4) { const d = Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2]); if (d) diff++; if (d > maxd) maxd = d; }
            return { view: i, pixelsDiffer: diff, of: a.length / 4, maxDiff: maxd };
        });
        if (res.some((r) => r.pixelsDiffer)) differences++;
        log({ part: 'views', map, res });
        say('views', map, JSON.stringify(res.map((r) => r.pixelsDiffer + '/' + r.maxDiff)));
    }
}

async function partGame() {
    const noRender = !RENDER;
    const SCEN = [];
    for (const map of ['ascent', 'bind', 'haven', 'icebox', 'lotus', 'split', 'skyline']) SCEN.push({ name: 'wave-' + map, map, mode: 'wave', frames: 900, shootEvery: 45, keepAlive: true, noRender });
    SCEN.push({ name: 'match-ascent', map: 'ascent', mode: 'match', frames: 2400, shootEvery: 60, keepAlive: true, noRender });
    SCEN.push({ name: 'match-bind', map: 'bind', mode: 'match', frames: 2400, shootEvery: 60, keepAlive: true, noRender });
    SCEN.push({ name: 'match-haven', map: 'haven', mode: 'match', frames: 2400, shootEvery: 60, keepAlive: true, noRender });
    SCEN.push({ name: 'spikerush-lotus', map: 'lotus', mode: 'spikerush', frames: 1800, shootEvery: 60, keepAlive: true, noRender });
    SCEN.push({ name: 'ranked-split', map: 'split', mode: 'ranked', frames: 1800, shootEvery: 60, keepAlive: true, noRender });
    SCEN.push({ name: 'deathmatch-icebox', map: 'icebox', mode: 'deathmatch', frames: 1200, shootEvery: 45, keepAlive: true, noRender });
    SCEN.push({ name: 'retake-skyline', map: 'skyline', mode: 'retake', frames: 1200, shootEvery: 45, keepAlive: true, noRender });
    SCEN.push({ name: 'range-ascent', map: 'ascent', mode: 'range', frames: 900, shootEvery: 30, keepAlive: true, noRender });
    SCEN.push({ name: 'aim-ascent', map: 'ascent', mode: 'aim', frames: 900, shootEvery: 30, keepAlive: true, noRender });
    // V2.3: a death with its kill cam (alloff.js kept you alive throughout, so no replay hook ever ran): alive for
    // 300 frames (the replay ring fills), a lethal hit from the nearest bot, then 900 frames: the kill cam starts
    // 650 ms after the death, plays about 7 s (its last half second slowed), and you respawn after it
    SCEN.push({ name: 'killcam-ascent', map: 'ascent', mode: 'wave', frames: 1200, shootEvery: 45, keepAlive: true, keepAliveUntil: 300, acts: { 300: [{ kill: true }] }, every: 4, noRender });
    await compare(SCEN, 'game');
}

async function partAbilities() {
    const kit = require(path.join(REPO, 'tests', 'hifi-kit'));   // RECIPES and SPOT only (nothing here boots through it)
    const keys = KEYS ? String(KEYS).split(',') : (() => {
        const all = [];
        for (const a of ['jett', 'phoenix', 'reyna', 'raze', 'yoru', 'neon', 'iso', 'waylay', 'omen', 'brimstone', 'viper', 'clove', 'harbor', 'astra', 'miks', 'sova', 'kayo', 'skye', 'fade', 'breach', 'gekko', 'tejo', 'sage', 'killjoy', 'cypher', 'chamber', 'deadlock', 'vyse', 'veto'])
            for (const s of ['c', 'q', 'e', 'x']) all.push(a + '.' + s);
        return all;
    })();
    // the role files' recipe overrides
    const ROLE = {};
    { const real = kit.roleTest; kit.roleTest = (role, ab, o) => Object.assign(ROLE, (o && o.recipes) || {}); for (const r of ['duelists', 'controllers', 'initiators', 'sentinels']) require(path.join(REPO, 'tests', 'hifi-' + r + '.test.js')); kit.roleTest = real; }
    const SCEN = keys.map((k) => {
        const r = Object.assign({}, kit.RECIPES[k] || {}, ROLE[k] || {});
        const acts = { 20: [{ cast: k, r, spot: kit.SPOT }] };
        const step = (ms) => 20 + Math.round(ms * 60 / 1000);
        if (r.again) (acts[step(r.again)] = acts[step(r.again)] || []).push({ again: k });
        if (r.fire) for (let i = 0; i < r.fire; i++) (acts[step((i + 1) * (r.fireMs || 120))] = acts[step((i + 1) * (r.fireMs || 120))] || []).push({ fire: true });
        return { name: k, map: 'ascent', mode: 'wave', ability: true, frames: 420, acts, keepAlive: true, every: +(EVERY || 3), noRender: !RENDER };
    });
    await compare(SCEN, 'abilities');
}

// Each scenario in both builds; on a difference both builds start again from a fresh boot, so the next
// scenario starts from the same state
async function compare(SCEN, part) {
    if (ONLY) SCEN = SCEN.filter((s) => String(ONLY).split(',').includes(s.name));
    if (!SCEN.length) { say(part, 'no scenario selected'); return; }
    const profile = profileFor(part);
    let a = await open(FILE_A, null, { profile }), b = await open(FILE_B, null, { profile });
    if (profile === 'off') say(part, 'profile off:', 'a', JSON.stringify(a.profile), 'b', JSON.stringify(b.profile));
    for (const s of SCEN) {
        const t0 = Date.now();
        const ra = await run(a, s), rb = await run(b, s);
        const d = firstDiff(ra.trace, rb.trace);
        const errs = { a: ra.errors.slice(0, 5).concat(a.errors.splice(0)), b: rb.errors.slice(0, 5).concat(b.errors.splice(0)) };
        const same = !d && JSON.stringify(errs.a) === JSON.stringify(errs.b);
        if (!same) differences++;
        const r = { part, name: s.name, samples: ra.trace.length, same, diff: d, errors: errs, realS: +((Date.now() - t0) / 1000).toFixed(1) };
        // what went on in it (from the first build): the most ability items out at once, bots and you moved
        const act = { itemsMax: 0, kinds: {}, youMoved: 0, botsMoved: 0, replaySamples: 0, deaths: 0 };
        for (const t of ra.trace) {
            act.itemsMax = Math.max(act.itemsMax, t.items.length); for (const it of t.items) act.kinds[it[0]] = (act.kinds[it[0]] || 0) + 1;
            if (t.replay && t.replay[0]) { act.replaySamples++; act.replayKinds = act.replayKinds || {}; act.replayKinds[t.replay[0][0]] = (act.replayKinds[t.replay[0][0]] || 0) + 1; }
            if (t.recap) act.deaths = Math.max(act.deaths, t.recap[5]);
        }
        const t0s = ra.trace[0], t1s = ra.trace[ra.trace.length - 1];
        if (t0s && t1s) {
            act.youMoved = +Math.hypot(t1s.you[0][0] - t0s.you[0][0], t1s.you[0][2] - t0s.you[0][2]).toFixed(2);
            for (let i = 0; i < t0s.bots.length; i++) { const a0 = t0s.bots[i], a1 = t1s.bots[i]; if (a0 && a1 && a0[1] && a1[1] && a0[1].length === 3 && a1[1].length === 3) act.botsMoved += Math.hypot(a1[1][0] - a0[1][0], a1[1][2] - a0[1][2]); }
            act.botsMoved = +act.botsMoved.toFixed(1);
        }
        r.activity = act;
        if (DUMP) r.dump = { a: ra.trace.map((t) => t.items), b: rb.trace.map((t) => t.items) };
        log(r);
        say(part, s.name, ra.trace.length + ' samples', d ? 'DIFFERS at ' + d.at + ' ' + JSON.stringify(d.parts) : (same ? 'same' : 'errors differ'), 'errors', errs.a.length + '/' + errs.b.length, r.realS + ' s', 'activity', JSON.stringify(act));
        if (d) {
            say('   a', short(d.a));
            say('   b', short(d.b));
        }
        if (!same) {
            await a.ctx.close(); await b.ctx.close();
            a = await open(FILE_A, null, { profile }); b = await open(FILE_B, null, { profile });
        }
    }
    await a.ctx.close(); await b.ctx.close();
}

(async () => {
    const t0 = Date.now();
    const profiles = Object.fromEntries(PARTS.map((p) => [p, profileFor(p)]));
    log({ parts: PARTS, start: new Date().toISOString(), a: FILE_A, b: FILE_B, profile: PROFILE_ARG || null, profiles, only: ONLY || null, keys: KEYS || null });
    say('a', label(FILE_A), '| b', label(FILE_B), '| parts', PARTS.join(','), '| profiles', JSON.stringify(profiles), '| log', LOG);
    for (const p of ALL_PARTS) {
        if (PARTS.indexOf(p) < 0) continue;
        if (p === 'defaults') await partDefaults();
        if (p === 'views') await partViews();
        if (p === 'game') await partGame();
        if (p === 'abilities') await partAbilities();
    }
    log({ parts: PARTS, end: new Date().toISOString(), totalS: Math.round((Date.now() - t0) / 1000), differences });
    say('done', Math.round((Date.now() - t0) / 1000) + ' s', differences ? differences + ' difference(s)' : 'no differences');
    if (browser) await browser.close();
    process.exitCode = differences ? 1 : 0;
})().catch(async (e) => { console.error(e); log({ parts: PARTS, crash: String(e && e.stack || e) }); if (browser) await browser.close(); process.exit(1); });
