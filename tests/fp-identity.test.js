'use strict';
// V2.3 first-person identity (WP4; design 7 and 17.1). One boot, Agent Identity set on explicitly (the boots with
// identity off from the start and without WebGL2 are fp-identity-off.test.js and fp-identity-webgl1.test.js):
//  - for every agent (AGENT_ORDER; ROLE=<role> filters): each gun model's arm Group sits right after its hands with the
//    agent's V23.parts.fpArms pair, each forearm's wrist on its hand's wrist (within 1 mm), the sleeve and detail
//    materials take the palette slots the pair names, the look's fp fields (sleeve, cuff, wrist, overlay) show, the
//    wrist module stands out of the forearm at the wrist, and the glove and tip materials match the palette (the tips
//    are skin for fingerless gloves); castFX's hand takes the gloves on a pose geometry whose skin draw also holds the
//    bare forearm, its sleeve the agent's LEFT forearm (the cast hand is the left hand) carried from the left-wrist
//    frame, hand2 the right forearm through the mirrored frame, each forearm's runs in their palette slots; right- and
//    left-handed (the sides trade), every forearm unmirrored in the end (world determinant x bake determinant > 0) with
//    its wrist on its hand's wrist; V23MATRIX rows for the sleeve, glove and tips, and wrist columns;
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
//    ultimate, taps and Enhanced Animations' off hand, at the hip and aiming down sights (pistol and rifle, Enhanced
//    Animations off and on): the identity's draws over the V2.2 objects they stand for (the gun hands, the cast hand
//    and sleeve, each counted where V2.2's own geometry would be drawn at the same place), at most +6 fingerless and +3
//    gloved, and at mid gesture (casts at p 0.3, ultimates at p 0.5; where V2.2's own gesture has its cast hand and
//    sleeve in view) the whole viewmodel pass with identity on minus off in the same frozen frame (renderer.info) within
//    the same caps (V23BUDGET lines carry the numbers); two-hand
//    gestures keep the look's glow slot on the wrist module (both wrists for fingerless agents, the cast hand's for
//    gloved ones);
//  - render crops for Sage, Omen and 4 others in every hand tier (the session's simple hands, High Detail, Ultra) and in
//    left-handed mode (the game's own placement: the arms follow the gun across and are never mirrored), through the
//    plain, Cinematic and Ultra pipelines, with the off hand kept away across each tier swap, programs == watermark and
//    no stalls;
//  - identity off: the V2.2 hands (0xffdbac), no arms, V2.2's castFX and pose;
//  - a look redefined at runtime: the old forearm halves and cast set are disposed and the new pair is drawn.
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
    // the viewmodel pass's draws, counted per object (onBeforeRender runs once per drawn group; a group outside the
    // geometry's drawRange is not a draw): the identity's own draws over the V2.2 objects they stand for. Each gun hands
    // mesh, the cast hand and the cast sleeve stand for V2.2's own, which count 1 where V2.2's geometry (the tier's hands,
    // castFX's V2.2 hand and sleeve) would be drawn at the same place (three's sphere test); the arms, hand2, its forearm
    // and the warm set are new; the energy cards and the guns are V2.2's in both (not counted)
    window.__budget = () => {
        const counts = new Map(), saved = [];
        const hook = function (r, sc, cam, geometry, material, group) {
            if (group && (group.start >= geometry.drawRange.start + geometry.drawRange.count || group.start + group.count <= geometry.drawRange.start)) return;
            counts.set(this, (counts.get(this) || 0) + 1);
        };
        viewmodelScene.traverse((o) => { if (o.isMesh) { saved.push([o, Object.prototype.hasOwnProperty.call(o, 'onBeforeRender') ? o.onBeforeRender : undefined]); o.onBeforeRender = hook; } });
        syncViewmodelCamera(); viewmodelScene.environment = scene.environment; renderer.setRenderTarget(null);
        try { renderer.render(viewmodelScene, viewmodelCamera); }
        finally { for (const [o, f] of saved) { if (f === undefined) delete o.onBeforeRender; else o.onBeforeRender = f; } }
        const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(viewmodelCamera.projectionMatrix, viewmodelCamera.matrixWorldInverse));
        const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
        const v22In = (mesh, g) => { if (!shown(mesh)) return 0; if (!g.boundingSphere) g.computeBoundingSphere(); return fr.intersectsSphere(g.boundingSphere.clone().applyMatrix4(mesh.matrixWorld)) ? 1 : 0; };
        const st = V23.fp.state, mine = new Set([st.hand2, st.hand2Fore]);
        if (st.warmSet) st.warmSet.traverse((o) => mine.add(o));
        let d = 0;
        const what = [];
        const add = (label, o, base) => { const c = counts.get(o) || 0; d += c - base; if (c || base) what.push(label + 'x' + c + (base ? '-' + base : '')); };
        for (const m of st.models) {
            const model = game.weapons[m.slot].model, hands = model.children[m.handsIndex];
            add('hands', hands, v22In(hands, m.v22));
            if (m.arm) for (const c of m.arm.children) add('arm', c, 0);
        }
        add('castHand', castFX.hand, v22In(castFX.hand, st.v22.hand));
        add('castFore', castFX.sleeve, v22In(castFX.sleeve, st.v22.sleeve));
        add('hand2', st.hand2, 0); add('hand2Fore', st.hand2Fore, 0);
        if (st.warmSet) st.warmSet.traverse((o) => { if (o.isMesh) add('warm', o, 0); });
        return { d, what: what.sort().join(' ') };
    };
    // the whole viewmodel pass, identity on minus off, in the same frozen frame (renderer.info); pose() places the frame.
    // v22Up: the identity-off frame drew V2.2's cast hand and its sleeve (V2.2's own gesture has the hand up there; where
    // it holds them under the frame, e.g. Enhanced Animations' place, the difference measures the two gestures' paths)
    window.__calls = (seen) => {
        syncViewmodelCamera(); viewmodelScene.environment = scene.environment; renderer.setRenderTarget(null);
        const hook = function () { seen.add(this); };
        for (const o of [castFX.hand, castFX.sleeve]) o.onBeforeRender = hook;
        try { renderer.info.reset(); renderer.render(viewmodelScene, viewmodelCamera); }
        finally { for (const o of [castFX.hand, castFX.sleeve]) delete o.onBeforeRender; }
        return renderer.info.render.calls;
    };
    window.__onOff = (pose) => {
        const seen = new Set();
        pose(); const on = __calls(new Set());
        __identity(false); pose(); const off = __calls(seen);
        __identity(true); pose();
        return { d: on - off, v22Up: seen.has(castFX.hand) && seen.has(castFX.sleeve) };
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
                // each forearm's wrist (fpArms hand space (+-0.08, -0.09, 0)) on its hand's wrist bottom (the hands
                // geometry's (+-0.08, -0.09, handZ)), in the model's space, within 1 mm
                const hm = game.weapons[m.slot].model.children[m.handsIndex], hz = hm.userData.handZ;
                arm.updateMatrix(); hm.updateMatrix();
                for (const sx of [1, -1]) {
                    const wa = new THREE.Vector3(0.08 * sx, -0.09, 0).applyMatrix4(arm.matrix), wh = new THREE.Vector3(0.08 * sx, -0.09, hz).applyMatrix4(hm.matrix);
                    if (wa.distanceTo(wh) > 1e-3) probs.push(m.slot + ': the ' + (sx > 0 ? 'right' : 'left') + ' forearm\'s wrist is ' + (wa.distanceTo(wh) * 1000).toFixed(1) + ' mm off its hand\'s');
                }
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
            // castFX: the hand draws a pose geometry of the cast set with the glove materials (the skin draw holds the tips
            // and the bare forearm), its sleeve the agent's LEFT forearm (the cast hand is the left hand; all of that
            // side's sleeve and detail triangles, the bare skin in the hand's skin run) carried from the left-wrist frame
            // (the left wrist under the palm, the left hand's thumb toward +x, a proper rotation); hand2 the RIGHT forearm
            // through the mirrored frame (hand2 is itself a mirror image, so it ends up unmirrored); each forearm run takes
            // its palette slot. __castFrames checks the frames right- and left-handed (below)
            const fx = castFX, A = V23.fp._arm(id), fore = fx.sleeve.geometry, h2f = st.hand2Fore, pg = st.cast.pg;
            const thumbL = new THREE.Vector3().crossVectors(a, new THREE.Vector3(-1, 0, 0)).normalize().negate();
            const bakeL = fore.userData.v23Bake || new THREE.Matrix4();
            const wL = new THREE.Vector3(-0.08, -0.09, 0).applyMatrix4(bakeL), thumb = thumbL.clone().transformDirection(bakeL);
            const sl = res.slots.sleeve, dsl = res.slots.detail;
            const runSlot = [sl[0], dsl[0], 'glow'];
            let runsOk = fx.sleeve.material === st.castArr;
            for (const gr of fore.groups) if (!__same(st.castArr[gr.materialIndex].color, slotHex(runSlot[gr.materialIndex]))) runsOk = false;
            const skinRun = A.fskin.L.length, tris = A.half.L.sleeve.index.count + A.half.L.detail.index.count;
            const handOk = fx.hand.material === st.handArr && fx.hand.geometry === pg.L.open && st.hand2.geometry === pg.R.open
                && __same(st.handArr[0].color, gloveHex) && __same(st.handArr[1].color, P.skin.c);
            const castOk = handOk && fore === A.cf.L && fore.userData.v23Side === 'L' && fore.index.count + skinRun === tris && fore.index.count > 0
                && near(wL, 0, -0.036, 0) && thumb.x > 0.99 && bakeL.determinant() > 0 && runsOk
                && h2f.parent === st.hand2 && h2f.geometry === A.cf.R && A.cf.R.userData.v23Bake.determinant() < 0;
            if (!castOk) probs.push('castFX hand or forearms (hand ' + handOk + ', wrist ' + wL.toArray().map((x) => x.toFixed(3)) + ', thumb ' + thumb.x.toFixed(3) + ', runs ' + runsOk + ', triangles ' + (fore.index.count + skinRun) + '/' + tris + ')');
            // the bare forearm's skin is in the hand's skin run: Sage's rolled sleeve shows skin at the wrist
            if (sl[1] === 'skin') {
                const u = pg.L.open.userData, o = st.cast.gc + st.cast.tc, slot = Array.from(pg.L.open.index.array.subarray(o, o + skinRun));
                const inSkin = st.two ? u.two[1].count === st.cast.tc + skinRun : u.gl2[1].count === skinRun;
                if (!(skinRun > 0 && inSkin && slot.join() === Array.from(A.fskin.L).join())) probs.push('the bare forearm is not in the cast hand\'s skin draw');
            }
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
            const A = V23.fp._arm('omen'), cuff = (g) => { const gr = g.userData.lv[0].find((x) => x.materialIndex === 1); return gr ? gr.count : 0; };
            return { L: cuff(A.cf.L), R: cuff(A.cf.R) };
        });
        assert.ok(plates.L > plates.R, `Omen's plate overlay is on the left forearm, the cast hand's (${plates.L} vs ${plates.R} cuff indices)`);
    }

    // ---- 1b. the cast forearms' frames, right- and left-handed: a two-hand gesture (the slot whose gesture uses two hands,
    // else the ultimate) at p 0.3; the cast hand carries the left forearm and hand2 the right one, traded in left-handed
    // mode (castFX.group mirrored); each forearm is unmirrored in the end (its world determinant times its bake's > 0) and
    // its wrist meets its hand's wrist (the cast-hand wrist (0, -0.036, 0)) in castFX.group's space within 1 mm ----------
    const frameAgents = agents.filter((id) => CROP_AGENTS.includes(id));
    const castFrames = await evaluate((ids) => {
        const out = {}, st = V23.fp.state;
        for (const id of ids) for (const lefty of [false, true]) {
            agentSystem.selectAgent(id);
            switchWeapon('rifle');
            if (vmAnim.clip) vmAnim.finishClip(game.weapons.rifle);
            game.userSettings.leftHanded = lefty;
            const look = V23.core.resolve(id), model = game.weapons.rifle.model, t = performance.now() + 1000;
            const slot = ['c', 'q', 'e'].find((s) => V23.motion.gesture(look.gestures[s]).hands > 1) || 'x';
            __clearCast();
            castFX.start(slot === 'x' ? 'ult' : 'cast', AGENT_DEFS[id].themeColor, id + '.' + slot);
            const a = castFX.active; a.dur = 1e8; a.start = t - 0.3 * 1e8;
            vmAnim.begin(model); vmAnim.end(model, t);
            castFX.group.updateMatrixWorld(true);
            const gi = castFX.group.matrixWorld.clone().invert(), res = { slot };
            for (const [label, hand, fore] of [['cast', castFX.hand, castFX.sleeve], ['hand2', st.hand2, st.hand2Fore]]) {
                const g = fore.geometry, bake = g.userData.v23Bake, side = g.userData.v23Side;
                const wF = new THREE.Vector3(side === 'L' ? -0.08 : 0.08, -0.09, 0).applyMatrix4(bake).applyMatrix4(fore.matrixWorld).applyMatrix4(gi);
                const wH = new THREE.Vector3(0, -0.036, 0).applyMatrix4(hand.matrixWorld).applyMatrix4(gi);
                res[label] = { side, poseSide: hand.geometry.userData.v23Side, det: fore.matrixWorld.determinant() * bake.determinant(), wrist: wF.distanceTo(wH), shown: hand.visible };
            }
            out[id + (lefty ? '-left' : '')] = res;
            __clearCast();
            game.userSettings.leftHanded = false;
            vmAnim.begin(model); vmAnim.end(model, t + 2000);
        }
        return out;
    }, frameAgents);
    for (const [k, r] of Object.entries(castFrames)) {
        const left = k.endsWith('-left');
        assert.deepEqual([r.cast.side, r.cast.poseSide, r.hand2.side, r.hand2.poseSide], left ? ['R', 'R', 'L', 'L'] : ['L', 'L', 'R', 'R'], `${k} (${r.slot}): the cast hand carries the ${left ? 'right' : 'left'} forearm, hand2 the other`);
        assert.equal(r.hand2.shown, true, `${k} (${r.slot}): hand2 shown`);
        for (const h of ['cast', 'hand2']) {
            assert.ok(r[h].det > 0, `${k} ${h}: the forearm is not mirrored in the end (det ${r[h].det.toFixed(4)})`);
            assert.ok(r[h].wrist < 1e-3, `${k} ${h}: the forearm's wrist meets the hand's (${(r[h].wrist * 1000).toFixed(2)} mm)`);
        }
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
        out.mid = { slot, hand2: st.hand2.visible, pose: st.pose[0] };
        // the clock jumps past the clip (a pause or a long stall): castFX.apply ends it without a last pose
        vmAnim.begin(model); vmAnim.end(model, t + 5000);
        out.afterJump = { active: !!castFX.active, hand2: st.hand2.visible };
        // Enhanced Animations' off hand takes castFX.group for a mantle
        characterController.mantleT = 0.4;
        for (let x = t + 5016; x <= t + 5400; x += 16) { vmAnim.begin(model); vmAnim.end(model, x); }
        __frame();
        out.mantle = { offKind: eaFP.offKind, group: castFX.group.visible, hand2: st.hand2.visible, pose: castFX.hand.geometry === st.cast.pg.L.open, fore: castFX.sleeve.geometry.userData.v23Side, level: st.levels[0] };
        characterController.mantleT = -1;
        for (let x = t + 5416; x <= t + 6400; x += 16) { vmAnim.begin(model); vmAnim.end(model, x); }
        enhancedAnim.set(false);
        __clearCast();
        return out;
    });
    assert.equal(cut.mid.hand2, true, `a two-hand gesture (${cut.mid.slot}) shows hand2`);
    assert.deepEqual(cut.afterJump, { active: false, hand2: false }, 'the clip cut off by the jump: hand2 is no longer shown (no render needed)');
    assert.deepEqual(cut.mantle, { offKind: 'mantle', group: true, hand2: false, pose: true, fore: 'L', level: 0 }, 'after the cut: hand2 hidden, the open hand with its forearm, every run drawn');

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
        const st = V23.fp.state;
        for (const id of budgetAgents) {
            agentSystem.selectAgent(id);
            const look = V23.core.resolve(id), rows = [], onOff = [], glow = [];
            const P = look.palette, lin = __lin(P.glow ? P.glow.c : 0);
            let max = -99, at = '', maxOO = -99, atOO = '';
            const take = (label, r) => { rows.push(label + ' ' + r.d); if (r.d > max) { max = r.d; at = label + ' (' + r.what + ')'; } };
            // the wrist modules' glow in a two-hand view: does each forearm draw a group in the glow material?
            const glowOn = (fore) => fore.geometry.groups.some((g) => { const m = st.castArr[g.materialIndex]; return Math.abs(m.color.r - lin.r) < 1e-4 && Math.abs(m.color.g - lin.g) < 1e-4 && Math.abs(m.color.b - lin.b) < 1e-4 && g.count > 0; });
            // a frozen frame as the game makes it: vmAnim.begin, the base placement (hip or ADS, settled), vmAnim.end
            const view = (w, label, fn, ps, opt) => {
                const o = opt || {};
                __clearCast(); if (vmAnim.clip) vmAnim.finishClip(game.weapons[game.activeWeapon]);
                enhancedAnim.set(!!o.ea);
                switchWeapon(w);
                if (vmAnim.clip) vmAnim.finishClip(game.weapons[w]);   // the draw clip
                game.adsActive = !!o.ads; game.adsProgress = o.ads ? 1 : 0;
                const model = game.weapons[w].model, t = performance.now() + 1000;
                const pose = () => { vmAnim.begin(model); settle(); vmAnim.end(model, t); };
                for (const p of ps || [0]) {
                    if (fn) fn(p, t);
                    pose();
                    const lab = label + (ps ? '@' + p : '');
                    take(lab, __budget());
                    if (o.glow && st.hand2.visible && P.glow) glow.push([lab, glowOn(castFX.sleeve), glowOn(st.hand2Fore)]);
                    // at mid gesture: the whole viewmodel pass, identity on minus off, the same frozen frame
                    if (o.mid !== undefined && Math.abs(p - o.mid) < 1e-9) {
                        const oo = __onOff(pose);
                        onOff.push(lab + ' ' + oo.d + (oo.v22Up ? '' : ' (V2.2 hand or sleeve out of view)'));
                        if (oo.v22Up && oo.d > maxOO) { maxOO = oo.d; atOO = lab; }
                    }
                }
                __clearCast(); if (vmAnim.clip) vmAnim.finishClip(game.weapons[w]);
                game.adsActive = false; game.adsProgress = 0;
                vmAnim.begin(model); settle(); vmAnim.end(model, t + 2000);
                enhancedAnim.set(false);
            };
            const cast = (kind, slot) => (p, t) => { __clearCast(); castFX.start(kind, AGENT_DEFS[id].themeColor, id + '.' + slot); const a = castFX.active; a.dur = 1e8; a.start = t - p * 1e8; };
            const two = (slot) => V23.motion.gesture(look.gestures[slot]).hands > 1;
            const tag = (slot) => slot + (two(slot) ? '[2h]' : '');
            for (const w of ['rifle', 'pistol', 'knife']) view(w, w + '-hip');
            view('pistol', 'pistol-ads', null, null, { ads: true });
            view('rifle', 'rifle-ads', null, null, { ads: true });
            view('rifle', 'rifle-inspect', (p, t) => { if (!vmAnim.clip) vmAnim.play('inspect', 2400); const c = vmAnim.clip; c.dur = 1e8; c.start = t - p * 1e8; }, [0.15, 0.3]);
            for (const slot of ['c', 'q', 'e']) view('rifle', 'cast-' + tag(slot), cast('cast', slot), [0.05, 0.3, 0.5, 0.8], { mid: 0.3, glow: true });
            view('knife', 'knife-cast-c', cast('cast', 'c'), [0.05, 0.3]);
            view('rifle', 'ult[2h]', cast('ult', 'x'), [0.15, 0.5, 0.8], { mid: 0.5, glow: true });
            view('pistol', 'pistol-ult[2h]', cast('ult', 'x'), [0.15, 0.5], { mid: 0.5, glow: true });
            view('rifle', 'tap', cast('tap', 'q'), [0.05, 0.3], { mid: 0.3 });
            // aiming down sights while casting (casting never ends ADS): a one-hand cast, a two-hand one and the ultimate,
            // pistol and rifle, Enhanced Animations off and on
            const oneSlot = ['c', 'q', 'e'].find((sl) => !two(sl)), twoSlot = ['c', 'q', 'e'].find((sl) => two(sl));
            for (const ea of [false, true]) for (const w of ['pistol', 'rifle']) {
                const pre = (ea ? 'ea-' : '') + w + '-ads';
                if (oneSlot) view(w, pre + '-cast-' + oneSlot, cast('cast', oneSlot), [0.05, 0.3, 0.5], { ads: true, ea, mid: 0.3 });
                if (twoSlot) view(w, pre + '-cast-' + twoSlot + '[2h]', cast('cast', twoSlot), [0.05, 0.3, 0.5], { ads: true, ea, mid: 0.3, glow: true });
                view(w, pre + '-ult[2h]', cast('ult', 'x'), [0.15, 0.5, 0.8], { ads: true, ea, mid: 0.5, glow: true });
            }
            view('rifle', 'ea-mantle', (p) => { enhancedAnim.set(true); cc.mantleT = p; eaFP.offKind = 'mantle'; eaFP.offW = 1; eaFP.offT = 0.2; }, [0.2, 0.6], { ea: true });
            cc.mantleT = -1; eaFP.offKind = null; eaFP.offW = 0; enhancedAnim.set(false); castFX.hide();
            out[id] = { max, at, rows, maxOO, atOO, onOff, glow, two: st.two, type: look.gloves.type, glowRun: !!P.glow && V23.fp._arm(id).cf.L.userData.lv[0].some((g) => g.materialIndex === 2) };
        }
        game.adsActive = false; game.adsProgress = 0;
        return out;
    }, budgetAgents);
    for (const id of budgetAgents) {
        const b = budget[id], cap = b.two ? 6 : 3;
        console.log('V23BUDGET ' + JSON.stringify({ agent: id, gloves: b.type + (b.two ? ' (fingerless budget +6)' : ' (gloved budget +3)'), max: b.max, at: b.at, onOffMax: b.maxOO, onOffAt: b.atOO, views: b.rows.join(', '), onOff: b.onOff.join(', ') }));
        assert.ok(b.max <= cap, `${id}: first-person draws over V2.2's at most +${cap} (max +${b.max} at ${b.at})`);
        assert.ok(b.maxOO <= cap, `${id}: identity on minus off at mid gesture (V2.2's hand up) at most +${cap} (max +${b.maxOO} at ${b.atOO})`);
        assert.ok(b.onOff.filter((r) => !/out of view/.test(r)).length >= 8, `${id}: on minus off compared in enough views (${b.onOff.join(', ')})`);
        // two-hand gestures keep the look's glow slot on the wrist module: both wrists for a fingerless agent (+6 holds
        // both hands' every run), the cast hand's for a gloved one
        if (b.glowRun) {
            assert.ok(b.glow.length > 0, `${id}: two-hand views seen`);
            for (const [lab, castGlow, h2Glow] of b.glow) {
                assert.ok(castGlow, `${id} ${lab}: the cast hand's wrist keeps its glow`);
                if (b.two) assert.ok(h2Glow, `${id} ${lab}: hand2's wrist keeps its glow`);
            }
        }
    }
    if (budget.sage) assert.ok(budget.sage.glowRun && budget.sage.glow.length >= 10, `Sage's jade ampoules checked in her two-hand views (${budget.sage.glow.length})`);

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
                // each forearm's wrist on its hand's wrist bottom, in world space (the arm at the hands' depth)
                let wrist = 0;
                for (const sx of [1, -1]) wrist = Math.max(wrist, new THREE.Vector3(0.08 * sx, -0.09, 0).applyMatrix4(arm.matrixWorld).distanceTo(new THREE.Vector3(0.08 * sx, -0.09, hands.userData.handZ).applyMatrix4(hands.matrixWorld)));
                out.lefty[label] = { modelX: model.position.x, armX: armView.x, det: arm.matrixWorld.determinant(), sleeveDet: arm.children[0].matrixWorld.determinant(), handsX: handsNdc.x, wrist };
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
            for (const [lab, s] of [['right', R], ['left', L]]) {
                assert.ok(s.det > 0 && s.sleeveDet > 0, `${quality} ${id} ${lab}-handed: the arm is not mirrored (det ${s.det.toFixed(4)})`);
                assert.ok(s.wrist < 1e-3, `${quality} ${id} ${lab}-handed: the forearms' wrists meet the hands' (${(s.wrist * 1000).toFixed(2)} mm)`);
            }
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

    // ---- 7. a look redefined at runtime (V23.core.define, a development path): the old forearm halves and cast set are
    // disposed and the gun arms and castFX draw the new pair by the next render ------------------------------------------
    const redef = await evaluate(() => {
        agentSystem.selectAgent('sage');
        switchWeapon('rifle');
        const st = V23.fp.state, A0 = V23.fp._arm('sage'), rifle = st.models.find((m) => m.slot === 'rifle');
        const disposed = new Set(), watch = (g) => g.addEventListener('dispose', () => disposed.add(g));
        const olds = [A0.half.L.sleeve, A0.half.L.detail, A0.half.R.sleeve, A0.half.R.detail, A0.cf.L, A0.cf.R];
        olds.forEach(watch);
        V23.core.define('sage', JSON.parse(JSON.stringify(AGENT_LOOKS.sage)));
        __frame();
        const A1 = V23.fp._arm('sage'), arm = rifle.arm;
        return {
            newPair: A1.res !== A0.res, disposed: olds.filter((g) => disposed.has(g)).length, of: olds.length,
            armOnNew: arm.children[0].geometry === A1.res.sleeve && arm.children[1].geometry === A1.res.detail,
            castOnNew: castFX.sleeve.geometry === A1.cf.L && st.hand2Fore.geometry === A1.cf.R && castFX.hand.geometry === st.cast.pg.L.open,
            applied: st.applied, agent: st.agent
        };
    });
    assert.deepEqual(redef, { newPair: true, disposed: 6, of: 6, armOnNew: true, castOnNew: true, applied: true, agent: 'sage' }, 'a redefined look: old halves and cast forearms disposed, the new pair drawn');
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiled after the warm-up');
    assert.equal(stalls, 0, 'no first-use stalls');
    assert.deepEqual(errors, []);
});
