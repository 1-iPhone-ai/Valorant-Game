'use strict';
// V2.3 in-match casts with the first-person identity (WP4; design 7.4 and 17.1). One boot, the Range on Ascent, bots
// frozen. For every agent (AGENT_ORDER; ROLE=<role> filters), C, Q, E and X (the ultimate) are each cast twice on the
// same game tick, once with Agent Identity on and once off (off is V2.2's path: same.js proves it equal to V2.2), each
// from the same set-up (tests/hifi-kit.js RECIPES: spot, aim, target, soul orb):
//  - the cast consumes a charge (the ultimate its points);
//  - its effect exists on that same tick, and is the same with identity on and off (what changed in agentSystem, the
//    ultimate state and you), with the same number of Math.random draws;
//  - with identity on, castFX plays the look's mapped gesture (gestures[slot], the ultimate gestures.x);
// then the second-stage weapon fires (Sova, Raze, Neon, Chamber ultimates) give the tap gesture with a visual kick and
// no Math.random draw; no shader compiles and no first-use stalls. It prints the V23MATRIX cells for in-match casts.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');
const kit = require('./hifi-kit');

after(closeBrowser);

const ROLE = process.env.ROLE ? String(process.env.ROLE).toUpperCase() : null;
const matrix = (agent, column, ok, detail) => console.log('V23MATRIX ' + JSON.stringify({ agent, column, ok: !!ok, detail: detail === undefined ? '' : detail }));

