'use strict';
// V2.3 identity budget (design 17.1; the coordinator's test). WP1 ships the skeleton: one boot checks that the build
// compiles nothing after the warm-up, has no first-use stalls, carries the V2.3 namespace with every V23.CONTRACT
// function (and no public function outside it), runs the boot hooks in V23.CONTRACT.bootOrder, and has the three new
// settings with their defaults (also for an older save that lacks them or holds an unknown value). The measures the
// design names arrive with the packages that make them non-trivial; they are listed below as todo tests:
//  - draw deltas against the formula, identity off vs on, in one page;
//  - glBufferDataBytes per event;
//  - the CPU ratio within hifi-kit's BUDGET.cpuSlack;
//  - zero Math.random calls while any V23 function is on the stack (every V23 function wrapped with a flag) over
//    600 driven frames of casts, windups, deaths and previews;
//  - hitch probes with stalls 0: first cast per Sage/Omen slot, first bot in a new chunk, first variant, first killcam,
//    MVP, showroom open, rapid switching.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

const DEFAULTS = { agentIdentity: 'on', weaponAnims: 'v23', botUtility: 'classic' };

// Before any game script: an older save, and a recorder around every V23 module function. `var V23 = {}` assigns
// through the accessor below, so each module the blocks attach (and each function added to one later, as BOTMOTION
// does to V23.bots) is wrapped. Calls made straight from the hook lines (not from inside another V23 function) are
// recorded in order until the first frame's stage.update (H5).
function initPage() {
    try {
        localStorage.setItem('valorant_v16_ls_consent', 'true');
        // no agentIdentity or weaponAnims (saved before V2.3), and a botUtility value the build does not know
        localStorage.setItem('valorant_v16_user_settings', JSON.stringify({ localStorageEnabled: true, showDamageNumbers: false, botUtility: 'bogus' }));
    } catch (e) {}
    const calls = [];
    window.__v23Calls = calls;
    let open = true, depth = 0;
    const wrapped = new WeakSet();
    const wrapFn = (mod, k, f) => {
        if (typeof f !== 'function') return f;
        const w = function () {
            if (open && depth === 0) { if (mod + '.' + k === 'stage.update') open = false; else calls.push(mod + '.' + k); }
            depth++;
            try { return f.apply(this, arguments); } finally { depth--; }
        };
        w.__v23Orig = f;
        return w;
    };
    const wrapMod = (mod, o) => {
        if (!o || typeof o !== 'object' || wrapped.has(o)) return o;
        for (const k of Object.keys(o)) o[k] = wrapFn(mod, k, o[k]);
        const p = new Proxy(o, { set(t, k, v) { t[k] = wrapFn(mod, k, v); return true; } });
        wrapped.add(p);
        return p;
    };
    let store;
    Object.defineProperty(window, 'V23', {
        configurable: true,
        get() { return store; },
        set(v) {
            store = new Proxy(v, { set(t, k, val) { t[k] = (k === 'CONTRACT' || k === 'looks' || !val || typeof val !== 'object') ? val : wrapMod(k, val); return true; } });
        }
    });
}

