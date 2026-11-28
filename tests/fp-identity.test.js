'use strict';
// V2.3 first-person identity (WP4; design 7 and 17.1). Three boots.
// The first, with Agent Identity set on explicitly:
//  - for every agent (AGENT_ORDER; ROLE=<role> filters): each gun model's arm Group sits right after its hands with the
//    agent's V23.parts.fpArms pair, the sleeve and detail materials take the palette slots the pair names, the look's fp
//    fields (sleeve, cuff, wrist, overlay) show, the wrist module stands out of the forearm at the wrist, and the glove
//    and tip materials match the palette (the tips are skin for fingerless gloves); castFX's hand takes the gloves, its
//    sleeve the agent's LEFT forearm (the cast hand is the left hand) placed from the left-wrist frame, hand2 the right
//    forearm through a mirrored mount; V23MATRIX rows for the sleeve, glove and tips, and wrist columns;
//  - the grouped hands: 4 groups with hand A exactly the first half (simple with 2 and 4 fingers, High Detail, Ultra);
//    the off-hand drawRange API takes the support hand (the left, hand B; the right in left-handed mode) and its
//    forearm away, so no cuff or wrist module is left without its hand, identity on and off;
//  - for every agent, each slot's cast (and the ultimate) plays the look's mapped gesture, reaches its release key at p
//    0.10-0.16 with the hand at the key (the raw key, or for a key under the view the FP block's in-view floor, listed)
//    and castFX.core on the energy point, makes no Math.random call, and leaves the gun exactly at rest (drift < 1e-6);
//    with Enhanced Animations off and on;
//  - a gesture cut off by a clock jump leaves no hand2 and no stale pose behind (Enhanced Animations' off hand after it);
//  - an ultimate leaves the centre clear: after p 0.25 no energy card within 0.28 NDC of the centre, the centre crop's
//    luminance within 10% at p 0.7, and the #ult-cue vignette (clear centre, opacity caps, below the crosshair);
//  - the first-person draw budget (design 15) for Sage, Omen and 4 others in gun views, casts (one- and two-hand), the
//    ultimate, taps and Enhanced Animations' off hand: the identity's draws over V2.2's own for the same objects (the gun
//    hands, the cast hand and sleeve), at most +6 fingerless and +3 gloved (V23BUDGET lines carry the numbers);
//  - render crops for Sage, Omen and 4 others in every hand tier (the session's simple hands, High Detail, Ultra) and in
//    left-handed mode (the game's own placement: the arms follow the gun across and are never mirrored), through the
//    plain, Cinematic and Ultra pipelines, with the off hand kept away across each tier swap, programs == watermark and
//    no stalls;
//  - identity off: the V2.2 hands (0xffdbac), no arms, V2.2's castFX and pose.
// The second boot has Agent Identity off from the start (saved): nothing is built, and the off-hand drawRange follows
// every hands swap. The third boots without WebGL2 (Ultra unsupported): the first-person set is built and applied before
// play, and the first cast builds nothing.
// Crops are written as PNG files when FP_SHOTS=<dir> is set.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

const ROLE = process.env.ROLE ? String(process.env.ROLE).toUpperCase() : null;
const SHOTS = process.env.FP_SHOTS || null;
const CROP_AGENTS = ['sage', 'omen', 'jett', 'sova', 'killjoy', 'viper'];
const matrix = (agent, column, ok, detail) => console.log('V23MATRIX ' + JSON.stringify({ agent, column, ok: !!ok, detail: detail === undefined ? '' : detail }));
const SETTINGS_KEY = 'valorant_v16_user_settings';

// In the page: steps the viewmodel animator by hand (synchronously, as cast.test does), so a gesture is sampled at
// exact clip progress whatever the renderer's speed
const PAGE = `
    window.__vmStep = (t0, t1, sample) => {
        const model = game.weapons[game.activeWeapon].model;
        for (let t = t0; t <= t1; t += 16) { vmAnim.begin(model); vmAnim.end(model, t); if (sample) sample(t, model); }
    };
    window.__pose = (m) => [m.position.x, m.position.y, m.position.z, m.rotation.x, m.rotation.y, m.rotation.z];
    window.__dist = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
    window.__lin = (hex) => new THREE.Color(hex).convertSRGBToLinear();
    window.__same = (c, hex) => { const l = __lin(hex); return Math.abs(c.r - l.r) < 1e-4 && Math.abs(c.g - l.g) < 1e-4 && Math.abs(c.b - l.b) < 1e-4; };
    window.__identity = (on) => { game.userSettings.agentIdentity = on ? 'on' : 'off'; V23.core.applySettings(game.userSettings, 'agentIdentity'); };
    window.__clearCast = () => { if (castFX.active) { castFX.active = null; castFX.hide(); } };
    // one synchronous frame of the active pipeline into the canvas, then the crop's RGBA (rows bottom-up)
    window.__frame = () => {
        const now = performance.now();
        if (typeof ultraPost !== 'undefined' && ultraPost.active) ultraPost.render(now);
        else if (typeof postFX !== 'undefined' && postFX.enabled) postFX.render(now);
        else {
            renderer.setRenderTarget(null);
            renderer.setClearColor(scene.background, 1);
            renderer.clear();
            renderer.render(scene, camera);
            renderer.clearDepth();
            viewmodelScene.environment = scene.environment;
            syncViewmodelCamera();
            renderer.render(viewmodelScene, viewmodelCamera);
        }
    };
    window.__crop = (x0, y0, w, h) => {
        const gl = renderer.getContext(), px = new Uint8Array(w * h * 4);
        gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
    };
    window.__luma = (px) => { let s = 0; for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; return s / (px.length / 4); };
    window.__png = (px, w, h) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'), img = g.createImageData(w, h);
        for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        g.putImageData(img, 0, 0);
        return c.toDataURL('image/png');
    };
    // the drawn triangles of a mesh by side of its own x = 0 (within the geometry's drawRange): [x < 0, x > 0]
    window.__sides = (mesh) => {
        const g = mesh.geometry, idx = g.index.array, pos = g.attributes.position.array, dr = g.drawRange;
        const end = Math.min(idx.length, dr.start + dr.count);
        let L = 0, R = 0;
        for (let t = dr.start; t < end; t += 3) { if (pos[idx[t] * 3] + pos[idx[t + 1] * 3] + pos[idx[t + 2] * 3] < 0) L++; else R++; }
        return [L, R];
    };
    // the viewmodel pass's draws, counted per object (onBeforeRender runs once per drawn group): the identity's own draws
    // over V2.2's for the same objects. V2.2 draws each gun hands mesh, the cast hand and the cast sleeve once; the arms,
    // hand2, its forearm and the warm set are new; the energy cards and the guns are V2.2's in both (not counted)
    window.__budget = () => {
        const counts = new Map(), hook = function () { counts.set(this, (counts.get(this) || 0) + 1); }, saved = [];
        viewmodelScene.traverse((o) => { if (o.isMesh) { saved.push([o, Object.prototype.hasOwnProperty.call(o, 'onBeforeRender') ? o.onBeforeRender : undefined]); o.onBeforeRender = hook; } });
        syncViewmodelCamera(); viewmodelScene.environment = scene.environment; renderer.setRenderTarget(null);
        try { renderer.render(viewmodelScene, viewmodelCamera); }
        finally { for (const [o, f] of saved) { if (f === undefined) delete o.onBeforeRender; else o.onBeforeRender = f; } }
        const st = V23.fp.state, mine = new Set([st.hand2, st.hand2Fore]);
        if (st.warmSet) st.warmSet.traverse((o) => mine.add(o));
        let d = 0;
        const what = [];
        for (const [o, c] of counts) {
            const v22 = o.userData.isHands || o === castFX.hand || o === castFX.sleeve;
            const v23 = v22 || o.userData.isAgentArm || mine.has(o);
            if (!v23) continue;
            d += c - (v22 ? 1 : 0);
            what.push((o.userData.isHands ? 'hands' : o === castFX.hand ? 'castHand' : o === castFX.sleeve ? 'castFore' : o === st.hand2 ? 'hand2' : o === st.hand2Fore ? 'hand2Fore' : o.userData.isAgentArm ? 'arm' : 'warm') + 'x' + c);
        }
        return { d, what: what.sort().join(' ') };
    };
`;

