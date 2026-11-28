'use strict';
// V2.3 agent sound (WP10; design 12, 17.1). One boot on Ascent, bots frozen (the last subtest moves to Icebox and Split
// for their rope decks). The AudioContext's node creation is spied (every oscillator, filter, buffer source, gain and
// panner the game makes, with its scheduled values and its connections), and V23.audio's own trace says which recipe
// made each voice. It checks:
//  - boot: no AudioContext and no shared buffer before the first user gesture, and no V2.3 event (motif, sting, bot
//    cue, atShared, a trial, a preview with no user activation) makes one; the gesture listeners are the activation
//    events (a touch pointerdown waits for its pointerup); identity off at a gesture builds nothing (V2.2's timing);
//    the gesture builds the context and the noise and reverb buffers (V23.audio.prebuild) with no draw from the game's
//    Math.random stream; soundEnabled off at the first gesture waits for the next;
//  - palettes, from what the engine plays: every full look's resolved sound field equals its design family's
//    reference vector field by field; the resolved full-look palettes are pairwise distinct and same-role ones differ
//    in wave or interval set; the 29 reference vectors (what the role batches copy) are too; every agent resolves to a
//    known family (a stub to its role default); each family's reference vector played through the engine
//    (state.trial) gives a 2-voice motif at <= 0.06 and a 3-voice sting, no detuned pair summing above its voice's gain,
//    and all 10 recipes; prints the motif table and the V23MATRIX 'sound palette distinct' cells, computed from the
//    resolved palettes (a stub shares its role default, so its cell is open until its role batch);
//  - Sage (glass) and Omen (void): their motif node graphs differ in wave, intervals and filter (reported), each
//    motif is 2 voices at gain <= 0.06; a real cast (castAbility) plays the ability's own method at t 0 and the motif at
//    the gesture's release key; the ultimate sting is 3 voices, also from a real ultimate;
//  - positional events: one gain and one HRTF panner per event (a bot's cast, windup and warning sting; the mortar's
//    sting placed at the hazard), the occlusion low-pass on the shared path;
//  - surface steps: a piece of each surface id (Ascent's concrete, stone, metal and wood piece tops: walls and roofs,
//    the mapping only) gives that enemyStep kind; where Ascent's bots really walk (every open nav cell at y 0) the
//    open-floor rule answers; a box that is no map piece (a barrel) gives V2.2's step; open floor follows the player's
//    weather rule; the cache; footwear from the look, its tones kept on every surface; enemyStep(kind) makes one noise
//    call (filter and duration of the surface), its tones and one panner, with exactly 1 Math.random; enemyStep() makes
//    V2.2's nodes exactly, with 1 Math.random; neither touches the player's step counters; the live enemyAudio path
//    passes the kind; on Icebox's container deck (a rope deck: the piece tops a V2.2 bot reaches, botMechanics on) the
//    live path, with botMechanics._air walking the bot, gives metal steps with its footwear; Split's decks are metal
//    and concrete pieces (concrete while the open-floor rule would say snow);
//  - settings: soundEnabled off makes no node, enemyFootsteps off and the 22 m range make no step, positionalAudio off
//    makes no panner and leaves a bot cue's bus at unity (V2.2's level for positional sounds then), masterVolume scales
//    every voice, Agent Identity off silences the in-match layers (previews stay), headshotVolume still scales the dink
//    and no V2.3 voice joins it;
//  - previews: Sage's chime and Omen's tear and 10 plate clacks on a bus of their own (no reverb), the cast's own soundFX
//    methods inside V23.seeded, the bus ramped to 0 in 30 ms by the next preview or preview(null), soundFX._out honoured;
//  - no Math.random from any V2.3 sound; programs equal the warm-up watermark, no first-use stalls.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');
const kit = require('./hifi-kit');

after(closeBrowser);

const ROLE = process.env.ROLE ? String(process.env.ROLE).toUpperCase() : null;
const matrix = (agent, column, ok, detail) => console.log('V23MATRIX ' + JSON.stringify({ agent, column, ok: !!ok, detail: detail === undefined ? '' : detail }));

// In the page before any game script: pointer lock stubbed (headless leaks), AudioContext constructions counted with
// their stacks, and the game's Math.random counted while a gesture's listeners run, by whether prebuild is on the stack
function init() {
    Element.prototype.requestPointerLock = function () {};
    document.exitPointerLock = function () {};
    const AC = window.AudioContext || window.webkitAudioContext;
    window.__ac = { n: 0, stacks: [] };
    if (AC) {
        const Wrapped = function () { window.__ac.n++; window.__ac.stacks.push(String(new Error().stack)); return new AC(...arguments); };
        Wrapped.prototype = AC.prototype;
        window.AudioContext = Wrapped;
        if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
    }
    window.__rnd = { armed: false, prebuild: 0, all: 0 };
    const real = Math.random;
    Math.random = function () {
        if (window.__rnd.armed) {
            window.__rnd.all++;
            if (/prebuild|_ensureReverb|_noise/.test(String(new Error().stack))) window.__rnd.prebuild++;
        }
        return real();
    };
    // armed before the game's own listeners (this one is registered first, in the capture phase), disarmed after them
    for (const t of ['pointerdown', 'pointerup', 'keydown', 'touchend']) window.addEventListener(t, () => { window.__rnd.armed = true; setTimeout(() => { window.__rnd.armed = false; }, 0); }, true);
}