test('identity budget skeleton: programs equal the watermark, no stalls, the contract and boot order, the V2.3 settings', { timeout: 240000 }, async () => {
    const { errors, frames, evaluate, page } = await boot({ initScript: initPage });
    await frames(30);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiles after the warm-up');
    assert.equal(stalls, 0, 'no first-use stalls');
    const s = await evaluate(() => ({
        user: { agentIdentity: game.userSettings.agentIdentity, weaponAnims: game.userSettings.weaponAnims, botUtility: game.userSettings.botUtility },
        defaults: { agentIdentity: DEFAULT_USER_SETTINGS.agentIdentity, weaponAnims: DEFAULT_USER_SETTINGS.weaponAnims, botUtility: DEFAULT_USER_SETTINGS.botUtility },
        olderSaveLoaded: game.userSettings.showDamageNumbers === false,
        pills: ['agent-identity', 'weapon-anims', 'bot-utility'].map((k) => {
            const a = document.querySelector(`#setting-${k}-pills .settings-pill-opt.active`);
            return a ? a.textContent.trim() : null;
        }),
        ns: typeof V23 === 'object' && !!V23.CONTRACT && V23.CONTRACT.version,
        indirections: [soundFX._rand, soundFX._out, fxKit._rng]
    }));
    assert.deepEqual(s.user, DEFAULTS, 'game.userSettings has the defaults (the older save lacked two keys and held an unknown botUtility)');
    assert.deepEqual(s.defaults, DEFAULTS, 'DEFAULT_USER_SETTINGS');
    assert.ok(s.olderSaveLoaded, 'the older save itself still loads');
    assert.deepEqual(s.pills, ['ON', 'V2.3', 'CLASSIC'], 'the pills show the defaults');
    assert.equal(s.ns, 0, 'V23 and contract v0');
    assert.deepEqual(s.indirections, [null, null, null], 'soundFX._rand, soundFX._out and fxKit._rng are null by default');

    // The booted page against V23.CONTRACT: every function present, no public function outside it, fields typed as
    // the contract's stub values, the shared helpers present
    const c = await evaluate(() => {
        const C = V23.CONTRACT, problems = [];
        for (const [mod, fns] of Object.entries(C.api)) {
            const m = V23[mod];
            if (!m || typeof m !== 'object') { problems.push(`V23.${mod} missing`); continue; }
            for (const fn of Object.keys(fns)) if (typeof m[fn] !== 'function') problems.push(`V23.${mod}.${fn} is not a function`);
            for (const k of Object.keys(m)) if (typeof m[k] === 'function' && !(k in fns) && k[0] !== '_') problems.push(`V23.${mod}.${k} is public but not in V23.CONTRACT.api (private members start with _)`);
        }
        for (const [k, v] of Object.entries(C.fields)) {
            const [mod, f] = k.split('.');
            if (!V23[mod] || typeof V23[mod][f] !== typeof v) problems.push(`V23.${k} should be a ${typeof v}`);
        }
        for (const h of Object.keys(C.helpers)) if (typeof V23[h] !== 'function') problems.push(`V23.${h} is not a function`);
        // V23.seeded on the page: the stream for the call, restored after, and no shared fallback stream
        const r = V23.rand(5);
        let inside = null, noRng = false;
        V23.seeded(() => { inside = [fxKit._rng === r, soundFX._rand === r]; }, r);
        try { V23.seeded(() => 0); } catch (e) { noRng = e instanceof TypeError; }
        return { problems, inside, noRng, after: [fxKit._rng, soundFX._rand], bootOrder: C.bootOrder.slice(), calls: window.__v23Calls.slice() };
    });
    assert.deepEqual(c.problems, []);
    assert.deepEqual(c.inside, [true, true], 'V23.seeded puts the stream on fxKit._rng and soundFX._rand');
    assert.ok(c.noRng, 'V23.seeded without a stream throws');
    assert.deepEqual(c.after, [null, null], 'and restores them');
    // The hooks that run during boot, in the contract's order (the first call of each, made from a hook line)
    const first = [];
    for (const k of c.calls) if (first.indexOf(k) < 0) first.push(k);
    assert.deepEqual(first, c.bootOrder, 'boot order (V23.CONTRACT.bootOrder)');

    // The pills save like the others and change nothing else (the stubs ignore them in WP1)
    const r = await evaluate(() => {
        document.querySelector('#setting-agent-identity-pills [data-agentidentity="off"]').click();
        document.querySelector('#setting-weapon-anims-pills [data-weaponanims="classic"]').click();
        document.querySelector('#setting-bot-utility-pills [data-botutility="agent"]').click();
        const saved = JSON.parse(localStorage.getItem('valorant_v16_user_settings') || '{}');
        const out = { saved: [saved.agentIdentity, saved.weaponAnims, saved.botUtility], now: [game.userSettings.agentIdentity, game.userSettings.weaponAnims, game.userSettings.botUtility] };
        document.querySelector('#setting-agent-identity-pills [data-agentidentity="on"]').click();
        document.querySelector('#setting-weapon-anims-pills [data-weaponanims="v23"]').click();
        document.querySelector('#setting-bot-utility-pills [data-botutility="classic"]').click();
        return out;
    });
    assert.deepEqual(r.saved, ['off', 'classic', 'agent'], 'saved');
    assert.deepEqual(r.now, ['off', 'classic', 'agent']);
    await frames(10);
    assert.deepEqual(await programState(page), [watermark, watermark, 0], 'switching the V2.3 pills compiles nothing');
    assert.deepEqual(errors, []);
});

test('draw deltas against the formula, identity off vs on in one page', { todo: 'WP12: needs the identity build (WP2, WP4, WP6)' }, () => {});
test('glBufferDataBytes per event', { todo: 'WP12' }, () => {});
test("CPU ratio within hifi-kit's BUDGET.cpuSlack", { todo: 'WP12' }, () => {});
// V2.3 (WP2): the exclusion this proof must make (V23.CONTRACT.bootNotes): with agentIdentity on, core.init (H2) makes the
// part pool, the 4x4 upload target and the base material, and three.js draws each new object's uuid from Math.random
// (4 calls per object); the first switch-on (applySettings) and the showroom's first build do the same. Count from after
// the boot, or leave those constructions out. With agentIdentity off core.init makes nothing (the boot stream is V2.2's).
test('zero Math.random while any V23 function runs, over 600 driven frames', { todo: 'WP12: wraps every V23 function with a flag' }, () => {});
test('hitch probes: first cast per Sage/Omen slot, first bot in a new chunk, first variant, first killcam, MVP, showroom open, rapid switching', { todo: 'WP12' }, () => {});