test('first-person identity: arms, gloves, wrists, off hand, gestures, budget, ultimate cue, render crops, identity off', { timeout: 600000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', viewport: { width: 480, height: 270 } });
    await page.addScriptTag({ content: PAGE });
    await evaluate(() => {
        Element.prototype.requestPointerLock = function () {};
        document.exitPointerLock = function () {};
        window.updateEnemies = () => {};
        try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {}
        game.userSettings.infiniteAbilities = true;
        game.userSettings.infiniteUlt = true;
        __identity(true);
        if (enhancedAnim.on) enhancedAnim.set(false);
    });
    const agents = await evaluate((role) => AGENT_ORDER.filter((id) => !role || AGENT_DEFS[id].role === role), ROLE);
    assert.ok(agents.length >= (ROLE ? 1 : 29), `agents (${agents.length})`);

    // ---- 1. every agent's arms, gloves, wrists and cast forearms, from data ---------------------------------------------
    const RIG_FORE = { lean: 0.050, std: 0.054, broad: 0.060, tall: 0.051, heavy: 0.065, compact: 0.056 };   // PARTS _RIG_DIMS fore
    const data = await evaluate(([agents, RIG_FORE]) => {
        const out = {};
        const st = V23.fp.state;
        const a = new THREE.Vector3(0, -0.75, 0.66).normalize(), W = new THREE.Vector3(0.08, -0.09, 0), v = new THREE.Vector3(), d = new THREE.Vector3();
        const near = (p, x, y, z) => Math.hypot(p.x - x, p.y - y, p.z - z) < 1e-6;
        for (const id of agents) {
            agentSystem.selectAgent(id);
            const look = V23.core.resolve(id), res = V23.parts.fpArms(look), P = look.palette, probs = [];
            const slotHex = (s) => (P[s] || (s === 'visor' ? P.glow : null) || P.base).c;
            if (st.agent !== id) probs.push('V23.fp follows the agent (' + st.agent + ')');
            // arms on the 4 models: right after the hands, the agent's pair, materials per group from the slots it names
            const models = st.models;
            for (const m of models) {
                const arm = m.arm;
                if (!arm || !arm.userData.isAgentArm || !arm.visible) { probs.push(m.slot + ': no visible arm'); continue; }
                if (m.armIndex !== m.handsIndex + 1) probs.push(m.slot + ': arm at ' + m.armIndex + ', hands at ' + m.handsIndex);
                const [sl, dt] = arm.children;
                if (sl.geometry !== res.sleeve || dt.geometry !== res.detail) probs.push(m.slot + ': not the agent\'s fpArms pair');
                for (const [mesh, slots] of [[sl, res.slots.sleeve], [dt, res.slots.detail]]) {
                    for (const gr of mesh.geometry.groups) {
                        const mat = mesh.material[gr.materialIndex], s = slots[gr.materialIndex] || slots[0];
                        if (!__same(mat.color, slotHex(s))) probs.push(m.slot + ': group ' + gr.materialIndex + ' is not palette.' + s);
                        if (mat.toneMapped !== false) probs.push(m.slot + ': arm material toneMapped');
                    }
                }
            }
            // the look's fp fields
            const fp = look.fp;
            const sleeveOk = res.slots.sleeve[0] === fp.sleeve && res.draws <= 3 && res.sleeve.index.count > 0;
            const cuffOk = res.cuffFolded ? res.slots.detail.length === 1 && res.slots.detail[0] === 'glow' : res.slots.detail[0] === fp.cuff;
            if (!sleeveOk) probs.push('sleeve slots ' + res.slots.sleeve.join('+') + ' draws ' + res.draws);
            if (!cuffOk) probs.push('detail slots ' + res.slots.detail.join('+'));
            if (res.overlay !== (fp.overlay || null)) probs.push('overlay ' + res.overlay);
            // the wrist module: it emits parts, the set names it, and the right arm has vertices at the wrist band that
            // stand out of the bare forearm (8% beyond its radius there)
            const wristParts = V23.parts.module(fp.wrist, { n: look.gloves.wrist.n }, 'show').length;
            const rWrist = RIG_FORE[look.rig] * 0.85 * 0.75;
            let out8 = 0;
            for (const g of [res.sleeve, res.detail]) {
                const p = g.attributes.position;
                for (let i = 0; i < p.count; i++) {
                    v.fromBufferAttribute(p, i);
                    if (v.x <= 0) continue;
                    d.subVectors(v, W);
                    const t = d.dot(a);
                    if (t < 0.003 || t > 0.05) continue;
                    if (d.addScaledVector(a, -t).length() > rWrist * 1.08) out8++;
                }
            }
            const wristOk = res.wrist === fp.wrist && wristParts > 0 && out8 > 0;
            if (!wristOk) probs.push('wrist ' + fp.wrist + ': parts ' + wristParts + ', vertices out at the wrist ' + out8);
            // gloves and tips
            const G = look.gloves, gloveHex = G.type === 'bare' ? P.skin.c : slotHex(fp.glove), two = G.type !== 'bare' && (G.tips === 'skin' || G.type === 'fingerless' || G.type === 'wrap') && P.skin.c !== gloveHex;
            const hands = models.map((m) => game.weapons[m.slot].model.children[m.handsIndex]);
            let gloveOk = st.two === two;
            for (const h of hands) {
                const mats = Array.isArray(h.material) ? h.material : [h.material];
                if (two !== Array.isArray(h.material)) gloveOk = false;
                if (!__same(mats[0].color, gloveHex) || mats[0].toneMapped !== false) gloveOk = false;
                if (two && !__same(mats[1].color, P.skin.c)) gloveOk = false;
                if (!h.geometry.userData.v23Src || h.geometry.groups.length < 2) gloveOk = false;
            }
            if (G.type === 'fingerless' && !two) gloveOk = false;   // fingerless: the tips are skin
            if (!gloveOk) probs.push('gloves ' + G.type + ' two ' + two + '/' + st.two);
            // castFX: the same glove materials; its sleeve is the agent's LEFT forearm (sleeve and detail triangles at x < 0,
            // one geometry) on the left-wrist frame: the left wrist under the palm, the left hand's thumb toward +x (the
            // cast hand's thumb side), a proper rotation; hand2's forearm is the RIGHT one on a mirrored mount (hand2 is
            // itself a mirror image, so it ends up unmirrored); each run of the forearm takes its palette slot
            const fx = castFX, A = V23.fp._arm(id), fore = fx.sleeve.geometry, h2f = st.hand2Fore;
            fx.sleeve.updateMatrix(); h2f.updateMatrix();
            const thumbL = new THREE.Vector3().crossVectors(a, new THREE.Vector3(-1, 0, 0)).normalize().negate();
            const wL = new THREE.Vector3(-0.08, -0.09, 0).applyMatrix4(fx.sleeve.matrix), wR = new THREE.Vector3(0.08, -0.09, 0).applyMatrix4(h2f.matrix);
            const thumb = thumbL.clone().transformDirection(fx.sleeve.matrix);
            const runSlot = [res.slots.sleeve[0], res.slots.detail[0], res.slots.detail[1] || res.slots.detail[0], res.slots.sleeve[1] || res.slots.sleeve[0]];
            let runsOk = fx.sleeve.material === st.castArr;
            for (const gr of fore.groups) if (!__same(st.castArr[gr.materialIndex].color, slotHex(runSlot[gr.materialIndex]))) runsOk = false;
            const castOk = fx.hand.material === hands[0].material && fore === A.fore.L.full && fore.userData.v23Side === 'L'
                && fore.index.count === A.half.L.sleeve.index.count + A.half.L.detail.index.count && fore.index.count > 0
                && near(wL, 0, -0.036, 0) && thumb.x > 0.99 && fx.sleeve.matrix.determinant() > 0 && runsOk
                && h2f.parent === st.hand2 && (h2f.geometry === A.fore.R.full || h2f.geometry === A.fore.R.folded) && near(wR, 0, -0.036, 0) && h2f.matrix.determinant() < 0;
            if (!castOk) probs.push('castFX hand or forearms (wrist ' + wL.toArray().map((x) => x.toFixed(3)) + ', thumb ' + thumb.x.toFixed(3) + ', runs ' + runsOk + ')');
            out[id] = { probs, sleeve: sleeveOk, cuff: cuffOk, wrist: wristOk, glove: gloveOk, cast: castOk, draws: res.draws, slots: res.slots.sleeve.join('+') + '/' + res.slots.detail.join('+'), type: G.type, two };
        }
        return out;
    }, [agents, RIG_FORE]);
    for (const id of agents) {
        const r = data[id];
        matrix(id, 'first-person sleeve', r.sleeve && r.cast, `${r.slots}, ${r.draws} arm draws`);
        matrix(id, 'first-person glove and tips', r.glove, `${r.type}${r.two ? ' (skin tips)' : ''}`);
        matrix(id, 'first-person wrist detail', r.wrist && r.cuff, '');
        assert.deepEqual(r.probs, [], `${id}: arms, gloves, wrist`);
    }
    // the pilots' looks: Sage's rolled ceramic sleeve over skin with the ampoules as the accent and skin fingertips;
    // Omen's undersuit sleeve with trim plate overlays on the left forearm (the cast hand's) and one dark gauntlet material
    if (data.sage) assert.deepEqual([data.sage.slots, data.sage.two, data.sage.type], ['base+skin/glow', true, 'fingerless']);
    if (data.omen) {
        assert.deepEqual([data.omen.slots.split('/')[0], data.omen.two, data.omen.type], ['under', false, 'gauntlet']);
        const plates = await evaluate(() => {
            const A = V23.fp._arm('omen'), cuff = (g) => { const gr = g.groups.find((x) => x.materialIndex === 1); return gr ? gr.count : 0; };
            return { L: cuff(A.fore.L.full), R: cuff(A.fore.R.full) };
        });
        assert.ok(plates.L > plates.R, `Omen's plate overlay is on the left forearm, the cast hand's (${plates.L} vs ${plates.R} cuff indices)`);
    }

    // ---- 2. grouped hands: hand A is the first half; the off-hand drawRange API ------------------------------------------
    const grouped = await evaluate(() => {
        const out = {};
        const check = (g) => {
            const n = g.index.count, half = g.userData.v23Half, gr = g.groups;
            return { n, half, groups: gr.length, mats: gr.map((x) => x.materialIndex).join(''), firstHalf: half * 2 === n && gr.filter((x) => x.start < half).every((x) => x.start + x.count <= half) };
        };
        for (const [k, f] of [['simple2', 2], ['simple4', 4]]) out[k] = check(V23.fp._handsGeometry('simple', 0.2, f));
        out.detailed = check(V23.fp._handsGeometry('detailed', 0.2, 4));
        out.ultra = check(V23.fp._handsGeometry('ultra', 0.2, 4));
        agentSystem.selectAgent('sage');
        switchWeapon('pistol');
        const pistol = game.weapons.pistol.model, hands = pistol.children.find((c) => c.userData.isHands), arm = pistol.children.find((c) => c.userData.isAgentArm);
        out.live = check(hands.geometry);
        out.fingers = CONTENT.fingers;
        // where each hand lands on screen (mean NDC x of its triangles' vertices), the first half and the second
        const g = hands.geometry, half = g.userData.v23Half, idx = g.index.array, pos = g.attributes.position.array, vv = new THREE.Vector3();
        pistol.updateMatrixWorld(true); syncViewmodelCamera(); viewmodelCamera.updateMatrixWorld(true);
        const ndcX = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += vv.fromArray(pos, idx[i] * 3).applyMatrix4(hands.matrixWorld).project(viewmodelCamera).x; return s / (b - a); };
        out.screenX = [ndcX(0, half), ndcX(half, idx.length)];
        const state = () => ({ range: [g.drawRange.start, g.drawRange.count], hands: __sides(hands), sleeve: __sides(arm.children[0]), detail: __sides(arm.children[1]) });
        out.api = V23.fp.offHand(pistol, true);
        out.hidden = state();
        out.hiddenSide = V23.fp.state.models.find((m) => m.slot === 'pistol').offSide;
        out.shown = (V23.fp.offHand(pistol, false), state());
        // left-handed: the support hand is the right one (hand A)
        game.userSettings.leftHanded = true;
        V23.fp.offHand(pistol, true);
        out.lefty = state();
        V23.fp.offHand(pistol, false);
        game.userSettings.leftHanded = false;
        // identity off: V2.2's merged hands, the same convention (no arms)
        __identity(false);
        const g0 = hands.geometry;
        V23.fp.offHand(pistol, true);
        out.off = { v22: !g0.userData.v23Src, range: [g0.drawRange.start, g0.drawRange.count], n: g0.index ? g0.index.count : g0.attributes.position.count, hands: g0.index ? __sides(hands) : null };
        V23.fp.offHand(pistol, false);
        out.offShown = [g0.drawRange.start, g0.drawRange.count];
        __identity(true);
        out.unknown = V23.fp.offHand(new THREE.Group(), true);
        return out;
    });
    for (const k of ['simple2', 'simple4', 'detailed', 'ultra', 'live']) {
        assert.equal(grouped[k].groups, 4, `${k}: 4 groups`);
        assert.equal(grouped[k].mats, '0101', `${k}: [glove, tips, glove, tips]`);
        assert.ok(grouped[k].firstHalf, `${k}: hand A is exactly the first half of the index buffer`);
    }
    const half = grouped.live.half;
    assert.ok(grouped.screenX[0] > grouped.screenX[1], `hand A (first half) is the screen-right hand, B the left (${grouped.screenX.map((x) => x.toFixed(3))})`);
    assert.equal(grouped.api, true, 'offHand on a gun model');
    assert.equal(grouped.hiddenSide, 'L', 'right-handed: the support hand is the left');
    assert.deepEqual(grouped.hidden.range, [0, half], 'the left hand away: only the first half (hand A, the right hand) draws');
    assert.ok(grouped.hidden.hands[0] === 0 && grouped.hidden.hands[1] > 0, `no left-hand triangle drawn (${grouped.hidden.hands})`);
    for (const k of ['sleeve', 'detail']) assert.ok(grouped.hidden[k][0] === 0 && grouped.hidden[k][1] > 0, `the left forearm's ${k} (cuff and wrist module included) goes with its hand (${grouped.hidden[k]})`);
    assert.deepEqual(grouped.shown.range, [0, Infinity], 'offHand(false): both hands');
    for (const k of ['hands', 'sleeve', 'detail']) assert.ok(grouped.shown[k][0] > 0 && grouped.shown[k][1] > 0, `offHand(false): both sides of the ${k} (${grouped.shown[k]})`);
    assert.deepEqual(grouped.lefty.range, [half, grouped.live.n - half], 'left-handed: the right hand away (the second half draws)');
    for (const k of ['hands', 'sleeve', 'detail']) assert.ok(grouped.lefty[k][0] > 0 && grouped.lefty[k][1] === 0, `left-handed: the right ${k} goes (${grouped.lefty[k]})`);
    assert.ok(grouped.off.v22 && grouped.off.range[0] === 0 && grouped.off.range[1] === grouped.off.n / 2, `identity off: V2.2's hands, the left hand away (${JSON.stringify(grouped.off)})`);
    if (grouped.off.hands) assert.ok(grouped.off.hands[0] === 0 && grouped.off.hands[1] > 0, `identity off: no left-hand triangle drawn (${grouped.off.hands})`);
    assert.deepEqual(grouped.offShown, [0, Infinity]);
    assert.equal(grouped.unknown, false, 'offHand on an unknown model');

    // ---- 3. every agent's gestures, Enhanced Animations off and on ---------------------------------------------------------
    const floored = new Set();
    for (const ea of [false, true]) {
        const g = await evaluate(([agents, ea]) => {
            enhancedAnim.set(ea);
            const out = {}, real = Math.random, floored = [];
            let draws = 0;
            for (const id of agents) {
                agentSystem.selectAgent(id);
                switchWeapon('rifle');
                const look = V23.core.resolve(id), probs = [], cells = [];
                const model = game.weapons.rifle.model;
                let t = performance.now() + 1000;
                __vmStep(t - 500, t);
                // the gun's pose net of Enhanced Animations' idle breathing (eaFP.breath: this frame's offset, which a cast
                // pauses in V2.2 as well), so the drift measures what the gesture leaves behind
                const net = () => { const q = __pose(model); if (enhancedAnim.on) { q[1] -= eaFP.breath.py; q[3] -= eaFP.breath.rx; } return q; };
                const rest = net();
                for (const slot of ['c', 'q', 'e', 'x']) {
                    const kind = slot === 'x' ? 'ult' : 'cast';
                    __clearCast();
                    castFX.start(kind, AGENT_DEFS[id].themeColor, id + '.' + slot);
                    const A = castFX.active, cur = V23.fp.state.cur;
                    const want = look.gestures[slot];
                    if (!cur || cur.name !== want) { probs.push(slot + ': gesture ' + (cur && cur.name) + ', mapped ' + want); continue; }
                    A.start = t;
                    const pr = cur.pr, gest = V23.motion.gesture(want), key = gest.fp[1], hand = 1, M = look.motion;
                    if (!(pr >= 0.10 - 1e-9 && pr <= 0.16 + 1e-9)) probs.push(slot + ': release at p ' + pr.toFixed(3));
                    // the release key's palm height: the raw key, or (a key whose palm sits under the view, NDC y < -0.85
                    // at its depth) the FP block's in-view floor; such keys are listed
                    const P5 = viewmodelCamera.projectionMatrix.elements[5], depth = Math.max(0.05, -key[3]);
                    const rawNdcY = key[2] * P5 / depth, low = rawNdcY < -0.85;
                    const keyY = low ? -0.85 * depth / P5 : key[2];
                    if (low) floored.push(want);
                    // no Math.random while the gesture plays
                    Math.random = function () { draws++; return real(); };
                    let atRelease = null, released = false;
                    try {
                        const tRel = t + pr * A.dur + 0.01;   // on the release key (a hundredth of a ms past it)
                        __vmStep(t, tRel - 1);
                        // the frame on the release key itself
                        vmAnim.begin(model); vmAnim.end(model, tRel);
                        const gp = castFX.group.position, gr = castFX.group.rotation, e = cur.energy;
                        atRelease = {
                            pos: Math.hypot(gp.x - (key[1] - 0.018 * M.asym) * hand, gp.y - keyY, gp.z - key[3]),
                            ndcY: P5 * gp.y / Math.max(0.05, -gp.z),
                            rot: Math.abs(gr.x - key[4]) + Math.abs(gr.y - key[5] * hand) + Math.abs(gr.z - key[6] * hand),
                            core: castFX.core.position.distanceTo(e), toHand: e.distanceTo(gp), visible: castFX.group.visible, released: cur.released
                        };
                        __vmStep(tRel + 16, t + A.dur + 200);
                        released = cur.released;
                    } finally { Math.random = real; }
                    if (atRelease.pos > 2e-3 || atRelease.rot > 2e-3) probs.push(slot + ': at the release key the hand is ' + atRelease.pos.toFixed(4) + ' m / ' + atRelease.rot.toFixed(4) + ' rad off the key' + (low ? ' (floored)' : ''));
                    if (atRelease.ndcY < -0.85 - 1e-3) probs.push(slot + ': the palm is under the view at the release key (NDC y ' + atRelease.ndcY.toFixed(3) + ')');
                    if (atRelease.core > 1e-9 || atRelease.toHand > 0.12) probs.push(slot + ': castFX.core ' + atRelease.core + ' off the energy point, which is ' + atRelease.toHand.toFixed(3) + ' m from the hand');
                    if (!atRelease.visible || !atRelease.released || !released) probs.push(slot + ': hand shown and the release key passed');
                    const drift = __dist(net(), rest);
                    if (drift >= 1e-6) probs.push(slot + ': drift ' + drift);
                    if (castFX.active !== null || castFX.group.visible) probs.push(slot + ': still shown after the clip');
                    cells.push(slot + ' ' + want + ' @' + pr.toFixed(3));
                }
                out[id] = { probs, cells };
            }
            enhancedAnim.set(false);
            return { out, draws, floored };
        }, [agents, ea]);
        assert.equal(g.draws, 0, `EA ${ea ? 'on' : 'off'}: no Math.random call while gestures play`);
        for (const f of g.floored) floored.add(f);
        for (const id of agents) {
            if (!ea) matrix(id, 'first-person gestures C/Q/E/X match the mapping', g.out[id].probs.length === 0, g.out[id].cells.join(', '));
            assert.deepEqual(g.out[id].probs, [], `${id} gestures with Enhanced Animations ${ea ? 'on' : 'off'}`);
        }
    }
    // the gestures whose first-person release key sits under the view (WP2's GESTURES data): the FP block's floor holds them
    console.log('V23FLOOR ' + JSON.stringify([...floored].sort()));

    // ---- 3b. a gesture cut off by a clock jump: no hand2 or stale pose left for Enhanced Animations' off hand -----------
    const cut = await evaluate(() => {
        enhancedAnim.set(true);
        agentSystem.selectAgent('sage'); switchWeapon('rifle');
        const model = game.weapons.rifle.model, st = V23.fp.state, out = {};
        const t = performance.now() + 1000;
        __vmStep(t - 400, t);
        const look = V23.core.resolve('sage'), slot = ['c', 'q', 'e', 'x'].find((s) => V23.motion.gesture(look.gestures[s]).hands > 1);
        castFX.start(slot === 'x' ? 'ult' : 'cast', AGENT_DEFS.sage.themeColor, 'sage.' + slot);
        castFX.active.start = t;
        for (let x = t; x <= t + 0.35 * castFX.active.dur; x += 16) { vmAnim.begin(model); vmAnim.end(model, x); }
        out.mid = { slot, hand2: st.hand2.visible, pose: castFX.hand.geometry.name };
        // the clock jumps past the clip (a pause or a long stall): castFX.apply ends it without a last pose
        vmAnim.begin(model); vmAnim.end(model, t + 5000);
        out.afterJump = { active: !!castFX.active, hand2: st.hand2.visible };
        // Enhanced Animations' off hand takes castFX.group for a mantle
        characterController.mantleT = 0.4;
        for (let x = t + 5016; x <= t + 5400; x += 16) { vmAnim.begin(model); vmAnim.end(model, x); }
        __frame();
        out.mantle = { offKind: eaFP.offKind, group: castFX.group.visible, hand2: st.hand2.visible, pose: castFX.hand.geometry.name, fore: st.fore[0] };
        characterController.mantleT = -1;
        for (let x = t + 5416; x <= t + 6400; x += 16) { vmAnim.begin(model); vmAnim.end(model, x); }
        enhancedAnim.set(false);
        __clearCast();
        return out;
    });
    assert.equal(cut.mid.hand2, true, `a two-hand gesture (${cut.mid.slot}) shows hand2`);
    assert.deepEqual(cut.afterJump, { active: false, hand2: false }, 'the clip cut off by the jump: hand2 is no longer shown (no render needed)');
    assert.deepEqual(cut.mantle, { offKind: 'mantle', group: true, hand2: false, pose: 'v23:castHand:open', fore: 'full' }, 'after the cut: hand2 hidden, the open hand with its one-hand forearm');

    // ---- 4. ultimates leave the centre clear; the #ult-cue vignette ------------------------------------------------------
    const ultAgents = agents.filter((id) => CROP_AGENTS.includes(id));
    const ult = await evaluate((ultAgents) => {
        const out = {};
        switchWeapon('rifle');
        const cc = characterController;
        cc.position.set(0, cc.standHeight, 22); cc.prevSimPosition.copy(cc.position); camera.position.copy(cc.position);
        camera.rotation.set(0, 0, 0, 'YXZ'); if (cc.targetRotation) cc.targetRotation.y = 0;
        updateWeaponPosition();
        const W = renderer.getContext().drawingBufferWidth, H = renderer.getContext().drawingBufferHeight;
        const cw = Math.round(W * 0.15), ch = Math.round(H * 0.15), cx = Math.round((W - cw) / 2), cy = Math.round((H - ch) / 2);
        const model = game.weapons.rifle.model;
        for (const id of ultAgents) {
            agentSystem.selectAgent(id);
            __clearCast();
            let t = performance.now() + 1000;
            __vmStep(t - 500, t);
            __frame();
            const base = __luma(__crop(cx, cy, cw, ch));
            castFX.start('ult', AGENT_DEFS[id].themeColor, id + '.x');
            const A = castFX.active;
            A.start = t;
            const P = viewmodelCamera.projectionMatrix.elements;
            let minCard = 9, minHand = 9;
            const ndc = (o) => { const z = -o.position.z; return Math.hypot(P[0] * o.position.x / z, P[5] * o.position.y / z); };
            __vmStep(t, t + A.dur * 0.7, (tt) => {
                const p = (tt - t) / A.dur;
                if (p < 0.25) return;
                for (const o of [castFX.halo, castFX.core].concat(castFX.wisps)) if (o.visible) minCard = Math.min(minCard, ndc(o));
                const gp = castFX.group.position, z = -gp.z;
                if (castFX.group.visible) minHand = Math.min(minHand, Math.abs(P[0] * gp.x / z));
            });
            // the frame at p 0.7
            vmAnim.begin(model); vmAnim.end(model, t + A.dur * 0.7);
            __frame();
            const lum = __luma(__crop(cx, cy, cw, ch));
            out[id] = { minCard, minHand, base, lum, delta: Math.abs(lum - base) / Math.max(1, base), glow: A.hex === V23.core.resolve(id).palette.glow.c };
            __vmStep(t + A.dur * 0.7 + 16, t + A.dur + 100);
        }
        // the cue: shown, clear centre, caps, layer
        const el = document.getElementById('ult-cue'), cs = getComputedStyle(el), cross = getComputedStyle(document.getElementById('crosshair'));
        const peak = () => Math.max.apply(null, el.getAnimations().flatMap((a) => a.effect.getKeyframes().map((k) => +k.opacity)));
        V23.fp.ultCue('sage');
        const cue = { on: el.classList.contains('v23-on'), display: cs.display, pointer: cs.pointerEvents, z: +cs.zIndex, crossZ: +cross.zIndex, bg: cs.backgroundImage, peak: peak() };
        game.userSettings.atmosphereMode = 'competitive'; V23.fp.ultCue('omen'); cue.comp = peak();
        game.userSettings.reduceFlashes = true; V23.fp.ultCue('omen'); cue.rfComp = peak(); cue.rfBg = getComputedStyle(el).backgroundImage;
        game.userSettings.atmosphereMode = 'daylight'; V23.fp.ultCue('omen'); cue.rf = peak();
        game.userSettings.reduceFlashes = false;
        out.cue = cue;
        return out;
    }, ultAgents);
    for (const id of ultAgents) {
        const u = ult[id];
        const ok = u.minCard >= 0.28 && u.minHand >= 0.29 && u.delta <= 0.10 && u.glow;
        matrix(id, 'ultimate cue keeps the centre clear', ok, `cards >= ${u.minCard.toFixed(3)} NDC, hands >= ${u.minHand.toFixed(3)}, centre luminance ${(u.delta * 100).toFixed(1)}%`);
        assert.ok(u.minCard >= 0.28, `${id}: no energy card within 0.28 NDC of the centre after p 0.25 (${u.minCard.toFixed(3)})`);
        assert.ok(u.minHand >= 0.29, `${id}: the hands keep off the centre line (${u.minHand.toFixed(3)})`);
        assert.ok(u.delta <= 0.10, `${id}: centre crop luminance at p 0.7 within 10% (${u.base.toFixed(1)} -> ${u.lum.toFixed(1)})`);
        assert.ok(u.glow, `${id}: the release light takes the palette's glow`);
    }
    const cue = ult.cue;
    assert.equal(cue.on, true);
    assert.equal(cue.display, 'block');
    assert.equal(cue.pointer, 'none', 'the cue never takes the pointer');
    assert.ok(cue.z < cue.crossZ, `below the crosshair (${cue.z} < ${cue.crossZ})`);
    assert.match(cue.bg, /(?:transparent|rgba\(0, 0, 0, 0\)) 55%/, 'the centre 55% of the short side stays clear');
    assert.ok(Math.abs(cue.peak - 0.35) < 1e-6 && Math.abs(cue.comp - 0.175) < 1e-6, `opacity 0.35, half in Competitive (${cue.peak}, ${cue.comp})`);
    assert.ok(cue.rf < cue.comp && cue.rfComp <= cue.rf / 2 + 1e-6 && /(?:transparent|rgba\(0, 0, 0, 0\)) 8\d%/.test(cue.rfBg), `Reduce Flashes: thin and dim (${cue.rf}, ${cue.rfComp}, ${cue.rfBg})`);

    // ---- 4b. the first-person draw budget (design 15) -----------------------------------------------------------------
    const budgetAgents = agents.filter((id) => CROP_AGENTS.includes(id));
    const budget = await evaluate((budgetAgents) => {
        const out = {};
        const cc = characterController;
        cc.position.set(0, cc.standHeight, 22); cc.prevSimPosition.copy(cc.position); camera.position.copy(cc.position);
        camera.rotation.set(0, 0, 0, 'YXZ'); if (cc.targetRotation) cc.targetRotation.y = 0;
        updateWeaponPosition();
        const settle = () => { for (let i = 0; i < 80; i++) applyWeaponBobbingBase(performance.now(), false); };
        for (const id of budgetAgents) {
            agentSystem.selectAgent(id);
            const look = V23.core.resolve(id), rows = [];
            let max = -99, at = '';
            const take = (label, r) => { rows.push(label + ' ' + r.d); if (r.d > max) { max = r.d; at = label + ' (' + r.what + ')'; } };
            // a frozen frame as the game makes it: vmAnim.begin, the base placement (hip or ADS, settled), vmAnim.end
            const view = (w, label, fn, ps) => {
                __clearCast(); if (vmAnim.clip) vmAnim.finishClip(game.weapons[game.activeWeapon]);
                switchWeapon(w);
                if (vmAnim.clip) vmAnim.finishClip(game.weapons[w]);   // the draw clip
                game.adsActive = false; game.adsProgress = 0;
                const model = game.weapons[w].model, t = performance.now() + 1000;
                for (const p of ps || [0]) {
                    if (fn) fn(p, t);
                    vmAnim.begin(model); settle(); vmAnim.end(model, t);
                    take(label + (ps ? '@' + p : ''), __budget());
                }
                __clearCast(); if (vmAnim.clip) vmAnim.finishClip(game.weapons[w]);
                game.adsActive = false; game.adsProgress = 0;
                vmAnim.begin(model); settle(); vmAnim.end(model, t + 2000);
            };
            const cast = (kind, slot) => (p, t) => { __clearCast(); castFX.start(kind, AGENT_DEFS[id].themeColor, id + '.' + slot); const a = castFX.active; a.dur = 1e8; a.start = t - p * 1e8; };
            for (const w of ['rifle', 'pistol', 'knife']) view(w, w + '-hip');
            view('pistol', 'pistol-ads', () => { game.adsActive = true; game.adsProgress = 1; });
            view('rifle', 'rifle-inspect', (p, t) => { if (!vmAnim.clip) vmAnim.play('inspect', 2400); const c = vmAnim.clip; c.dur = 1e8; c.start = t - p * 1e8; }, [0.15, 0.3]);
            for (const slot of ['c', 'q', 'e']) view('rifle', 'cast-' + slot + (V23.motion.gesture(look.gestures[slot]).hands > 1 ? '[2h]' : ''), cast('cast', slot), [0.05, 0.3, 0.5, 0.8]);
            view('knife', 'knife-cast-c', cast('cast', 'c'), [0.05, 0.3]);
            view('rifle', 'ult[2h]', cast('ult', 'x'), [0.15, 0.5, 0.8]);
            view('pistol', 'pistol-ult[2h]', cast('ult', 'x'), [0.15, 0.5]);
            view('rifle', 'tap', cast('tap', 'q'), [0.05, 0.3]);
            view('rifle', 'ea-mantle', (p) => { enhancedAnim.set(true); cc.mantleT = p; eaFP.offKind = 'mantle'; eaFP.offW = 1; eaFP.offT = 0.2; }, [0.2, 0.6]);
            cc.mantleT = -1; eaFP.offKind = null; eaFP.offW = 0; enhancedAnim.set(false); castFX.hide();
            out[id] = { max, at, rows, two: V23.fp.state.two, type: look.gloves.type };
        }
        game.adsActive = false; game.adsProgress = 0;
        return out;
    }, budgetAgents);
    for (const id of budgetAgents) {
        const b = budget[id], cap = b.two ? 6 : 3;
        console.log('V23BUDGET ' + JSON.stringify({ agent: id, gloves: b.type + (b.two ? ' (fingerless budget +6)' : ' (gloved budget +3)'), max: b.max, at: b.at, views: b.rows.join(', ') }));
        assert.ok(b.max <= cap, `${id}: first-person draws over V2.2 at most +${cap} (max +${b.max} at ${b.at})`);
    }

    // ---- 5. render crops: 6 agents x every hand tier (+ left-handed), plain, Cinematic and Ultra -------------------------
    const tiers = [['medium', 'simple'], ['cinematic', 'detailed'], ['ultraRealism', 'ultra']];
    const cropAgents = agents.filter((id) => CROP_AGENTS.includes(id));
    for (const [quality, kind] of tiers) {
        // the support hand away across the tier swap (a reload landing on an Auto-quality step)
        await evaluate(() => { switchWeapon('pistol'); V23.fp.offHand(game.weapons.pistol.model, true); });
        await evaluate((q) => { setQualitySettings(q); if (q === 'ultraRealism') ultraPrep.finish(); }, quality);
        await frames(6);
        const r = await evaluate(([cropAgents, kind, shots]) => {
            const out = { kind, live: null, crops: {}, pngs: {}, lefty: {} };
            switchWeapon('pistol');
            const model = game.weapons.pistol.model, hands = model.children.find((c) => c.userData.isHands), arm = model.children.find((c) => c.userData.isAgentArm);
            if (vmAnim.clip) vmAnim.finishClip(game.weapons.pistol);
            vmAnim.begin(model);   // the animator's offsets off while the crops place the gun (vmAnim.end puts them back)
            const g = hands.geometry, half = g.userData.v23Half;
            out.live = { src: g.userData.v23Kind || null, grouped: !!g.userData.v23Src, offHidden: g.drawRange.start === 0 && g.drawRange.count === half, armHalf: arm.children[0].geometry.userData.v23Side === 'R' && arm.children[1].geometry.userData.v23Side === 'R' };
            V23.fp.offHand(model, false);
            out.shown = [g.drawRange.start, g.drawRange.count, arm.children[0].geometry.userData.v23Side || null];
            const W = renderer.getContext().drawingBufferWidth, H = renderer.getContext().drawingBufferHeight;
            // the game's own placement for the handedness (applyWeaponBobbingBase, settled), then the pistol raised into
            // view so its hands, wrists and sleeves show (the hip view keeps them below the frame): y, z and pitch only
            const place = (left) => {
                game.userSettings.leftHanded = !!left;
                for (let i = 0; i < 80; i++) applyWeaponBobbingBase(performance.now(), false);
                model.position.y += 0.26; model.position.z += 0.03;
                model.rotation.set(0.25, 0, 0);
                updateWeaponPosition();
                weaponGroup.rotation.set(camera.rotation.x, camera.rotation.y, 0, 'YXZ');
                weaponGroup.updateMatrixWorld(true);
                syncViewmodelCamera(); viewmodelCamera.updateMatrixWorld(true);
            };
            // the crop: the hands' and the arm's boxes, the corners in front of the camera (the sleeves run past it)
            const cropOf = () => {
                const box = new THREE.Box3().setFromObject(hands).union(new THREE.Box3().setFromObject(arm));
                const pts = [], vv = new THREE.Vector3();
                for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
                    vv.set(x, y, z).applyMatrix4(viewmodelCamera.matrixWorldInverse);
                    if (vv.z < -0.02) pts.push(vv.clone().applyMatrix4(viewmodelCamera.projectionMatrix));
                }
                let x0 = 1, x1 = -1, y0 = 1, y1 = -1;
                for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
                const px = (v) => Math.round((v + 1) / 2 * W), py = (v) => Math.round((v + 1) / 2 * H);
                const a = Math.max(0, px(x0)), b = Math.min(W, px(x1)), c = Math.max(0, py(y0)), d = Math.min(H, py(y1));
                return [a, c, Math.max(8, b - a), Math.max(8, d - c)];
            };
            const shot = (label, left) => {
                place(left);
                const rc = cropOf();
                // the arm follows the gun across (its place in the camera's view has the model's x sign) and is never
                // mirrored (a proper world matrix)
                const armView = new THREE.Vector3().setFromMatrixPosition(arm.matrixWorld).applyMatrix4(viewmodelCamera.matrixWorldInverse);
                const handsNdc = new THREE.Box3().setFromObject(hands).getCenter(new THREE.Vector3()).project(viewmodelCamera);
                out.lefty[label] = { modelX: model.position.x, armX: armView.x, det: arm.matrixWorld.determinant(), sleeveDet: arm.children[0].matrixWorld.determinant(), handsX: handsNdc.x };
                __frame();
                const px = __crop(rc[0], rc[1], rc[2], rc[3]);
                let h = 2166136261;
                for (let i = 0; i < px.length; i += 16) { h ^= px[i] ^ (px[i + 1] << 8) ^ (px[i + 2] << 16); h = Math.imul(h, 16777619) >>> 0; }
                out.crops[label] = { hash: h, luma: __luma(px), w: rc[2], h: rc[3] };
                if (shots) out.pngs[label] = __png(px, rc[2], rc[3]);
                game.userSettings.leftHanded = false;
            };
            for (const id of cropAgents) {
                agentSystem.selectAgent(id);
                shot(id, false);
                shot(id + '-left', true);
            }
            __identity(false);
            shot('off', false);
            out.offState = { mat: hands.material.color.getHexString(), grouped: !!hands.geometry.userData.v23Src };
            __identity(true);
            for (let i = 0; i < 80; i++) applyWeaponBobbingBase(performance.now(), false);
            model.rotation.set(0, 0, 0);
            vmAnim.end(model, performance.now());
            return out;
        }, [cropAgents, kind, !!SHOTS]);
        assert.equal(r.live.src, kind, `${quality}: the hands draw the grouped ${kind} variant`);
        assert.ok(r.live.offHidden && r.live.armHalf, `${quality}: the off hand and its forearm stay away across the tier swap (drawRange and arm half reapplied)`);
        assert.deepEqual(r.shown, [0, Infinity, null], `${quality}: offHand(false) draws both hands and the whole arm pair again`);
        assert.equal(r.offState.grouped, false, `${quality}: identity off draws V2.2's own hands geometry`);
        const off = r.crops.off;
        for (const id of cropAgents) {
            const R = r.lefty[id], L = r.lefty[id + '-left'];
            assert.ok(R.modelX > 0 && L.modelX < 0 && Math.abs(L.modelX + R.modelX) < 1e-3, `${quality} ${id}: the game's left-handed placement mirrors the gun's x (${R.modelX.toFixed(3)}, ${L.modelX.toFixed(3)})`);
            assert.ok(R.armX > 0 && L.armX < 0, `${quality} ${id}: the arm follows the gun across (${R.armX.toFixed(3)}, ${L.armX.toFixed(3)})`);
            for (const [lab, s] of [['right', R], ['left', L]]) assert.ok(s.det > 0 && s.sleeveDet > 0, `${quality} ${id} ${lab}-handed: the arm is not mirrored (det ${s.det.toFixed(4)})`);
            assert.ok(R.handsX > 0 && L.handsX < 0 && Math.abs(R.handsX + L.handsX) < 0.05, `${quality} ${id}: the hands sit on the mirrored sides of the screen (NDC x ${R.handsX.toFixed(3)}, ${L.handsX.toFixed(3)})`);
            for (const label of [id, id + '-left']) {
                const c = r.crops[label];
                assert.ok(c.w >= 8 && c.h >= 8, `${quality} ${label}: a crop`);
                assert.notEqual(c.hash, off.hash, `${quality} ${label}: the agent's hands and arms differ from the identity-off picture`);
                if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `crop-${kind}-${label}.png`), Buffer.from(r.pngs[label].split(',')[1], 'base64')); }
            }
        }
        if (SHOTS) fs.writeFileSync(path.join(SHOTS, `crop-${kind}-off.png`), Buffer.from(r.pngs.off.split(',')[1], 'base64'));
        if (cropAgents.includes('sage') && cropAgents.includes('omen')) assert.notEqual(r.crops.sage.hash, r.crops.omen.hash, `${quality}: Sage and Omen look different`);
        const [programs, watermark, stalls] = await programState(page);
        assert.equal(programs, watermark, `${quality}: programs == watermark`);
        assert.equal(stalls, 0, `${quality}: no stalls`);
    }
    await evaluate(() => setQualitySettings('medium'));
    await frames(4);

    // ---- 6. identity off: the V2.2 hands, no arms, V2.2's castFX and pose ---------------------------------------------------
    const off = await evaluate(() => {
        __identity(false);
        agentSystem.selectAgent('sage');
        const st = V23.fp.state, out = { applied: st.applied, models: [] };
        for (const m of st.models) {
            const model = game.weapons[m.slot].model, hands = model.children[m.handsIndex];
            out.models.push({ slot: m.slot, skin: hands.material.color.getHexString(), single: !Array.isArray(hands.material), v22Geom: !hands.geometry.userData.v23Src, armHidden: !m.arm || !m.arm.visible });
        }
        const lin = __lin(0xffdbac);
        out.skin = lin.getHexString();
        out.castHand = castFX.hand.material === game.weapons.rifle.model.children.find((c) => c.userData.isHands).material && !castFX.hand.geometry.userData.v23Half;
        out.castSleeve = !Array.isArray(castFX.sleeve.material) && castFX.sleeve.position.length() === 0 && castFX.sleeve.quaternion.w === 1 && castFX.sleeve.scale.x === 1;
        out.extrasHidden = !st.hand2.visible && !st.warmSet.visible;
        castFX.start('cast', '#38f6ff', 'sage.c');
        out.pose = V23.fp.pose(castFX, 'cast', 0.3, performance.now(), null);
        out.cur = st.cur;
        __clearCast();
        __identity(true);
        out.back = st.applied;
        return out;
    });
    assert.equal(off.applied, false);
    for (const m of off.models) assert.deepEqual([m.skin, m.single, m.v22Geom, m.armHidden], [off.skin, true, true, true], `${m.slot}: 0xffdbac V2.2 hands, no arms`);
    assert.ok(off.castHand && off.castSleeve && off.extrasHidden, 'castFX is V2.2\'s (hand, sleeve, no hand2)');
    assert.equal(off.pose, null, 'V2.2\'s cast pose runs');
    assert.equal(off.cur, null, 'no V2.3 gesture');
    assert.equal(off.back, true, 'identity on again');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiled after the warm-up');
    assert.equal(stalls, 0, 'no first-use stalls');
    assert.deepEqual(errors, []);
});