test('agent sound: palettes, motifs, stings, positional cues, surface steps, previews and settings', { timeout: 600000 }, async (t) => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', initScript: init });

    // ---- boot and the first gesture ------------------------------------------------------------------------------
    await t.test('nothing is built and no AudioContext is made before the first gesture; the gesture builds the buffers quietly', async () => {
        const before = await evaluate(() => ({ ac: __ac.n, ctx: !!soundFX.ctx, nb: !!soundFX._noiseBuffer, rv: soundFX._reverb, listening: V23.audio.state.listening, prebuilt: V23.audio.state.prebuilt, map: game.mapPreset,
            gestures: V23.audio.state.gestures, identity: V23.core.enabled() }));
        assert.equal(before.map, 'ascent');
        assert.equal(before.identity, true, 'Agent Identity on by default');
        assert.equal(before.ac, 0, 'no AudioContext at boot');
        assert.deepEqual([before.ctx, before.nb, before.rv], [false, false, null], 'no context, noise buffer or reverb at boot');
        assert.deepEqual([before.listening, before.prebuilt], [true, false], 'the gesture listeners wait');
        assert.deepEqual(before.gestures, ['pointerdown', 'pointerup', 'keydown', 'touchend'], 'the user-activation events (no touchstart)');
        // no V2.3 event makes a context: a motif, a sting, a bot's cues (WP8 sends them on its sim tick, with no gesture),
        // atShared, a trial, and a preview while the page holds no user activation (the harness's page.evaluate runs as a
        // user gesture, so for the preview the page's activation is stubbed off: no gesture, as on a showroom timer)
        const none = await evaluate(() => {
            const e = enemyObjects.find((x) => x.isActive && !x.hit), cc = characterController;
            V23.audio.motif('sage', 'c'); V23.audio.ultSting('omen');
            V23.audio.botCue(e, 'windup.smoke'); V23.audio.botCue(e, 'windup.flash'); V23.audio.botCue(e, 'arm.mortar', { x: cc.position.x, y: 0.07, z: cc.position.z });
            V23.audio.atShared(1, 1, 1, () => {}); V23.audio.state.trial(V23.audio.state.families.glass.v, 'motif', 'c');
            Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => ({ isActive: false, hasBeenActive: false }) });
            try { V23.audio.preview('sage', 'intro'); V23.audio.preview(null); } finally { delete navigator.userActivation; }
            return { ac: __ac.n, ctx: !!soundFX.ctx, events: V23.audio.state.stats.events, restored: typeof navigator.userActivation.isActive === 'boolean' && !Object.prototype.hasOwnProperty.call(navigator, 'userActivation') };
        });
        assert.deepEqual([none.ac, none.ctx, none.events], [0, false, 0], 'no V2.3 event makes an AudioContext (and none plays without one)');
        assert.ok(none.restored, 'navigator.userActivation restored');
        // a touch pointerdown is no activation (its pointerup is), nor is Escape: nothing is built
        const touch = await evaluate(() => {
            window.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { ac: __ac.n, listening: V23.audio.state.listening, prebuilt: V23.audio.state.prebuilt };
        });
        assert.deepEqual(touch, { ac: 0, listening: true, prebuilt: false }, 'a touch pointerdown or Escape: no context, still listening');
        // Agent Identity off at a gesture: nothing is built (V2.2's timing: the context waits for V2.2's first sound). A
        // key that plays nothing (Shift: walk); a click in play would fire the rifle, whose gunshot makes the context in
        // V2.2 as well (probed: shoot > gunshot > noiseLayer > ensureContext in both builds)
        await evaluate(() => { game.userSettings.agentIdentity = 'off'; V23.core.applySettings(game.userSettings, 'agentIdentity'); });
        await page.keyboard.press('Shift');
        await frames(1);
        const idOff = await evaluate(() => ({ ac: __ac.n, ctx: !!soundFX.ctx, listening: V23.audio.state.listening, prebuilt: V23.audio.state.prebuilt }));
        await evaluate(() => { game.userSettings.agentIdentity = 'on'; V23.core.applySettings(game.userSettings, 'agentIdentity'); });
        assert.deepEqual(idOff, { ac: 0, ctx: false, listening: true, prebuilt: false }, 'identity off at the gesture: no context, still listening');
        // soundEnabled off at the first gesture: nothing is made, the listeners stay for the next one
        await evaluate(() => { game.soundEnabled = false; });
        await page.mouse.click(5, 5);
        await frames(1);
        const off = await evaluate(() => ({ ac: __ac.n, listening: V23.audio.state.listening, prebuilt: V23.audio.state.prebuilt }));
        assert.deepEqual(off, { ac: 0, listening: true, prebuilt: false }, 'sound off: no context, still listening');
        await evaluate(() => { game.soundEnabled = true; __rnd.all = 0; __rnd.prebuild = 0; });
        await page.mouse.click(5, 5);
        await frames(1);
        const after = await evaluate(() => ({ ac: __ac.n, fromPrebuild: /prebuild/.test(__ac.stacks[0] || ''), nb: !!soundFX._noiseBuffer, nbRate: soundFX._noiseBuffer && soundFX._noiseBuffer.sampleRate === soundFX.ctx.sampleRate,
            rv: !!(soundFX._reverb && soundFX._reverb.conv), listening: V23.audio.state.listening, prebuilt: V23.audio.state.prebuilt, rnd: Object.assign({}, __rnd) }));
        assert.equal(after.ac, 1, 'one AudioContext, at the gesture');
        assert.ok(after.fromPrebuild, 'made by V23.audio.prebuild');
        assert.deepEqual([after.nb, after.nbRate, after.rv], [true, true, true], 'the noise buffer and the reverb exist');
        assert.deepEqual([after.listening, after.prebuilt], [false, true], 'listeners removed once built');
        assert.equal(after.rnd.prebuild, 0, `no draw from the game's Math.random while the buffers were built (${after.rnd.all} draws by the game's own listeners)`);
    });

    // ---- the spy -------------------------------------------------------------------------------------------------
    await evaluate((SPOT) => {
        window.updateEnemies = () => {};
        try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {}
        tacticalDirector.setGameMode('range');
        window.updateEnemies = () => {};
        game.userSettings.infiniteAbilities = true;
        game.userSettings.infiniteUlt = true;
        window.__SPOT = SPOT;
        const ctx = window.__ctx = soundFX.ensureContext();
        const S = window.__spy = { on: true, nodes: [] };
        const M = ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setValueCurveAtTime', 'setTargetAtTime'];
        const wrapParam = (rec, name, p) => {
            const log = rec.p[name] = [];
            for (const m of M) { const o = p[m].bind(p); p[m] = function (v, a, b) { log.push([m, v && v.length !== undefined ? Math.max.apply(null, Array.from(v)) : v, a]); return o(v, a, b); }; }
        };
        const wrapNode = (kind, n) => {
            if (!S.on) return n;
            const rec = { kind, n, p: {}, to: [] };
            S.nodes.push(rec);
            const oc = n.connect.bind(n);
            n.connect = function (dst) { rec.to.push(dst); return oc.apply(null, arguments); };
            for (const k of ['frequency', 'gain', 'Q', 'detune']) if (n[k] instanceof AudioParam) wrapParam(rec, k, n[k]);
            return n;
        };
        for (const [m, kind] of [['createOscillator', 'osc'], ['createBiquadFilter', 'filter'], ['createBufferSource', 'noise'], ['createGain', 'gain'], ['createPanner', 'panner']]) {
            const o = ctx[m].bind(ctx);
            ctx[m] = function () { return wrapNode(kind, o()); };
        }
        const first = (log, m) => { const e = (log || []).find((x) => !m || x[0] === m); return e ? e[1] : undefined; };
        // the spied nodes since the last take, as plain data: kind, wave/type, start Hz, Q, peak gain, panner position, and
        // where each connects ('dest', another node's index, 'param' for an AudioParam, 'ext' for a node made earlier)
        window.__take = () => {
            const recs = S.nodes.slice();
            S.nodes.length = 0;
            const idx = new Map(recs.map((r, i) => [r.n, i]));
            return recs.map((r) => {
                const o = { k: r.kind };
                if (r.kind === 'osc') { o.type = r.n.type; const f = first(r.p.frequency, 'setValueAtTime'); o.f = +(f !== undefined ? f : r.n.frequency.value).toFixed(2); }
                if (r.kind === 'filter') { o.type = r.n.type; const f = first(r.p.frequency, 'setValueAtTime'); o.f = +(f !== undefined ? f : r.n.frequency.value).toFixed(1); o.q = +r.n.Q.value.toFixed(2); const e = first(r.p.frequency, 'exponentialRampToValueAtTime'); if (e !== undefined) o.f1 = +e.toFixed(1); }
                // a gain's peak: its scheduled values when it has automation (its .value still reads the default then), else .value
                if (r.kind === 'gain') { const log = (r.p.gain || []).filter((x) => x[0] !== 'exponentialRampToValueAtTime').map((x) => x[1]); o.peak = +(log.length ? Math.max.apply(null, log) : r.n.gain.value).toFixed(5); }
                if (r.kind === 'panner') o.pos = [r.n.positionX.value, r.n.positionY.value, r.n.positionZ.value].map((v) => +v.toFixed(3));
                o.to = r.to.map((d) => (d === ctx.destination ? 'dest' : idx.has(d) ? idx.get(d) : (d instanceof AudioParam ? 'param' : 'ext')));
                return o;
            });
        };
        // Math.random draws while fn runs
        window.__draws = (fn) => { const real = Math.random; let n = 0; Math.random = function () { n++; return real(); }; try { fn(); } finally { Math.random = real; } return n; };
        window.__bot = () => enemyObjects.find((x) => x.isActive && !x.hit);
        window.__identity = (on) => { game.userSettings.agentIdentity = on ? 'on' : 'off'; V23.core.applySettings(game.userSettings, 'agentIdentity'); };
        window.__lastTrace = (n) => V23.audio.state.trace.slice(-(n || 1));
        // no wall between by default (a deterministic graph); the occlusion check sets its own
        window.__occ = soundFX.isOccluded;
        soundFX.isOccluded = () => false;
        __take();
    }, kit.SPOT);

    // ---- palettes ------------------------------------------------------------------------------------------------
    await t.test('palettes from what the engine plays: full looks equal their family vector, distinct palettes, same-role pairs differ, every family through the engine', async () => {
        const r = await evaluate(() => {
            const F = V23.audio.state.families, out = { fam: [], pals: [], problems: [], trials: [] };
            const design = Object.keys(F).filter((k) => F[k].agent);
            out.design = design;
            out.recipes = V23.audio.state.recipes.slice();
            // the palette's sound fields (what a look carries and the engine reads), and a key for distinctness: those
            // fields and the family's recipes (two palettes with one key would play alike)
            const FIELDS = ['family', 'wave', 'base', 'intervals', 'noise', 'attack', 'tail', 'shimmer', 'sub', 'footwear'];
            const val = (x) => JSON.stringify(x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, k) => { o[k] = x[k]; return o; }, {}) : x);
            const key = (v, f) => FIELDS.filter((k) => k !== 'family').map((k) => val(v[k])).concat([f.motif.map((x) => x[0]).join('+'), f.sting.map((x) => x[0]).join('+'), f.cue[0]]).join('|');
            for (const k of design) {
                const f = F[k], def = AGENT_DEFS[f.agent];
                if (!def) { out.problems.push(k + ': no agent ' + f.agent); continue; }
                out.fam.push({ family: k, agent: f.agent, role: def.role, wave: f.v.wave, iv: f.v.intervals.join(' '), key: key(f.v, f) });
            }
            // every agent as the engine plays it: V23.audio.state.palette (the resolved look's sound field)
            for (const id of AGENT_ORDER) {
                const p = V23.audio.state.palette(id), fam = F[p.family], ref = design.find((k) => F[k].agent === id) || null;
                // a full look against its family's reference vector, field by field (the two copies cannot drift)
                const drift = (!p.stub && fam && fam.v) ? FIELDS.filter((k) => val(p[k]) !== val(fam.v[k])).map((k) => `${k} ${val(p[k])} vs ${val(fam.v[k])}`) : null;
                out.pals.push({ id, role: AGENT_DEFS[id].role, stub: p.stub, family: p.family, known: p.known, wave: p.wave, base: p.base, iv: p.intervals.join(' '),
                    noise: p.noise.type + ' ' + p.noise.f + ' Q' + p.noise.q, attack: p.attack, tail: p.tail, shimmer: p.shimmer, sub: p.sub, footwear: p.footwear,
                    motif: p.motif.join('+'), sting: p.sting.join('+'), cue: p.cue, roots: [p.roots.c, p.roots.q, p.roots.e].join(' / '), designFamily: ref,
                    hasV: !!(fam && fam.v), drift, key: fam ? key(p, fam) : null });
            }
            // each family's reference vector through the engine (state.trial), spied: the motif and the sting voices, and
            // every gain that mixes two oscillators (a detuned pair: its inputs' sum must stay at or under 1)
            for (const k of design) {
                __take();
                const m = V23.audio.state.trial(F[k].v, 'motif', 'c') || [];
                const gm = __take();
                const u = V23.audio.state.trial(F[k].v, 'ult') || [];
                const gu = __take();
                let mixes = 0, mixMax = 0;
                for (const g of [gm, gu]) g.forEach((n, i) => {
                    if (n.k !== 'gain') return;
                    const osc = g.filter((x) => x.k === 'osc' && x.to.includes(i)).length;
                    if (osc >= 2) { mixes++; mixMax = Math.max(mixMax, n.peak * osc); }
                });
                out.trials.push({ family: k, motif: m.map((v) => [v.r, v.gain]), ult: u.map((v) => [v.r, v.gain]), mixes, mixMax: +mixMax.toFixed(4),
                    recipes: m.concat(u).map((v) => v.r) });
            }
            return out;
        });
        // the reference table: 29 families, one per agent, pairwise distinct, same-role pairs differ in wave or intervals
        assert.equal(r.design.length, 29, '29 design families');
        assert.deepEqual(r.fam.map((x) => x.agent).sort(), await evaluate(() => AGENT_ORDER.slice().sort()), 'one family per AGENT_ORDER agent');
        assert.deepEqual(r.problems, []);
        assert.equal(r.recipes.length, 10);
        // the clashes in a set of palettes: the same key, or the same role with the same wave and interval set
        const distinct = (rows) => {
            const seen = new Map(), clash = [];
            for (const x of rows) { if (seen.has(x.key)) clash.push(`${seen.get(x.key)}=${x.name}`); else seen.set(x.key, x.name); }
            for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
                const a = rows[i], b = rows[j];
                if (a.role === b.role && a.wave === b.wave && a.iv === b.iv) clash.push(`${a.name}~${b.name}`);
            }
            return clash;
        };
        assert.deepEqual(distinct(r.fam.map((x) => ({ name: x.family, key: x.key, role: x.role, wave: x.wave, iv: x.iv }))), [], 'the 29 reference vectors: pairwise distinct, same-role pairs differ in wave or interval set');
        // what the game plays: every agent resolves; a stub to its role default; a full look to its design family, with
        // its sound field equal to the family's reference vector field by field
        const roleFam = { DUELIST: 'duelist', INITIATOR: 'initiator', CONTROLLER: 'controller', SENTINEL: 'sentinel' };
        for (const p of r.pals) {
            assert.ok(p.known, `${p.id}: a known family (${p.family})`);
            if (p.stub) assert.equal(p.family, roleFam[p.role], `${p.id}: a stub plays its role default`);
            else {
                assert.equal(p.family, p.designFamily, `${p.id}: a full look names its design family`);
                assert.ok(p.hasV, `${p.id}: its family has a reference vector`);
                assert.deepEqual(p.drift, [], `${p.id}: its resolved sound field equals the ${p.family} reference vector`);
            }
        }
        // the resolved full-look palettes: pairwise distinct, same-role ones differ in wave or interval set
        const rows = r.pals.map((p) => ({ name: p.id, key: p.key, role: p.role, wave: p.wave, iv: p.iv, stub: p.stub }));
        const full = rows.filter((x) => !x.stub);
        assert.ok(full.length >= 2, `full looks: ${full.map((x) => x.name).join(', ')}`);
        assert.deepEqual(distinct(full), [], 'resolved full-look palettes: pairwise distinct, same-role pairs differ in wave or interval set');
        // every family's reference vector through the engine: the motif 2 voices at <= 0.06, the sting 3 at <= 0.08, no
        // detuned pair above its voice's gain, all 10 recipes played
        const played = new Set();
        let mixes = 0;
        for (const tr of r.trials) {
            assert.equal(tr.motif.length, 2, `${tr.family}: a 2-voice motif`);
            for (const v of tr.motif) assert.ok(v[1] <= 0.06 + 1e-9, `${tr.family}: motif voice ${v[0]} gain ${v[1]} <= 0.06`);
            assert.equal(tr.ult.length, 3, `${tr.family}: a 3-voice sting`);
            for (const v of tr.ult) assert.ok(v[1] <= 0.08 + 1e-9, `${tr.family}: sting voice ${v[0]} gain ${v[1]} <= 0.08`);
            assert.ok(tr.mixMax <= 1 + 1e-9, `${tr.family}: a detuned pair sums to ${tr.mixMax} (<= 1, so the voice peaks at its gain)`);
            mixes += tr.mixes;
            tr.recipes.forEach((x) => played.add(x));
        }
        assert.ok(mixes >= 3, `detuned pairs exercised (${mixes})`);
        // the windup recipe is the family's cue (one per family); the motif and sting cover the rest
        const cues = await evaluate(() => Object.values(V23.audio.state.families).filter((f) => f.agent).map((f) => f.cue[0]));
        cues.forEach((x) => played.add(x));
        assert.deepEqual([...played].sort(), r.recipes.slice().sort(), 'every one of the 10 recipes is played');
        // V23MATRIX, computed from the resolved palettes of all 29 agents: distinct when no other agent's palette has its
        // key and no same-role agent shares its wave and interval set (and a full look equals its family vector); a stub
        // shares its role default with the other stubs of its role, so its cell stays open until its role batch
        const pals = r.pals.filter((x) => !ROLE || x.role === ROLE);
        console.log('# MOTIF agent | role | stub | family | wave | base | intervals | noise | attack | tail | shimmer | sub | footwear | motif | sting | windup | roots c/q/e | design family');
        for (const p of pals) {
            console.log(`# MOTIF ${p.id} | ${p.role} | ${p.stub ? 'stub (role default)' : 'full'} | ${p.family} | ${p.wave} | ${p.base} | ${p.iv} | ${p.noise} | ${p.attack} | ${p.tail} | ${p.shimmer} | ${p.sub} | ${p.footwear} | ${p.motif} | ${p.sting} | ${p.cue} | ${p.roots} | ${p.designFamily}`);
            const me = rows.find((x) => x.name === p.id), clash = [];
            for (const o of rows) if (o.name !== p.id && (o.key === me.key || (o.role === me.role && o.wave === me.wave && o.iv === me.iv))) clash.push(o.name);
            const ok = clash.length === 0 && (p.stub || (p.drift && p.drift.length === 0));
            matrix(p.id, 'sound palette distinct', ok, `${p.family} ${p.wave} ${p.base} Hz [${p.iv}]` + (clash.length ? `; shares wave and intervals with ${clash.slice(0, 4).join(', ')}${clash.length > 4 ? ' and ' + (clash.length - 4) + ' more' : ''}` : '') +
                (p.stub ? ` (role default until its role batch; its design family ${p.designFamily} is ready)` : ''));
        }
        console.log('# FAMILIES ' + r.fam.map((x) => `${x.family}(${x.agent}) ${x.wave} [${x.iv}]`).join('; '));
        console.log('# TRIALS ' + r.trials.map((x) => `${x.family}: ${x.motif.map((v) => v[0]).join('+')} / ${x.ult.map((v) => v[0]).join('+')}${x.mixes ? ' pair ' + x.mixMax : ''}`).join('; '));
    });

    // ---- Sage and Omen: motif graphs --------------------------------------------------------------------------------
    const motifGraph = (agent) => evaluate((agent) => {
        const out = { slots: {} };
        for (const s of ['c', 'q', 'e']) {
            __take();
            V23.audio.motif(agent, s);
            const g = __take(), tr = __lastTrace()[0];
            out.slots[s] = { g, trace: tr };
        }
        out.palette = V23.audio.state.palette(agent);
        return out;
    }, agent);
    await t.test("Sage's (glass) and Omen's (void) motif node graphs differ in wave, intervals and filter", async () => {
        const sage = await motifGraph('sage'), omen = await motifGraph('omen');
        const summary = (G) => {
            const waves = new Set(), filters = [], carriers = [];
            for (const s of ['c', 'q', 'e']) {
                const g = G.slots[s].g, tr = G.slots[s].trace;
                assert.equal(tr.ev, 'motif');
                assert.equal(tr.voices.length, 2, `${G.palette.agent}.${s}: 2 voices`);
                for (const v of tr.voices) assert.ok(v.gain <= 0.06 + 1e-9, `${G.palette.agent}.${s}: voice gain ${v.gain} <= 0.06`);
                for (const n of g) { if (n.k === 'osc') waves.add(n.type); if (n.k === 'filter') filters.push(`${n.type} ${n.f} Q${n.q}`); }
                // the first voice's root, spied: the oscillator whose start frequency is the trace's root (an FM carrier, not its modulator)
                const root = tr.voices.find((v) => v.f);
                const osc = g.find((n) => n.k === 'osc' && Math.abs(n.f - (root ? Math.min(18000, root.f) : -1)) < 0.05);
                assert.ok(osc, `${G.palette.agent}.${s}: an oscillator at the root ${root && root.f}`);
                carriers.push(osc.f);
                // every voice ends on the destination (2D)
                assert.ok(g.some((n) => n.to.includes('dest')), `${G.palette.agent}.${s}: routed to the destination`);
                assert.equal(g.filter((n) => n.k === 'panner').length, 0, `${G.palette.agent}.${s}: 2D, no panner`);
            }
            const semis = carriers.map((f) => Math.round(12 * Math.log2(f / carriers[0])));
            return { waves: [...waves].sort(), filters: [...new Set(filters)].sort(), carriers, semis };
        };
        const a = summary(sage), b = summary(omen);
        console.log('# GRAPH sage (glass): waves ' + a.waves.join(',') + ' | roots ' + a.carriers.join(' / ') + ' Hz | intervals ' + a.semis.join(' ') + ' | filters ' + a.filters.join('; '));
        console.log('# GRAPH omen (void): waves ' + b.waves.join(',') + ' | roots ' + b.carriers.join(' / ') + ' Hz | intervals ' + b.semis.join(' ') + ' | filters ' + b.filters.join('; '));
        assert.deepEqual(a.semis, [0, 7, 12], 'Sage plays her intervals [0, 7, 12]');
        assert.deepEqual(b.semis, [0, 6, 13], 'Omen plays his intervals [0, 6, 13]');
        assert.ok(a.waves.includes('sine') && !a.waves.includes('sawtooth'), 'Sage: sine voices');
        assert.ok(b.waves.includes('sawtooth'), 'Omen: a sawtooth voice');
        assert.notDeepEqual(a.waves, b.waves, 'the waves differ');
        assert.notDeepEqual(a.semis, b.semis, 'the intervals differ');
        assert.ok(a.filters.some((f) => /^bandpass 4200 Q6$/.test(f)), 'Sage: her bandpass 4200 Hz Q 6 (glass)');
        assert.ok(b.filters.some((f) => /^lowpass/.test(f)) && !b.filters.some((f) => /^bandpass/.test(f)), 'Omen: low-pass filters (void)');
        assert.equal(a.filters.filter((f) => b.filters.includes(f)).length, 0, 'no filter in common');
        assert.equal(a.carriers[0], 660);
        assert.equal(b.carriers[0], 110);
    });

    await t.test('a real cast: the ability\'s own sound at t 0, the motif at the gesture release key; the ultimate sting', async () => {
        for (const agent of ['sage', 'omen']) {
            // castFX runs on the real clock and SwiftShader frames here take longer than a cast clip, so the viewmodel is
            // stepped on a fake clock at 16 ms (as agent-casts does): vmAnim.end -> castFX.apply -> V23.fp's pose, whose
            // release key calls V23.audio.motif
            const got = await evaluate(([agent]) => {
                __identity(true);
                agentSystem.selectAgent(agent);
                switchWeapon('rifle');
                const cc = characterController;
                cc.position.set(__SPOT[0], __SPOT[1], __SPOT[2]); cc.prevSimPosition.copy(cc.position);
                camera.position.copy(cc.position); camera.rotation.set(-0.3, 0, 0, 'YXZ');
                if (castFX.active) { castFX.active = null; castFX.hide(); }
                const row = V23.core.resolve(agent).previews.c.sound.calls[0][0];
                let own = 0;
                const orig = soundFX[row];
                soundFX[row] = function () { own++; return orig.apply(this, arguments); };
                const st = agentSystem.stateByAgent[agent].c; st.charges = st.maxCharges;
                const realNow = performance.now.bind(performance), m0 = V23.audio.state.stats.motifs;
                let fake = realNow() + 20000;
                performance.now = () => fake;
                const out = { row };
                try {
                    __take();
                    agentSystem.castAbility('c');
                    out.own = own; out.motifsAtCast = V23.audio.state.stats.motifs - m0; out.kind = castFX.active ? castFX.active.kind : null;
                    const model = game.weapons[game.activeWeapon].model;
                    let steps = 0, p = null;
                    while (steps < 200 && V23.audio.state.stats.motifs === m0 && castFX.active) {
                        fake += 16; vmAnim.begin(model); vmAnim.end(model, fake); steps++;
                        const cur = V23.fp.state.cur;
                        if (cur && cur.released && p === null) p = cur.releasedAt;
                    }
                    out.steps = steps; out.releasedAt = p; out.pr = V23.fp.state.cur ? V23.fp.state.cur.pr : null;
                    out.motifs = V23.audio.state.stats.motifs - m0;
                    const tr = V23.audio.state.trace.filter((e) => e.ev === 'motif' && e.agent === agent && e.slot === 'c');
                    out.trace = tr.length ? tr[tr.length - 1] : null;
                    out.g = __take();
                    // the rest of the clip plays out
                    while (steps < 400 && castFX.active) { fake += 16; vmAnim.begin(model); vmAnim.end(model, fake); steps++; }
                } finally { performance.now = realNow; soundFX[row] = orig; }
                return out;
            }, [agent]);
            assert.equal(got.kind, 'cast', `${agent}.c: a cast clip`);
            assert.equal(got.own, 1, `${agent}.c: the ability's own soundFX method (${got.row}) plays at the cast`);
            assert.equal(got.motifsAtCast, 0, `${agent}.c: no palette layer before the release key`);
            assert.equal(got.motifs, 1, `${agent}.c: one motif, at the release key (after ${got.steps} steps of 16 ms)`);
            assert.ok(got.trace && got.trace.voices.length === 2, `${agent}.c: 2 voices`);
            assert.ok(got.releasedAt >= 0.09 && got.releasedAt <= 0.2, `${agent}.c: at the release key (p ${got.releasedAt}, key ${got.pr})`);
            const pal = await evaluate((a) => V23.audio.state.palette(a), agent);
            const oscs = got.g.filter((n) => n.k === 'osc');
            assert.ok(oscs.some((n) => Math.abs(n.f - pal.roots.c) < 0.05), `${agent}.c: a spied oscillator at the family root ${pal.roots.c} Hz (${oscs.map((n) => n.type + ' ' + n.f).join(', ')})`);
            assert.ok(oscs.some((n) => n.type === pal.wave), `${agent}.c: the family wave ${pal.wave}`);
            console.log(`# CAST ${agent}.c: ${got.row} at the cast, then the motif ${got.trace.voices.map((v) => v.r + ' ' + v.wave + (v.f ? ' ' + v.f.toFixed(1) : '')).join(' + ')} at p ${got.releasedAt.toFixed(3)} (key ${got.pr.toFixed(3)})`);
            // the ultimate: the sting at activation (V23.fp.ultCue), 3 voices
            const u = await evaluate(([agent]) => {
                if (castFX.active) { castFX.active = null; castFX.hide(); }
                game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
                game.ultPoints = game.maxUltPoints;
                const s0 = V23.audio.state.stats.stings;
                __take();
                agentSystem.castAbility('x');
                const tr = V23.audio.state.trace.filter((e) => e.ev === 'ult' && e.agent === agent);
                const g = __take();
                game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
                if (castFX.active) { castFX.active = null; castFX.hide(); }
                return { stings: V23.audio.state.stats.stings - s0, voices: tr.length ? tr[tr.length - 1].voices : [], panners: g.filter((n) => n.k === 'panner').length };
            }, [agent]);
            assert.equal(u.stings, 1, `${agent}.x: one sting at activation`);
            assert.equal(u.voices.length, 3, `${agent}.x: 3 voices`);
            for (const v of u.voices) assert.ok(v.gain <= 0.08 + 1e-9, `${agent}.x: voice gain ${v.gain} <= 0.08`);
            console.log(`# ULT ${agent}: ${u.voices.map((v) => v.r + ' ' + v.wave + (v.f ? ' ' + v.f.toFixed(1) : '') + ' g' + v.gain.toFixed(3) + ' +' + v.at.toFixed(3) + 's').join(' | ')}`);
        }
    });

    // ---- positional events ---------------------------------------------------------------------------------------
    await t.test('positional events: one gain and one HRTF panner per event; the mortar sting at the hazard; occlusion on the shared path', async () => {
        const r = await evaluate(() => {
            __identity(true);
            const e = __bot(), out = {};
            const cc = characterController;
            e.mesh.position.set(cc.position.x + 6, 0, cc.position.z - 4);
            const run = (kind, hz) => {
                __take();
                if (hz) V23.audio.botCue(e, kind, hz); else V23.audio.botCue(e, kind);
                const g = __take(), tr = __lastTrace()[0];
                const panners = g.map((n, i) => [n, i]).filter((x) => x[0].k === 'panner');
                // the event's bus: the gain that connects to the panner (or to the occlusion filter in front of it)
                const voices = tr.voices.length;
                const envs = g.filter((n) => n.k === 'gain' && n.to.length && n.to.every((d) => typeof d === 'number' && g[d].k === 'gain' && g[d].to.some((x) => typeof x === 'number' && (g[x].k === 'panner' || g[x].k === 'filter'))));
                return { kind, ev: tr.ev, voices, panners: panners.length, pos: panners.length ? panners[0][0].pos : null, envOnBus: envs.length, dest: g.filter((n) => n.to.includes('dest')).map((n) => n.k), agent: tr.agent };
            };
            out.cast = run('cast.smoke');
            out.windup = run('windup.smoke');
            out.warnFlash = run('windup.flash');
            const hz = { x: cc.position.x + 1.5, y: 0.07, z: cc.position.z - 1, type: 'mortar' };
            out.arm = run('arm.mortar', hz);
            out.hz = [hz.x, hz.y + 0.6, hz.z].map((v) => +v.toFixed(3));
            out.sig = run('sig.smokeChoke');
            // a wall between: soundFX.at's low-pass sits once on the shared path, before the one panner
            soundFX.isOccluded = () => true;
            __take();
            V23.audio.botCue(e, 'cast.flash');
            const g = __take();
            soundFX.isOccluded = () => false;
            out.occluded = { lp: g.filter((n) => n.k === 'filter' && n.type === 'lowpass' && n.f === 650).length, panners: g.filter((n) => n.k === 'panner').length };
            out.agent = e.agentId;
            return out;
        });
        for (const k of ['cast', 'windup', 'warnFlash', 'arm', 'sig']) {
            const x = r[k];
            assert.equal(x.panners, 1, `${x.kind}: one panner`);
            assert.ok(x.voices >= 1, `${x.kind}: voices`);
            assert.equal(x.envOnBus, x.voices, `${x.kind}: every voice goes into the one bus`);
            assert.deepEqual(x.dest, ['panner'], `${x.kind}: only the panner reaches the destination`);
        }
        assert.equal(r.cast.voices, 2, 'a cast layer: 2 voices');
        assert.equal(r.windup.voices, 1, 'a windup: 1 voice');
        for (const k of ['warnFlash', 'arm', 'sig']) { assert.equal(r[k].ev, 'warn', `${r[k].kind}: the warning sting`); assert.equal(r[k].voices, 3, `${r[k].kind}: 3 voices`); }
        assert.deepEqual(r.arm.pos, r.hz, 'the mortar sting is placed at the hazard');
        assert.deepEqual(r.occluded, { lp: 1, panners: 1 }, 'occluded: one low-pass and one panner for the event');
        console.log(`# CUES bot ${r.agent}: cast ${r.cast.voices} voices, windup ${r.windup.voices}, warnings ${r.warnFlash.voices}/${r.arm.voices}/${r.sig.voices}, one panner each`);
    });

    // ---- surface steps -------------------------------------------------------------------------------------------
    await t.test('surface steps: each surface id gives its kind, Ascent\'s walked floor is open floor, a prop gives V2.2\'s step, the weather rule, footwear kept; one Math.random per step', async () => {
        const r = await evaluate(() => {
            __identity(true);
            const e = __bot(), out = { found: {}, steps: {} }, agent0 = e.agentId;
            const want = { 1: 'concrete', 2: 'stone', 3: 'metal', 4: 'wood' };
            // the mapping: a piece of each surface id. Ascent has no piece top a bot reaches (bots walk at y 0 and the map
            // floor is no collision box; its low tops, 0.5-0.6 m, block the nav grid), so these are wall and roof tops: they
            // show the surf % 10 mapping and each surface's node graph, not a walked surface (the rope decks, last subtest)
            const under = (x, z, y) => collisionIndex.query(x, z, x, z, []).filter((rc) => x >= rc.minX && x <= rc.maxX && z >= rc.minZ && z <= rc.maxZ && Math.abs(rc.maxY - y) <= 0.3);
            for (const pc of mapPieces) {
                if (pc.shape !== 'box') continue;
                const id = pc.surf % 10;
                if (!want[id] || out.found[want[id]]) continue;
                const b = pc.bounds;
                if (b.max.x - b.min.x < 0.6 || b.max.z - b.min.z < 0.6) continue;
                const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2, top = b.max.y, u = under(cx, cz, top);
                if (u.length !== 1 || u[0].owner !== pc) continue;
                out.found[want[id]] = [cx, top, cz];
            }
            // a step at p: the kind surfAt gives, then that step played inside soundFX.at, spied, with its Math.random draws
            const stepAt = (p) => {
                e.mesh.position.set(p[0], p[1], p[2]);
                const kind = V23.audio.surfAt(e);
                const s0 = [soundFX.stepsPlayed, soundFX.lastStep];
                __take();
                const draws = __draws(() => soundFX.at(p[0], p[1] + 0.1, p[2], () => soundFX.enemyStep(kind)));
                const g = __take();
                return { kind: kind === undefined ? 'undefined' : kind === null ? 'null' : kind, kindRef: kind, draws, g, counters: [soundFX.stepsPlayed, soundFX.lastStep], s0 };
            };
            for (const s of Object.keys(out.found)) out.steps[s] = stepAt(out.found[s]);
            out.same = Object.keys(out.steps).every((s) => out.steps[s].kindRef === V23.audio.state.step(s, out.steps[s].kindRef.foot));
            // where Ascent's bots really walk: every open nav cell's centre at y 0, with snow forced so the open-floor rule
            // answers 'snow' and a piece would still answer its own surface
            navGrid.ensure();
            const snow0 = weatherSurf.uSnow.value;
            weatherSurf.uSnow.value = 1;
            out.walk = {};
            for (let j = 0; j < navGrid.N; j++) for (let i = 0; i < navGrid.N; i++) {
                if (navGrid.blocked[j * navGrid.N + i]) continue;
                e.mesh.position.set(i - navGrid.EXT + 0.5, 0, j - navGrid.EXT + 0.5);
                const k = V23.audio.surfAt(e), key = k === undefined ? 'prop' : k === null ? 'null' : k.surf === 'snow' ? 'open floor' : 'piece ' + k.surf;
                out.walk[key] = (out.walk[key] || 0) + 1;
            }
            weatherSurf.uSnow.value = snow0;
            // footwear tones on every surface: all of the footwear's, then the surface's in the room left (3 in all)
            out.tones = [];
            const SS = V23.audio.state.surfSteps, FW = V23.audio.state.footwear;
            for (const sf of Object.keys(SS)) for (const fw of Object.keys(FW)) {
                const k = V23.audio.state.step(sf, fw), has = (t) => k.tones.some((x) => x.join() === t.join());
                out.tones.push({ sf, fw, n: k.tones.length, foot: FW[fw].every(has), surf: SS[sf].tones.slice(0, Math.max(0, 3 - FW[fw].length)).every(has), hz: k.tones.map((x) => x[0]) });
            }
            // a prop: a barrel's top (a collider whose owner is no map piece), or one made for the test
            let prop = (breakables.barrels || []).find((b) => b.rec && b.rec.indexed);
            let made = null;
            if (!prop) {
                made = createColliderRecord('static', null);
                const x = __SPOT[0] + 3, z = __SPOT[2] - 3;
                setColliderFromBox3(made, new THREE.Box3(new THREE.Vector3(x - 0.5, 0, z - 0.5), new THREE.Vector3(x + 0.5, 0.25, z + 0.5)), x, z);
                collisionIndex.insert(made);
                prop = { rec: made };
            }
            const pr = prop.rec;
            out.propKind = made ? 'test collider' : 'barrel';
            out.prop = stepAt([(pr.minX + pr.maxX) / 2, pr.maxY, (pr.minZ + pr.maxZ) / 2]);
            if (made) collisionIndex.remove(made);
            // open floor: a spot with no box under it, then the weather rule
            let open = null;
            for (let dx = 0; dx < 30 && !open; dx += 1.5) { const x = __SPOT[0] + dx, z = __SPOT[2] - 2; if (!under(x, z, 0).length) open = [x, 0, z]; }
            out.open = stepAt(open);
            weatherSurf.uSnow.value = 1;
            out.snow = V23.audio.surfAt(e).surf;
            weatherSurf.uSnow.value = 0; weatherSurf.uWet.value = 1;
            out.wet = V23.audio.surfAt(e).surf;
            weatherSurf.uWet.value = 0;
            // the cache: the same 0.5 m cell is not looked up again; another cell is
            const st0 = V23.audio.state.stats;
            V23.audio.surfAt(e); V23.audio.surfAt(e);
            const st1 = V23.audio.state.stats;
            e.mesh.position.x += 0.6;
            V23.audio.surfAt(e);
            const st2 = V23.audio.state.stats;
            out.cache = [st1.surfCached - st0.surfCached, st1.surfLookups - st0.surfLookups, st2.surfLookups - st1.surfLookups];
            // footwear from the look (a stub: its role default)
            out.foot = {};
            for (const id of ['sage', 'omen', 'jett', 'brimstone']) { e.agentId = id; out.foot[id] = V23.audio.surfAt(e).foot; }
            e.agentId = agent0;
            // V2.2's step: enemyStep() with no kind, spied
            e.mesh.position.set(open[0], 0, open[2]);
            __take();
            out.v22draws = __draws(() => soundFX.at(open[0], 0.1, open[2], () => soundFX.enemyStep()));
            out.v22 = __take();
            out.v22counters = [soundFX.stepsPlayed, soundFX.lastStep];
            out.mm = game.userSettings.masterVolume / 100;
            for (const s of Object.keys(out.steps)) delete out.steps[s].kindRef;
            return out;
        });
        assert.deepEqual(Object.keys(r.found).sort(), ['concrete', 'metal', 'stone', 'wood'], 'Ascent has a piece top of each surface (the mapping)');
        assert.ok(r.same, 'surfAt gives the same frozen recipe as state.step');
        // Ascent's walked floor: the open-floor rule (the common case for real enemy steps)
        const walked = Object.values(r.walk).reduce((a, b) => a + b, 0);
        assert.ok(walked > 1000, `open nav cells sampled (${walked})`);
        assert.ok((r.walk['open floor'] || 0) / walked >= 0.95, `the open-floor rule answers where bots walk: ${JSON.stringify(r.walk)}`);
        // footwear kept on every surface (the plate tick of a plated bot on metal too)
        for (const x of r.tones) {
            assert.ok(x.n <= 3, `${x.sf}/${x.fw}: at most 3 tones`);
            assert.ok(x.foot, `${x.sf}/${x.fw}: every footwear tone kept (${x.hz.join(', ')})`);
            assert.ok(x.surf, `${x.sf}/${x.fw}: the surface's first tones in the room left (${x.hz.join(', ')})`);
        }
        const mp = r.tones.find((x) => x.sf === 'metal' && x.fw === 'plated');
        assert.deepEqual(mp.hz, [410, 95, 2600], 'metal x plated: the metal ring, the heel and the plate tick');
        const checkStep = (label, s, surf) => {
            assert.equal(typeof s.kind, 'object', `${label}: a step kind`);
            assert.equal(s.kind.surf, surf, `${label}: kind ${s.kind.surf}`);
            assert.equal(s.draws, 1, `${label}: exactly one Math.random`);
            const noise = s.g.filter((n) => n.k === 'noise'), filt = s.g.filter((n) => n.k === 'filter'), osc = s.g.filter((n) => n.k === 'osc'), pan = s.g.filter((n) => n.k === 'panner');
            assert.equal(noise.length, 1, `${label}: one noise call`);
            assert.ok(filt.some((f) => f.type === s.kind.noise[1] && Math.abs(f.f - s.kind.noise[2]) < 0.5), `${label}: the surface's filter ${s.kind.noise[1]} ${s.kind.noise[2]}`);
            assert.equal(osc.length, s.kind.tones.length, `${label}: its ${s.kind.tones.length} tones`);
            assert.equal(pan.length, 1, `${label}: one panner for the step`);
            assert.deepEqual(s.counters, s.s0, `${label}: the player's step counters untouched`);
            // the noise voice's gain argument is 0.16 (V2.2's): its peak is 0.16 x Master volume
            const peaks = s.g.filter((n) => n.k === 'gain').map((n) => n.peak);
            assert.ok(peaks.some((p) => Math.abs(p - 0.16 * r.mm) < 1e-4), `${label}: the noise call's gain 0.16`);
        };
        for (const s of ['concrete', 'stone', 'metal', 'wood']) checkStep(s + ' piece', r.steps[s], s);
        checkStep('open floor', r.open, 'concrete');
        assert.equal(r.snow, 'snow');
        assert.equal(r.wet, 'wet');
        assert.equal(r.prop.kind, 'undefined', `a ${r.propKind}: undefined (V2.2's step)`);
        assert.equal(r.prop.draws, 1, 'the prop step: one Math.random');
        assert.deepEqual(r.cache, [2, 0, 1], 'cached per 0.5 m cell');
        assert.deepEqual(r.foot, { sage: 'soft', omen: 'plated', jett: 'runner', brimstone: 'soft' }, 'footwear from the look (stubs: role default)');
        // enemyStep(): V2.2's nodes exactly (playNoise(0.07, 0.16, 0, 520) and playTone(95, 55, 0.08, 'sine', 0.07, 0), each
        // through its own panner inside soundFX.at), one Math.random
        const v22 = r.v22.map((n) => [n.k, n.type || '', n.f !== undefined ? n.f : '', n.f1 !== undefined ? n.f1 : '', n.peak !== undefined ? +n.peak.toFixed(4) : ''].join(':'));
        const mm = r.mm;
        assert.deepEqual(v22, ['noise::::', 'filter:lowpass:520:120:', 'gain::::' + +(0.16 * mm).toFixed(4), 'panner::::', 'osc:sine:95::', 'gain::::' + +(0.07 * mm).toFixed(4), 'panner::::'], 'enemyStep(): V2.2\'s step');
        assert.equal(r.v22draws, 1, 'enemyStep(): one Math.random');
        assert.deepEqual(r.prop.g.map((n) => n.k), r.v22.map((n) => n.k), 'the prop step is V2.2\'s');
        console.log(`# STEPS piece tops (mapping) ${JSON.stringify(r.found)}; prop: ${r.propKind}; foot ${JSON.stringify(r.foot)}; Ascent's open nav cells at y 0: ${JSON.stringify(r.walk)}`);
        console.log('# STEPTONES ' + r.tones.map((x) => `${x.sf}/${x.fw} [${x.hz.join(' ')}]`).join('; '));
    });

    await t.test('the live path: enemyAudio passes the kind; enemyFootsteps off and beyond 22 m make no step', async () => {
        const r = await evaluate(() => {
            __identity(true);
            const e = __bot(), cc = characterController, args = [];
            const orig = soundFX.enemyStep;
            soundFX.enemyStep = function (k) { args.push(k === undefined ? 'undefined' : k === null ? 'null' : k.surf); return orig.call(this, k); };
            const walk = (dz) => {
                args.length = 0;
                e._stepX = undefined;
                e.mesh.position.set(cc.position.x - 3, 0, cc.position.z + dz);
                enemyAudio.update();
                for (let i = 0; i < 12; i++) { e.mesh.position.x += 0.6; enemyAudio.update(); }
                return args.slice();
            };
            const out = {};
            out.near = walk(-5);
            out.far = walk(-30);
            game.userSettings.enemyFootsteps = false;
            out.off = walk(-5);
            game.userSettings.enemyFootsteps = true;
            __identity(false);
            out.idOff = walk(-5);
            __identity(true);
            soundFX.enemyStep = orig;
            return out;
        });
        assert.ok(r.near.length >= 3, `steps within 22 m (${r.near.length})`);
        assert.ok(r.near.every((k) => k === 'concrete' || k === 'stone' || k === 'metal' || k === 'wood' || k === 'undefined'), `the kind passed: ${r.near.join(',')}`);
        assert.ok(r.near.includes('concrete'), 'open floor steps are concrete');
        assert.equal(r.far.length, 0, 'no step beyond 22 m');
        assert.equal(r.off.length, 0, 'enemyFootsteps off: no step');
        assert.ok(r.idOff.length >= 3 && r.idOff.every((k) => k === 'null'), 'identity off: V2.2\'s step (surfAt null)');
    });

    // ---- settings ------------------------------------------------------------------------------------------------
    await t.test('settings: soundEnabled, masterVolume, positionalAudio, Agent Identity and headshotVolume', async () => {
        const r = await evaluate(() => {
            __identity(true);
            const e = __bot(), out = {}, cc = characterController;
            e.mesh.position.set(cc.position.x + 12, 0, cc.position.z - 9);
            const desc = V23.audio.surfAt(e);
            const all = () => {
                V23.audio.motif('sage', 'c'); V23.audio.ultSting('omen');
                V23.audio.botCue(e, 'cast.flash'); V23.audio.botCue(e, 'windup.flash'); V23.audio.botCue(e, 'arm.mortar', { x: cc.position.x, y: 0.07, z: cc.position.z });
                V23.audio.preview('sage', 'intro'); V23.audio.preview(null);
                V23.audio.atShared(1, 1, 1, () => soundFX.playTone(440, 440, 0.1, 'sine', 0.05, 0));
                soundFX.at(e.mesh.position.x, 0.1, e.mesh.position.z, () => soundFX.enemyStep(desc));
            };
            // sound off: ensureContext is null, so no node at all
            game.soundEnabled = false;
            __take();
            all();
            out.soundOff = __take().length;
            game.soundEnabled = true;
            // Master volume scales every V2.3 voice
            const peaks = () => { __take(); V23.audio.motif('sage', 'c'); return __lastTrace()[0].voices.map((v) => v.gain); };
            const mv = game.userSettings.masterVolume;
            game.userSettings.masterVolume = 100; out.full = peaks();
            game.userSettings.masterVolume = 50; out.half = peaks();
            game.userSettings.masterVolume = 0;
            __take();
            out.zeroDraws = __draws(() => soundFX.at(e.mesh.position.x, 0.1, e.mesh.position.z, () => soundFX.enemyStep(desc)));
            V23.audio.motif('sage', 'c');
            out.zero = __take().length;
            game.userSettings.masterVolume = mv;
            // 3D audio off: no panner, and the cue's bus stays at unity (soundFX.at plays straight: V2.2's level for its
            // positional sounds, the same bot's gunshot and steps, then)
            game.userSettings.positionalAudio = false;
            __take();
            V23.audio.botCue(e, 'cast.flash');
            const g = __take();
            soundFX.at(e.mesh.position.x, 0.1, e.mesh.position.z, () => soundFX.enemyStep(desc));
            const gs = __take();
            out.pos3dOff = { panners: g.concat(gs).filter((n) => n.k === 'panner').length, busPeak: g.filter((n) => n.k === 'gain' && n.to.includes('dest')).map((n) => n.peak), stepNodes: gs.length };
            game.userSettings.positionalAudio = true;
            out.dist = Math.hypot(e.mesh.position.x - camera.position.x, 1.3 - camera.position.y, e.mesh.position.z - camera.position.z);
            // Agent Identity off: no in-match layer; the showroom previews still play
            __identity(false);
            __take();
            V23.audio.motif('sage', 'c'); V23.audio.ultSting('sage'); V23.audio.botCue(e, 'cast.flash'); V23.audio.botCue(e, 'windup.flash');
            out.idOff = __take().length;
            out.idOffSurf = V23.audio.surfAt(e);
            V23.audio.preview('omen', 'c');
            out.idOffPreview = __take().length;
            V23.audio.preview(null);
            __identity(true);
            // headshotVolume: V2.2's dink scales; no V2.3 voice joins it
            const hv = game.userSettings.headshotVolume, n0 = V23.audio.state.trace.length, ev0 = V23.audio.state.stats.events;
            game.userSettings.headshotVolume = 50;
            __take();
            soundFX.headshotDink();
            out.dink = __take().filter((n) => n.k === 'gain').map((n) => n.peak);
            game.userSettings.headshotVolume = hv;
            out.dinkEvents = V23.audio.state.stats.events - ev0;
            out.mv = mv / 100;
            return out;
        });
        assert.equal(r.soundOff, 0, 'soundEnabled off: no node');
        assert.equal(r.full.length, 2);
        r.full.forEach((g, i) => assert.ok(Math.abs(r.half[i] - g * 0.5) < 1e-6, `masterVolume 50 halves voice ${i} (${g} -> ${r.half[i]})`));
        assert.equal(r.zero, 0, 'masterVolume 0: no node');
        assert.equal(r.zeroDraws, 0, 'masterVolume 0: no draw (V2.2\'s step draws none there either)');
        assert.equal(r.pos3dOff.panners, 0, 'positionalAudio off: no panner');
        assert.ok(r.pos3dOff.stepNodes > 0, 'positionalAudio off: the step still plays');
        assert.equal(r.pos3dOff.busPeak.length, 1, 'positionalAudio off: one bus reaches the destination');
        assert.equal(r.pos3dOff.busPeak[0], 1, `positionalAudio off: the cue's bus at unity, as V2.2's positional sounds then (the bot ${r.dist.toFixed(1)} m away)`);
        assert.equal(r.idOff, 0, 'identity off: no motif, sting or bot cue');
        assert.equal(r.idOffSurf, null, 'identity off: surfAt null (V2.2\'s step)');
        assert.ok(r.idOffPreview > 0, 'identity off: previews still play');
        assert.deepEqual(r.dink.map((p) => +p.toFixed(4)), [+(0.15 * 0.5 * r.mv).toFixed(4), +(0.10 * 0.5 * r.mv).toFixed(4)], 'headshotVolume scales the dink');
        assert.equal(r.dinkEvents, 0, 'no V2.3 voice on a headshot');
    });

    // ---- previews ------------------------------------------------------------------------------------------------
    await t.test("previews: Sage's chime, Omen's tear and plate clacks, the cast's own methods, a bus of their own ramped to 0 in 30 ms", async () => {
        const r = await evaluate(() => {
            __identity(true);
            const out = {};
            const one = (agent, slot) => {
                __take();
                V23.audio.preview(agent, slot);
                const g = __take(), tr = __lastTrace()[0];
                const bus = g.findIndex((n) => n.k === 'gain' && n.to.includes('dest'));
                return { voices: tr.voices, ev: tr.ev, dest: g.filter((n) => n.to.includes('dest')).length, ext: g.filter((n) => n.to.includes('ext')).length, bus, toBus: g.filter((n) => n.to.includes(bus)).length, panners: g.filter((n) => n.k === 'panner').length };
            };
            out.sage = one('sage', 'intro');
            out.omen = one('omen', 'intro');
            // the next preview (or preview(null)) ramps the last bus to 0 in 30 ms
            const S = __spy;
            __take();
            V23.audio.preview('omen', 'clack');
            const nodes = S.nodes.slice(), bus = nodes.find((n) => n.kind === 'gain' && n.to.includes(__ctx.destination));
            __take();
            V23.audio.preview(null);
            const log = (bus && bus.p.gain) || [], set = log.find((x) => x[0] === 'setValueAtTime');
            out.fade = log.filter((x) => x[0] === 'linearRampToValueAtTime').map((x) => [x[1], +(x[2] - (set ? set[2] : 0)).toFixed(3)]);
            // the cast's own soundFX methods (PREVIEW_SOUNDS) inside V23.seeded, on the bus
            const calls = [];
            const wrap = (m) => { const o = soundFX[m]; soundFX[m] = function () { calls.push([m, typeof soundFX._rand === 'function', !!soundFX._out]); return o.apply(this, arguments); }; return () => { soundFX[m] = o; }; };
            const un = [wrap('ult'), wrap('omenTeleport')];
            out.omenX = one('omen', 'x');
            un.forEach((f) => f());
            out.calls = calls;
            // the showroom's own bus in soundFX._out: the preview's bus feeds it
            const show = __ctx.createGain();
            show.connect(__ctx.destination);
            __take();
            soundFX._out = show;
            V23.audio.preview('sage', 'c');
            const g = __take();
            soundFX._out = null;
            out.showBus = g.filter((n) => n.k === 'gain' && n.to.includes('ext')).length;
            V23.audio.preview(null);
            return out;
        });
        const chime = r.sage.voices.filter((v) => v.r === 'fmBell' && Math.abs(v.f - 1320) < 0.01 && Math.abs(v.at - 1.0) < 1e-6);
        assert.equal(chime.length, 1, "Sage's intro: the glass chime (FM bell at 1320 Hz) at 1.0 s");
        assert.ok(r.sage.voices.some((v) => v.r === 'swell' && v.at < 0.2), "Sage's intro: the shards gather");
        assert.equal(r.omen.voices.filter((v) => v.r === 'clickTrain').length, 10, "Omen's intro: 10 plate clacks");
        const clacks = r.omen.voices.filter((v) => v.r === 'clickTrain').map((v) => v.at);
        assert.ok(clacks.every((a, i) => i === 0 || Math.abs(a - clacks[i - 1] - 0.06) < 1e-6), 'the clacks 60 ms apart');
        assert.ok(r.omen.voices.some((v) => v.r === 'noiseSweep' && v.at === 0 && v.filter[0] === 'lowpass'), "Omen's intro: the rift tear");
        for (const k of ['sage', 'omen', 'omenX']) {
            assert.equal(r[k].dest, 1, `${k}: only the preview's bus reaches the destination`);
            assert.equal(r[k].ext, 0, `${k}: no voice reaches the shared reverb`);
            assert.equal(r[k].panners, 0, `${k}: 2D`);
            assert.ok(r[k].toBus >= r[k].voices.length, `${k}: every voice on the bus`);
        }
        assert.deepEqual(r.fade, [[0, 0.03]], 'the last bus ramps to 0 in 30 ms');
        assert.deepEqual(r.calls, [['ult', true, true], ['omenTeleport', true, true]], "omen.x: the cast's own methods, inside V23.seeded, on the bus");
        assert.equal(r.omenX.voices.length, 3, 'the ultimate preview: the 3-voice sting');
        assert.equal(r.showBus, 1, "soundFX._out set: the preview's bus feeds it");
    });

    // ---- randomness and programs -----------------------------------------------------------------------------------
    await t.test('no Math.random from any V2.3 sound; prebuild draws none; programs unaffected', async () => {
        const r = await evaluate((role) => {
            __identity(true);
            const e = __bot(), cc = characterController;
            e.mesh.position.set(cc.position.x + 5, 0, cc.position.z - 5);
            const ids = AGENT_ORDER.filter((id) => !role || AGENT_DEFS[id].role === role);
            const out = {};
            out.casts = __draws(() => { for (const id of ids) { for (const s of ['c', 'q', 'e', 'x']) V23.audio.motif(id, s); V23.audio.ultSting(id); } });
            out.previews = __draws(() => { for (const id of ids) for (const s of ['c', 'q', 'e', 'x', 'intro', 'lockIn', 'chime', 'tear', 'close', 'clack', 'gather', 'land']) V23.audio.preview(id, s); V23.audio.preview(null); });
            const ag0 = e.agentId;
            out.cues = __draws(() => { for (const id of ids) { e.agentId = id; for (const k of ['windup.flash', 'cast.flash', 'windup.sonar', 'cast.sonar', 'windup.mortar', 'cast.mortar', 'windup.smoke', 'cast.smoke', 'cast.teleport', 'sig.slowEntry']) V23.audio.botCue(e, k); V23.audio.botCue(e, 'arm.mortar', { x: cc.position.x, y: 0.07, z: cc.position.z }); } });
            e.agentId = ag0;
            out.shared = __draws(() => V23.audio.atShared(2, 1, 2, () => soundFX.playTone(440, 440, 0.05, 'sine', 0.03, 0)));
            out.trials = __draws(() => { const F = V23.audio.state.families; for (const k of Object.keys(F)) if (F[k].v) { V23.audio.state.trial(F[k].v, 'motif', 'e'); V23.audio.state.trial(F[k].v, 'ult'); } });
            out.surf = __draws(() => { for (let i = 0; i < 20; i++) { e.mesh.position.x += 0.3; V23.audio.surfAt(e); } });
            // prebuild from scratch: both buffers made again, no draw from Math.random
            const nb = soundFX._noiseBuffer, rv = soundFX._reverb;
            soundFX._noiseBuffer = null; soundFX._reverb = null;
            out.prebuild = __draws(() => V23.audio.prebuild());
            out.rebuilt = [!!soundFX._noiseBuffer, !!(soundFX._reverb && soundFX._reverb.conv)];
            soundFX._noiseBuffer = nb; soundFX._reverb = rv;
            out.events = V23.audio.state.stats.events;
            __spy.on = false;
            soundFX.isOccluded = __occ;
            return out;
        }, ROLE);
        assert.deepEqual([r.casts, r.previews, r.cues, r.shared, r.trials, r.surf, r.prebuild], [0, 0, 0, 0, 0, 0, 0], 'no Math.random from V2.3 sound (motifs and stings, previews, bot cues, atShared, the 29 families\' trials, surfAt, prebuild)');
        assert.deepEqual(r.rebuilt, [true, true], 'prebuild rebuilds both buffers');
        await frames(5);
        const [programs, watermark, stalls] = await programState(page);
        assert.equal(programs, watermark, 'no shader compiled after the warm-up');
        assert.equal(stalls, 0, 'no first-use stalls');
        console.log(`# EVENTS ${r.events} V2.3 sound events in this run`);
    });

    // ---- rope decks: the piece tops a V2.2 bot reaches -----------------------------------------------------------------
    await t.test("rope decks (the piece tops a bot reaches): the live path on Icebox's container deck gives metal steps with the footwear; Split's decks are pieces", async () => {
        await evaluate(() => rebuildMapPreset('icebox'));
        await frames(3);
        const r = await evaluate(() => {
            __identity(true);
            __spy.on = true;
            soundFX.isOccluded = () => false;
            window.updateEnemies = () => {};
            const e = __bot(), cc = characterController, L = mapLayout(), rope = L.ropes[0], agent0 = e.agentId;
            const out = { map: game.mapPreset, rope: rope.name, steps: [], snow: weatherSurf.uSnow.value };
            e.agentId = 'omen';   // plated footwear: the plate tick on metal
            const deckY = rope.topY - 0.2, pos = e.mesh.position;
            // the player on the ground 6 m from the deck's exit (inside the 22 m range)
            cc.position.set(rope.exit.x + 6, cc.position.y, rope.exit.z);
            camera.position.copy(cc.position);
            // each call of the step detector: its kind, its spied nodes and its Math.random draws, and whether it is this
            // bot's (soundFX.at's position is the bot's)
            const orig = soundFX.enemyStep;
            soundFX.enemyStep = function (k) {
                __take();
                const real = Math.random;
                let n = 0;
                Math.random = function () { n++; return real(); };
                try { orig.call(this, k); } finally { Math.random = real; }
                const g = __take(), x = pos.x, z = pos.z, y = pos.y;
                const under = collisionIndex.query(x, z, x, z, []).filter((rc) => x >= rc.minX && x <= rc.maxX && z >= rc.minZ && z <= rc.maxZ && Math.abs(rc.maxY - y) <= 0.3);
                out.steps.push({ at: [+x.toFixed(2), +y.toFixed(2), +z.toFixed(2)], mine: !!(soundFX._pos && Math.abs(soundFX._pos.x - x) < 1e-6 && Math.abs(soundFX._pos.z - z) < 1e-6),
                    surf: k ? k.surf : String(k), foot: k ? k.foot : null, hz: k ? k.tones.map((q) => q[0]) : [],
                    piece: under.length ? (under[0].owner && typeof under[0].owner.surf === 'number' ? under[0].owner.surf % 10 : -1) : 0, draws: n,
                    noise: g.filter((q) => q.k === 'noise').length, osc: g.filter((q) => q.k === 'osc').length, panners: g.filter((q) => q.k === 'panner').length });
            };
            // botMechanics._air walks the bot at deckY from the cable to the exit ('onTop') and back ('back'), as in a match
            // with botMechanics on (mechHoldMs set, so the perch at the exit draws no hold time); enemyAudio.update is the
            // live step path (H31.1)
            const bm = botMechanics, keepLayout = bm.layout;
            bm.layout = L;
            e._stepX = undefined;
            pos.set(rope.x, deckY, rope.z);
            Object.assign(e, { mechState: 'onTop', mechKind: 'rope', mechIdx: 0, mechAir: true, mechX: rope.x, mechZ: rope.z, mechHoldMs: 1500 });
            let now = gameNow();
            e.mechUntil = now + 1500;
            const tick = () => { bm._air(e, pos, cc.position, 36, now, Date.now(), 1 / 60, 1, 1, 1); enemyAudio.update(); now += 1000 / 60; };
            enemyAudio.update();
            try {
                for (let i = 0; i < 120 && e.mechState === 'onTop'; i++) tick();
                out.reached = e.mechState;
                e.mechState = 'back';
                e.mechUntil = now + 1500;
                for (let i = 0; i < 120 && e.mechState === 'back'; i++) tick();
                out.after = e.mechState;
            } finally {
                soundFX.enemyStep = orig;
                bm.clear(e);
                e.mechHoldMs = 0; pos.y = 0; e._stepX = undefined; e.agentId = agent0;
                bm.layout = keepLayout;
            }
            return out;
        });
        assert.equal(r.map, 'icebox');
        assert.equal(r.reached, 'perch', `the bot walked the deck to the exit (${r.rope})`);
        assert.equal(r.after, 'down', 'and back to the cable');
        const mine = r.steps.filter((x) => x.mine);
        assert.ok(mine.length >= 2, `steps on the deck walk (${mine.length})`);
        const metal = mine.filter((x) => x.piece === 3);
        assert.ok(metal.length >= 1, 'at least one step over the container deck');
        for (const x of mine) {
            assert.equal(x.surf, x.piece === 3 ? 'metal' : x.piece === 0 ? (r.snow > 0.4 ? 'snow' : 'concrete') : x.surf, `a step at ${x.at.join(', ')}: the surface under it`);
            assert.equal(x.foot, 'plated', 'its footwear from the look');
            assert.deepEqual([x.noise, x.panners, x.osc, x.draws], [1, 1, x.hz.length, 1], `a step at ${x.at.join(', ')}: one noise call, one panner, its tones, one Math.random`);
        }
        for (const x of metal) assert.deepEqual(x.hz, [410, 95, 2600], 'a plated step on metal: the ring, the heel and the plate tick');
        console.log(`# DECK ${r.map} ${r.rope}: ${mine.map((x) => `${x.surf}/${x.foot} at [${x.at.join(' ')}] [${x.hz.join(' ')}]`).join('; ')}`);
        // Split: the Underpass deck is metal and the Crossing deck a concrete piece (concrete while open floor says snow)
        await evaluate(() => rebuildMapPreset('split'));
        await frames(3);
        const s = await evaluate(() => {
            const e = __bot(), L = mapLayout(), out = { map: game.mapPreset, decks: [] }, p0 = e.mesh.position.clone(), snow0 = weatherSurf.uSnow.value;
            weatherSurf.uSnow.value = 1;
            for (const rope of L.ropes) {
                e.mesh.position.set(rope.exit.x, rope.topY - 0.2, rope.exit.z);
                const k = V23.audio.surfAt(e);
                e.mesh.position.set(rope.x, rope.topY - 0.2, rope.z);   // over the cable's foot: no box, the open-floor rule
                const k0 = V23.audio.surfAt(e);
                out.decks.push([rope.name, k ? k.surf : String(k), k0 ? k0.surf : String(k0)]);
            }
            weatherSurf.uSnow.value = snow0;
            e.mesh.position.copy(p0);
            return out;
        });
        assert.equal(s.map, 'split');
        assert.deepEqual(s.decks, [['UNDERPASS ASCENDER', 'metal', 'snow'], ['CROSSING ASCENDER', 'concrete', 'snow']], "Split's decks: a metal and a concrete piece (open floor beside them: snow forced)");
        console.log(`# DECK split: ${s.decks.map((d) => d[0] + ' ' + d[1]).join('; ')}`);
        await frames(5);
        const [programs, watermark, stalls] = await programState(page);
        assert.equal(programs, watermark, 'no shader compiled after the warm-up (two map switches)');
        assert.equal(stalls, 0, 'no first-use stalls');
    });

    assert.deepEqual(errors, []);
});