test('in-match casts: every agent\'s C, Q, E and X consume, spawn on the same tick as V2.2 and play the mapped gesture', { timeout: 600000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    await evaluate((SPOT) => {
        Element.prototype.requestPointerLock = function () {};
        document.exitPointerLock = function () {};
        window.updateEnemies = () => {};
        try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {}
        tacticalDirector.setGameMode('range');
        window.updateEnemies = () => {};
        window.__SPOT = SPOT;
        // the state a cast can change on its own tick: agentSystem's pooled items (how many are out), its single items
        // and flags, numbers and booleans; the ultimate; you
        window.__sig = () => {
            const o = {}, A = agentSystem;
            for (const k of Object.keys(A)) {
                const v = A[k];
                if (Array.isArray(v)) { let n = 0; for (const it of v) if (it && typeof it === 'object' && (it.inUse === true || it.active === true)) n++; o['N.' + k] = n; }
                else if (v && typeof v === 'object' && !v.isObject3D && ('inUse' in v || 'active' in v)) o['A.' + k] = !!(v.inUse || v.active);
                else if (typeof v === 'number' || typeof v === 'boolean') o['A.' + k] = v;
            }
            const cc = characterController;
            o.ultAgent = game.ultAgent; o.ultUntil = game.ultActiveUntil; o.ultCharges = game.ultChargesLeft;
            o.you = [cc.position.x, cc.position.y, cc.position.z].map((x) => x.toFixed(4)).join(',');
            o.vel = cc.velocity ? [cc.velocity.x, cc.velocity.y, cc.velocity.z].map((x) => x.toFixed(4)).join(',') : '';
            o.health = game.health; o.shield = game.shield;
            return o;
        };
        // what the cast changed (the keys)
        window.__diff = (a, b) => Object.keys(b).filter((k) => a[k] !== b[k]);
        window.__identity = (on) => { game.userSettings.agentIdentity = on ? 'on' : 'off'; V23.core.applySettings(game.userSettings, 'agentIdentity'); };
        // the kit's clear: every ability item out ends through the normal update paths (next frame)
        window.__clear = () => {
            game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
            const end = (it) => { if (!it || typeof it !== 'object' || it.isObject3D) return; if ('expireAt' in it) it.expireAt = 1; if ('endTime' in it) it.endTime = 1; if ('executeAt' in it) it.executeAt = 1; };
            const A = agentSystem;
            for (const k of Object.keys(A)) {
                const v = A[k];
                if (Array.isArray(v)) { for (const it of v) if (it && typeof it === 'object' && ('inUse' in it || 'active' in it)) end(it); }
                else if (v && typeof v === 'object' && ('inUse' in v || 'active' in v)) end(v);
            }
            for (const p of A.projectiles) if (p.inUse) { p.inUse = false; p.mesh.visible = false; }
            for (const k of ['neonHighGearUntil', 'isoDoubleTapUntil', 'clovePickMeUpUntil', 'waylayLightspeedUntil', 'miksHarmonizeUntil', 'reynaDismissUntil', 'brimStimUntil']) if (typeof A[k] === 'number') A[k] = 0;
            if (castFX.active) { castFX.active = null; castFX.hide(); }
        };
        // one cast from its recipe's set-up; returns the charge, the tick's changes, the Math.random draws, the gesture
        window.__castOnce = (key, r, on) => {
            const [agent, slot] = key.split('.');
            __identity(on);
            game.userSettings.infiniteAbilities = false;
            game.userSettings.infiniteUlt = false;
            agentSystem.selectAgent(agent);
            game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
            if (castFX.active) { castFX.active = null; castFX.hide(); }
            const at = r.at || __SPOT, aim = r.aim || [-0.3, 0], cc = characterController;
            cc.position.set(at[0], at[1], at[2]); cc.prevSimPosition.copy(cc.position); if (cc.velocity) cc.velocity.set(0, 0, 0);
            camera.position.copy(cc.position);
            camera.rotation.set(aim[0], aim[1], 0, 'YXZ');
            if (cc.targetRotation) cc.targetRotation.y = aim[1];
            game.health = 100; game.shield = 50;
            if (r.away) for (const x of enemyObjects) { if (!x.isActive || x.hit) continue; x.mesh.position.set(40, 0, -40); x.poseDirty = true; syncEnemyBroadphase(x); }
            if (r.target) {
                const e = window.__tgt && window.__tgt.isActive && !window.__tgt.hit ? window.__tgt : enemyObjects.find((x) => x.isActive && !x.hit);
                if (e) { window.__tgt = e; e.mesh.position.set(r.target[0], 0, r.target[1]); e.poseDirty = true; e.health = Math.max(e.health, 1e6); syncEnemyBroadphase(e); }
            }
            if (r.orb) agentSystem.onActorEliminated('enemy', new THREE.Vector3(r.orb[0], 0, r.orb[1]));
            const st = slot === 'x' ? null : agentSystem.stateByAgent[agent][slot];
            if (st) st.charges = st.maxCharges;
            if (slot === 'x') game.ultPoints = game.maxUltPoints;
            const before = __sig(), real = Math.random;
            let draws = 0;
            Math.random = function () { draws++; return real(); };
            try {
                agentSystem.castAbility(slot);
                if (slot === 'x' && r.xFire) agentSystem.castAbility('x');
            } finally { Math.random = real; }
            const after = __sig();
            const cur = V23.fp.state.cur;
            const out = {
                charge: slot === 'x' ? (game.ultPoints === 0 && game.ultAgent === agent) : (st ? st.charges === st.maxCharges - 1 : false),
                changed: __diff(before, after), before, after, now: gameNow(), draws,
                kind: castFX.active ? castFX.active.kind : null, gesture: cur ? cur.name : null
            };
            game.userSettings.infiniteAbilities = true;
            game.userSettings.infiniteUlt = true;
            return out;
        };
    }, kit.SPOT);
    const agents = await evaluate((role) => AGENT_ORDER.filter((id) => !role || AGENT_DEFS[id].role === role), ROLE);
    assert.ok(agents.length >= (ROLE ? 1 : 29));
    const RECIPES = kit.RECIPES;
    // a key's state after the cast, comparable across the two passes (which run on different ticks, and where the
    // first pass's items and timers may still be out): pooled items as the number the cast added, a timer still ahead
    // relative to the cast's game time, everything else as it stands
    const norm = (r, k) => {
        const a = r.before[k], b = r.after[k];
        if (k.startsWith('N.')) return b - a;
        if (typeof b === 'number') return b > r.now + 1e-6 ? 'now+' + (b - r.now).toFixed(3) : (b === a ? 'unchanged' : 'delta' + (b - a).toFixed(6));
        return b;
    };
    const fails = [];
    // the agent's four casts in one pass (the same order and start state in both passes; each pass's items are cleared
    // and end through their update paths before the next pass)
    const pass = (agent, on) => evaluate(([agent, RECIPES, on]) => {
        const out = {};
        for (const slot of ['c', 'q', 'e', 'x']) {
            const key = agent + '.' + slot;
            out[slot] = __castOnce(key, RECIPES[key] || {}, on);
            __clear();
        }
        __identity(true);
        return out;
    }, [agent, RECIPES, on]);
    for (const agent of agents) {
        const onPass = await pass(agent, true);
        await frames(3);
        const offPass = await pass(agent, false);
        await frames(3);
        const look = await evaluate((agent) => V23.core.resolve(agent).gestures, agent);
        const cells = [], probs = [];
        for (const slot of ['c', 'q', 'e', 'x']) {
            const on = onPass[slot], off = offPass[slot], want = look[slot];
            const keys = on.changed, all = [...new Set(on.changed.concat(off.changed))];
            if (!on.charge) probs.push(`${slot}: no charge consumed`);
            if (!off.charge) probs.push(`${slot}: no charge consumed with identity off`);
            if (!keys.length) probs.push(`${slot}: no effect on the cast's tick`);
            const A = {}, B = {};
            for (const k of all) { A[k] = norm(on, k); B[k] = norm(off, k); }
            if (JSON.stringify(A) !== JSON.stringify(B)) probs.push(`${slot}: the tick differs with identity on and off:\n  on  ${JSON.stringify(A)}\n  off ${JSON.stringify(B)}`);
            if (on.draws !== off.draws) probs.push(`${slot}: Math.random draws ${on.draws} with identity on, ${off.draws} off`);
            const kind = slot === 'x' ? 'ult' : 'cast';
            if (on.kind !== kind || on.gesture !== want) probs.push(`${slot}: castFX ${on.kind} ${on.gesture}, mapped ${kind} ${want}`);
            if (off.gesture !== null) probs.push(`${slot}: a V2.3 gesture with identity off`);
            cells.push(`${slot.toUpperCase()} ${want} (${keys.length} changes)`);
        }
        matrix(agent, 'in-match casts C/Q/E/X and ult functional with the new presentation', probs.length === 0, cells.join(', '));
        if (probs.length) fails.push(`${agent}:\n  ${probs.join('\n  ')}`);
    }
    assert.deepEqual(fails, []);

    // Second-stage weapon fires (H19): the tap gesture for the ability, a visual kick on the viewmodel spring, no
    // Math.random draw from V2.3 (shoot's own draws are V2.2's: counted with identity on and off)
    const fire = await evaluate((agents) => {
        const out = {};
        for (const agent of ['sova', 'raze', 'neon', 'chamber'].filter((a) => agents.includes(a))) {
            const res = {};
            for (const on of [true, false]) {
                __identity(on);
                agentSystem.selectAgent(agent);
                switchWeapon('rifle');
                game.ultPoints = game.maxUltPoints;
                game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
                agentSystem.castAbility('x');
                if (castFX.active) { castFX.active = null; castFX.hide(); }
                const vp = vmAnim.sp.vp, real = Math.random;
                let draws = 0;
                Math.random = function () { draws++; return real(); };
                try { game.lastShot = 0; shoot(); } finally { Math.random = real; }
                const cur = V23.fp.state.cur, look = V23.core.resolve(agent);
                res[on ? 'on' : 'off'] = { kind: castFX.active ? castFX.active.kind : null, key: cur ? cur.key : null, gesture: cur ? cur.name : null, want: look.gestures.x2 || 'wristTap', kick: vmAnim.sp.vp - vp, draws };
                __clear();
            }
            __identity(true);
            out[agent] = res;
        }
        return out;
    }, agents);
    for (const [agent, r] of Object.entries(fire)) {
        assert.deepEqual([r.on.kind, r.on.key, r.on.gesture], ['tap', agent + '.x', r.on.want], `${agent}: the second-stage fire's tap gesture`);
        assert.ok(r.on.kick > 0, `${agent}: a visual kick (${r.on.kick})`);
        assert.equal(r.on.draws, r.off.draws, `${agent}: the fire draws Math.random as V2.2 does (${r.on.draws} vs ${r.off.draws})`);
        assert.deepEqual([r.off.kind, r.off.kick], [null, 0], `${agent}: identity off: no gesture or kick (V2.2)`);
    }
    await frames(5);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiled after the warm-up');
    assert.equal(stalls, 0, 'no first-use stalls');
    assert.deepEqual(errors, []);
});