test('Agent Identity off from boot: nothing built, the off-hand drawRange follows every hands swap', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', viewport: { width: 480, height: 270 }, initArg: SETTINGS_KEY, initScript: (key) => {
        try { const o = JSON.parse(localStorage.getItem(key) || '{}'); o.agentIdentity = 'off'; localStorage.setItem(key, JSON.stringify(o)); } catch (e) {}
    } });
    await frames(4);
    const r = await evaluate(() => {
        Element.prototype.requestPointerLock = function () {};
        document.exitPointerLock = function () {};
        const out = { identity: game.userSettings.agentIdentity, enabled: V23.core.enabled(), built: V23.fp.state.built };
        const m = game.weapons.pistol.model, h = m.children.find((c) => c.userData.isHands);
        const dr = (g) => [g.drawRange.start, g.drawRange.count];
        const n = (g) => (g.index ? g.index.count : g.attributes.position.count);
        out.skin = h.material.color.getHexString() === new THREE.Color(0xffdbac).convertSRGBToLinear().getHexString();
        out.arms = m.children.some((c) => c.userData.isAgentArm);
        const g0 = h.geometry, wasHd = characterDetail.enabled;
        out.api = V23.fp.offHand(m, true);
        out.g0 = [dr(g0), n(g0)];
        characterDetail.set(!wasHd);   // a tier swap while the support hand is away (a reload on an Auto-quality step)
        const g1 = h.geometry;
        out.swapped = g1 !== g0;
        out.g1 = [dr(g1), n(g1)];
        out.g0After = dr(g0);
        V23.fp.offHand(m, false);   // the reload ends
        out.g1Shown = dr(g1);
        V23.fp.offHand(m, true);    // another reload, and the tier goes back during it
        characterDetail.set(wasHd);
        out.back = h.geometry === g0;
        out.g0Back = dr(g0); out.g1Back = dr(g1);
        V23.fp.offHand(m, false);
        out.final = [dr(g0), dr(g1)];
        out.builtAfter = V23.fp.state.built;
        return out;
    });
    assert.deepEqual([r.identity, r.enabled, r.built, r.skin, r.arms], ['off', false, false, true, false], 'identity off from boot: V2.2 hands, nothing built');
    assert.equal(r.api, true);
    assert.deepEqual(r.g0[0], [0, r.g0[1] / 2], 'the left hand away on the V2.2 geometry');
    assert.equal(r.swapped, true, 'the tier swap changed the hands geometry');
    assert.deepEqual(r.g1[0], [0, r.g1[1] / 2], 'the new geometry takes the off-hand state');
    assert.deepEqual(r.g0After, [0, Infinity], 'the geometry left behind draws whole again');
    assert.deepEqual(r.g1Shown, [0, Infinity], 'offHand(false) on the new geometry');
    assert.equal(r.back, true);
    assert.deepEqual([r.g0Back, r.g1Back], [[0, r.g0[1] / 2], [0, Infinity]], 'the swap back carries the state again');
    assert.deepEqual(r.final, [[0, Infinity], [0, Infinity]], 'both hands on both geometries at the end');
    assert.equal(r.builtAfter, false, 'still nothing built');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark);
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});

