'use strict';
// V2.2: the High Fidelity framework (abilityLook's registry, renderers and model kit): the staged build keeps
// its step budget, every program is compiled in the warm steps, the registry is consistent, the ten proof
// abilities and the pilots out at once stay inside the budget
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./hifi-kit');
const { closeBrowser } = require('./harness');

after(closeBrowser);

test('High Fidelity framework: a staged build in small steps, programs compiled only in its warm steps, a consistent registry', { timeout: 900000 }, async (t) => {
    const g = await kit.bootHifi({ look: 'classic' });
    // time every build step as High Fidelity is switched on mid-match
    await g.evaluate(() => {
        window.__steps = [];
        const bs = abilityLook.buildSteps;
        abilityLook.buildSteps = function () {
            const steps = bs.call(this);
            // the textures come first (the V2.0 noise, crack and scorch steps), then the renderers' pools and the models
            const first = steps.findIndex((f) => String(f).indexOf('make_') >= 0);
            return steps.map((f, i) => function () { const t0 = performance.now(); f.call(this); __steps.push([i, performance.now() - t0, i < first]); });
        };
    });
    const before = await g.evaluate(() => ({ built: !!abilityLook.root, programs: renderer.info.programs.length, watermark: perfTelemetry.programWatermark }));
    assert.equal(before.built, false, 'Classic builds nothing');
    assert.equal(before.programs, before.watermark);
    await kit.setLook(g, 'hifi');
    const r = await g.evaluate(() => {
        const L = abilityLook, bad = [];
        const steps = __steps.map((s) => s[1]).sort((a, b) => a - b);
        const maxOf = (tex) => Math.max(0, ...__steps.filter((s) => s[2] === tex).map((s) => s[1]));
        // every route's renderer exists; every style resolves; every model a style names exists and is built
        for (const key of Object.keys(L.LOOKS)) {
            const look = L.LOOKS[key];
            for (const kind of Object.keys(look.routes)) {
                if (!L.SOURCES[kind]) bad.push(key + ': no source ' + kind);
                const rt = look.routes[kind];
                for (const part of [rt].concat(rt.also || [])) {
                    if (!L.R[part.renderer]) { bad.push(key + ': no renderer ' + part.renderer); continue; }
                    const st = L.styleOf(key, part.renderer);
                    if (!st) bad.push(key + ': no style for ' + part.renderer);
                    if (st && st.model && st.model !== 'arrow' && st.model !== 'grenade') {   // the projectile renderer's own two are not kit models
                        const m = L.MODELS[st.model];
                        if (!m) bad.push(key + ': no model ' + st.model);
                        else if (!m.built || m.pool.length !== m.count) bad.push(key + ': model ' + st.model + ' not built');
                    }
                }
            }
        }
        for (const k of Object.keys(L.CONVERTED)) if (!L.converted(k)) bad.push(k + ' lost its look');
        return {
            bad, state: L.state, steps: steps.length, maxStep: +steps[steps.length - 1].toFixed(2), medianStep: +steps[steps.length >> 1].toFixed(2),
            maxTexture: +maxOf(true).toFixed(2), maxPool: +maxOf(false).toFixed(2),
            over3: steps.filter((s) => s > 3).length, looks: Object.keys(L.LOOKS).length, models: L.MODEL_LIST.length, mats: L.mats.length,
            programs: renderer.info.programs.length, watermark: perfTelemetry.programWatermark, stalls: perfTelemetry.firstUseStalls, problems: L.problems
        };
    });
    t.diagnostic(JSON.stringify(r));
    assert.deepEqual(r.bad, [], 'the registry is consistent');
    assert.equal(r.state, 'ready');
    assert.ok(r.looks >= 20, `the ten proof abilities, the ten pilots and the roles' conversions (${r.looks})`);
    // the build runs steps while play goes on, 3 ms of them a frame; one step is never cut. The pools and models
    // are built a few pieces a step, so none of their steps is longer than the textures' own (the V2.0 noise,
    // crack and scorch steps), measured in the same run: a shared machine's load slows both alike
    assert.ok(r.maxPool <= r.maxTexture, `the longest pool or model step took ${r.maxPool} ms, the longest texture step ${r.maxTexture} ms`);
    assert.equal(r.programs, r.watermark, 'every program was compiled in the warm steps');
    assert.equal(r.stalls, 0);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(g.errors, []);
});

test('High Fidelity framework: the ten proof abilities out at once define the budget; nothing compiles in play', { timeout: 1200000 }, async (t) => {
    const g = await kit.bootHifi();
    const ten = ['omen.e', 'sage.c', 'phoenix.c', 'sova.q', 'raze.e', 'phoenix.q', 'sova.x', 'breach.e', 'killjoy.e', 'jett.e'];
    const m = await kit.measure(g, ten);
    t.diagnostic('ten: ' + JSON.stringify(m));
    // the budget was measured from this set (HIFI-CONTRACT.md): it must still hold, with the same CPU slack the roles get
    assert.deepEqual(kit.overTen(m), []);
    assert.deepEqual(await kit.checkNoCompile(g), []);
    assert.deepEqual(g.errors, []);
});
