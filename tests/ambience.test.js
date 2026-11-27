'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser } = require('./harness');

after(closeBrowser);

const MAPS = ['ascent', 'bind', 'haven', 'icebox', 'lotus', 'split', 'skyline'];

// V2.2: the ambience's one-off sounds come from each map's own landmarks (its sound points), and Haven
// at night has crickets, an owl and a night bird instead of birds
test('ambience: every one-off sound comes from one of its map\'s sound points of its kind, in open air and spread out; Haven has night sounds', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await boot();
    // Ambience off (the default), music on: no sound points are built and nothing plays
    const off = await evaluate(() => {
        document.querySelector('#setting-music-pills [data-music="on"]').click();
        for (let i = 0; i < 8; i++) { ambientAudio.nextEventAt = 0; ambientAudio.tick(); }
        return { points: ambientAudio.points, events: ambientAudio.eventsPlayed };
    });
    assert.deepEqual(off, { points: null, events: 0 }, 'ambience off: no sound points, no sounds');

    const r = await evaluate((maps) => {
        const rec = [], builds = {}, at0 = soundFX.at, build0 = ambientAudio._buildPoints;
        soundFX.at = function (x, y, z, fn) { rec.push([x, y, z, ambientAudio._evKind]); return at0.call(this, x, y, z, fn); };
        ambientAudio._buildPoints = function () { builds[this.presetId] = (builds[this.presetId] || 0) + 1; return build0.call(this); };
        document.querySelector('#setting-music-pills [data-music="off"]').click();
        document.querySelector('#setting-ambience-pills [data-ambience="on"]').click();
        const near = [];
        const solid = (x, y, z) => collisionIndex.query(x, z, x, z, near).some((b) => b.kind === 'static' &&
            x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && z > b.minZ && z < b.maxZ);
        const out = {};
        for (const id of maps) {
            tacticalDirector.cycleMapPreset(id);
            rec.length = 0;
            // From every open spot of the layout, a few one-off sounds
            for (const s of mapLayout().respawnSpots) {
                characterController.position.set(s[0], 1.7, s[1]);
                for (let i = 0; i < 4; i++) { ambientAudio.nextEventAt = 0; ambientAudio.tick(); }
            }
            const pts = ambientAudio.points, counts = {}, played = {};
            let inside = 0;
            for (const k in pts) {
                counts[k] = pts[k].length / 3;
                for (let i = 0; i < pts[k].length; i += 3) if (solid(pts[k][i], pts[k][i + 1], pts[k][i + 2])) inside++;
            }
            const isPoint = (e) => { const a = pts[e[3]] || []; for (let i = 0; i < a.length; i += 3) if (a[i] === e[0] && a[i + 1] === e[1] && a[i + 2] === e[2]) return true; return false; };
            for (const e of rec) played[e[3]] = (played[e[3]] || new Set()).add(e.slice(0, 3).join());
            out[id] = {
                kinds: MAP_AUDIO[id].events.filter((k, i, a) => a.indexOf(k) === i), counts, inside, builds: builds[id],
                events: rec.length, offPoint: rec.filter((e) => !isPoint(e)).length,
                distinct: new Set(rec.map((e) => e.slice(0, 3).join())).size,
                played: Object.fromEntries(Object.entries(played).map(([k, v]) => [k, v.size]))
            };
        }
        soundFX.at = at0;
        ambientAudio._buildPoints = build0;
        // Haven's night sounds are generated in code, one placed voice (oscillator and 3D panner) each
        // (the owl two: a hooted pair)
        const ctx = soundFX.ctx, co = ctx.createOscillator.bind(ctx), cp = ctx.createPanner.bind(ctx);
        const voices = {};
        let o = 0, p = 0;
        ctx.createOscillator = () => { o++; return co(); };
        ctx.createPanner = () => { p++; return cp(); };
        for (const k of ['cricket', 'owl', 'nightbird']) {
            o = 0; p = 0;
            soundFX.at(camera.position.x + 20, 3, camera.position.z, () => ambientAudio._play(k, 1));
            voices[k] = [o, p];
        }
        ctx.createOscillator = co;
        ctx.createPanner = cp;
        return { maps: out, voices };
    }, MAPS);

    for (const id of MAPS) {
        const m = r.maps[id];
        for (const k of m.kinds) assert.ok(m.counts[k] >= 3, `${id}: ${m.counts[k] || 0} ${k} points`);
        assert.equal(m.inside, 0, `${id}: every sound point is in open air`);
        assert.equal(m.builds, 1, `${id}: the points are built once`);
        assert.ok(m.events >= 60, `${id}: ${m.events} one-off sounds`);
        assert.equal(m.offPoint, 0, `${id}: every one-off sound comes from a sound point of its kind`);
        assert.ok(m.distinct >= 8, `${id}: spread over ${m.distinct} points`);
        for (const k in m.played) assert.ok(m.played[k] >= 2, `${id}: ${k} from ${m.played[k]} points`);
    }
    const haven = r.maps.haven;
    assert.ok(!haven.kinds.includes('bird') && !haven.played.bird && !haven.counts.bird, 'Haven at night has no birds');
    for (const k of ['bell', 'cricket', 'owl', 'nightbird']) assert.ok(haven.played[k] > 0, `Haven plays ${k}`);
    for (const id of ['ascent', 'bind', 'lotus']) assert.ok(r.maps[id].played.bird > 0, `${id} keeps its birds`);
    assert.deepEqual(r.voices, { cricket: [1, 1], owl: [2, 2], nightbird: [1, 1] });
    assert.deepEqual(errors, []);
});