test('without WebGL2 (Ultra unsupported): the first-person set is built and applied before play, the first cast builds nothing', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium', viewport: { width: 480, height: 270 }, initScript: () => {
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, attrs) { if (type === 'webgl2') return null; return orig.call(this, type, attrs); };
    } });
    const r = await evaluate(() => {
        Element.prototype.requestPointerLock = function () {};
        document.exitPointerLock = function () {};
        window.updateEnemies = () => {};
        try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {}
        const st = V23.fp.state, hands = game.weapons.rifle.model.children.find((c) => c.userData.isHands);
        const out = { webgl2: renderer.capabilities.isWebGL2, ultra: ultraRealism.isSupported(), enabled: V23.core.enabled(), built: st.built, applied: st.applied, builds: st.builds,
            grouped: !!hands.geometry.userData.v23Src, arm: game.weapons.rifle.model.children.some((c) => c.userData.isAgentArm && c.visible), buildMs: st.buildMs };
        game.userSettings.infiniteAbilities = true;
        const t0 = performance.now();
        agentSystem.castAbility('c');
        out.castMs = performance.now() - t0;
        out.buildsAfterCast = st.builds;
        out.gesture = st.cur ? st.cur.name : null;
        return out;
    });
    console.log('V23WEBGL1 ' + JSON.stringify(r));
    assert.deepEqual([r.webgl2, r.ultra, r.enabled], [false, false, true], 'WebGL1, Ultra unsupported, identity on');
    assert.deepEqual([r.built, r.applied, r.builds, r.grouped, r.arm], [true, true, 1, true, true], 'built and applied at boot: grouped hands and the arms');
    assert.equal(r.buildsAfterCast, 1, 'the first cast builds nothing');
    assert.ok(r.gesture, 'the cast plays its gesture');
    await frames(4);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark);
    assert.equal(stalls, 0);
    assert.deepEqual(errors, []);
});
