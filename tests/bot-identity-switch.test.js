'use strict';
// V2.3 (WP6): Agent Identity switched on in play, from a boot with it off (design 2.5, 9.3). One boot of the V2.3 build
// with agentIdentity 'off' saved, at most 4 minutes. Checks:
//  - the first switch-on, made with the real pill while every bot moves: the identity build runs inside the next pack
//    (a page's flush), and after that one pack every live slot holds its own bot's kit (instanceKit x = the agent's mask
//    on the tier, the kit flag, the flash flag only while flashing, no dissolve on a living bot; the kit colour =
//    leaves[0]'s) and every kit draws at its page's count; again after real frames;
//  - the build's warm reserve after the warm-up: two pages, drawn once by the next frame (prefill: the frame's pixels
//    equal those of the frame after it, every reserve object hidden after its draw); a free page's new kit likewise;
//    a bot entering a new chunk then takes a reserve page and creates no GPU buffer, and a bot taking the free page
//    creates none either;
//  - off and on again while a bot dissolves, its page-mate taking its slot while off: the page-mate's slot shows its own
//    kit, no dissolve (review round 2, case b);
//  - Math.random: no draw with BOTKIT code on the stack, none in the switch-on pack; programs == watermark, 0 stalls,
//    no page errors.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { boot, closeBrowser, programState, GAME_FILE } = require('./harness');

after(closeBrowser);

// No pointer lock in headless runs, and Agent Identity off in the saved settings before the game reads them
const INIT = () => {
    Element.prototype.requestPointerLock = function () {}; document.exitPointerLock = function () {};
    try { const k = 'valorant_v16_user_settings'; const o = JSON.parse(localStorage.getItem(k) || '{}'); o.agentIdentity = 'off'; localStorage.setItem(k, JSON.stringify(o)); } catch (e) {}
};
// The BOTKIT block's line range in the game file (stack frames of the inline script carry the document's line numbers)
function botkitLines() {
    const lines = fs.readFileSync(GAME_FILE, 'utf8').split('\n');
    const lo = lines.findIndex((l) => l.includes('// ===== V2.3 BLOCK BOTKIT [WP6] =====')) + 1;
    const hi = lines.findIndex((l) => l.includes('// ===== END V2.3 BLOCK BOTKIT =====')) + 1;
    return [lo, hi];
}

test('bot identity switched on in play (boot with it off): every slot\'s kit after one pack, the reserve prefill, off and on while a bot dissolves', { timeout: 240000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ initScript: INIT });
    const [, watermark0] = await programState(page);
    await frames(10);

    // ---- Math.random: count every draw; a draw with BOTKIT code on the stack (a V23.bots entry or a frame inside the
    // block's lines: render callbacks, the build) is one too many (V23.core._quiet swaps Math.random for its own stream)
    const [lo, hi] = botkitLines();
    assert.ok(lo > 0 && hi > lo, 'the BOTKIT block is found');
    const start = await evaluate(([lo, hi]) => {
        const R = window.__v23rand = { total: 0, inside: 0, sites: {}, depth: 0 };
        const real = Math.random, re = /\.html:(\d+):\d+/g;
        const inBlock = (st) => { re.lastIndex = 0; let m; while ((m = re.exec(st))) { const n = +m[1]; if (n >= lo && n <= hi) return true; } return false; };
        Math.random = function () {
            R.total++;
            const lim = Error.stackTraceLimit; Error.stackTraceLimit = 100; const st = new Error().stack; Error.stackTraceLimit = lim;
            if (R.depth > 0 || inBlock(st)) { R.inside++; const k = (st.split('\n')[2] || '').trim(); R.sites[k] = (R.sites[k] || 0) + 1; }
            return real();
        };
        for (const k of Object.keys(V23.bots)) {
            const f = V23.bots[k];
            if (typeof f !== 'function' || k[0] === '_') continue;
            V23.bots[k] = function () { R.depth++; try { return f.apply(this, arguments); } finally { R.depth--; } };
        }
        // the slot check: every live page's kit and every slot's instanceKit and kit colour
        window.__kitCheck = () => {
            const S = V23.bots._state, bad = [], c = new THREE.Color();
            let slots = 0, pages = 0;
            for (const ch of enemyChunks.values()) for (const pg of ch.pages) {
                if (!pg.live) continue;
                pages++;
                if (!pg.kit) { bad.push(ch.key + ': no kit'); continue; }
                if (pg.kit.count !== pg.members.length) bad.push(ch.key + ': kit count ' + pg.kit.count + ' for ' + pg.members.length);
                const A = pg.kit.geometry.attributes.instanceKit;
                pg.members.forEach((e, s) => {
                    slots++;
                    const want = V23.bots._kitMask(e.agentId, S.tier) + (e.v23Orb === true ? 8388608 : 0);
                    const x = A.getX(s), w = A.getW(s), f = Math.floor(w + 1e-4), flags = 1 + (e.flashUntil && e.flashUntil[0] ? 2 : 0);
                    pg.kit.getColorAt(s, c);
                    const col = e.leaves[0].material.color;
                    const ok = x === want && f === flags && (e.hit || w - f < 1e-4) && Math.abs(c.r - col.r) < 1e-6 && Math.abs(c.g - col.g) < 1e-6 && Math.abs(c.b - col.b) < 1e-6;
                    if (!ok) bad.push(ch.key + ' slot ' + s + ' ' + e.agentId + ': x ' + x + ' (want ' + want + '), w ' + w.toFixed(3) + ' (flags ' + flags + ')');
                });
            }
            return { bad: bad, slots: slots, pages: pages, on: S.on, uIdentity: enemyAnimUniforms.uIdentity.value };
        };
        return { built: V23.bots._state.built, on: V23.bots._state.on, uIdentity: enemyAnimUniforms.uIdentity.value, kits: [...enemyChunks.values()].some((c) => c.pages.some((pg) => !!pg.kit)), made: V23.bots._stats.reserveMade };
    }, [lo, hi]);
    assert.deepEqual(start, { built: false, on: false, uIdentity: 0, kits: false, made: 0 }, 'identity off at boot: nothing built, no kits, uIdentity 0');

    // ---- the first switch-on, inside the next pack: a free page first (a bot alone on its page hidden), then the
    // real pill, then every bot on a page moves and one pack runs -----------------------------------------------------
    const first = await evaluate(() => {
        const S = V23.bots._state, st = V23.bots._stats, R = window.__v23rand;
        const out = {};
        // the bots' AI stands still from here (the test moves them), so the hidden bot stays hidden until it is shown
        window.updateEnemies = () => {};
        // one bot alone on its page (moved into a chunk with no page if none is), and two more bots beside another bot
        // (toward its chunk's centre), so pages hold more than one slot
        const onPages = () => enemyObjects.filter((x) => x.isActive && !x.hit && x.renderActive && x.page);
        let lone = onPages().find((x) => x.page.members.length === 1);
        if (!lone && onPages().length) {
            const used = new Set([...enemyChunks.keys()]);
            let t = null;
            for (const ring of [[-1, 0], [-2, -1, 0, 1]]) for (const cx of ring) for (const cz of ring) if (!t && !used.has(cx + ',' + cz)) t = [cx, cz];
            lone = onPages()[0];
            lone.mesh.position.set(t[0] * 50 + 25, 0, t[1] * 50 + 25); lone.poseDirty = true;
            packEnemyBatches();
        }
        const host = onPages().find((x) => x !== lone);
        if (host) for (let i = 0; i < 2; i++) {
            const x = enemyObjects.find((y) => !y.isActive && !y.renderActive) || createEnemyActor('standard');
            const p = host.mesh.position, dx = Math.sign((host.pageCx + 0.5) * 50 - p.x) || 1, dz = Math.sign((host.pageCz + 0.5) * 50 - p.z) || 1;
            activateEnemy(x, p.x + dx * 0.7 * (i + 1), p.y, p.z + dz * 0.5, 'standard');
        }
        packEnemyBatches();
        out.lone = !!lone && lone.page.members.length === 1;
        if (lone) { window.__lone = lone; lone.mesh.visible = false; packEnemyBatches(); }
        out.free = enemyPageFree.length;
        const p0 = renderer.info.programs.length;
        document.querySelector('#setting-agent-identity-pills [data-agentidentity="on"]').click();
        out.builtByPill = S.built;
        const r0 = R.total;
        for (const e of enemyObjects) if (e.page) { e.mesh.position.x += 0.01; e.poseDirty = true; }
        packEnemyBatches();
        out.packDraws = R.total - r0;
        out.check = window.__kitCheck();
        out.built = S.built;
        out.switchRepacks = st.switchRepacks;
        out.made = st.reserveMade;
        // the prefill: the reserve pages (and the free page's kit) wait for the next draw, shown with one instance
        out.waiting = S.reserve.every((pg) => pg.meshes.every((m) => m.visible && m.count === 1 && Object.prototype.hasOwnProperty.call(m, 'onAfterRender')) && pg.kit.visible);
        out.freeKit = enemyPageFree.map((pg) => !!pg.kit && pg.kit.parent === scene && pg.kit.count === 1);
        // two frames drawn as the game draws them (its camera, to the canvas): the first draws the reserve, the second
        // does not; the pixels are equal
        const gl = renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        const shot = () => {
            renderer.info.reset(); renderer.setRenderTarget(null); renderer.render(scene, camera);
            const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
            return [px, renderer.info.render.calls];
        };
        const pre0 = st.reservePrefilled, g0 = perfTelemetry.glBufferDataCalls;
        const [a, ca] = shot();
        const g1 = perfTelemetry.glBufferDataCalls;
        const [b, cb] = shot();
        let diff = 0;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
        out.prefill = { diff: diff, calls: [ca, cb], bufferData: [g1 - g0, perfTelemetry.glBufferDataCalls - g1], prefilled: st.reservePrefilled - pre0, parts: enemyPartSpecs.length,
            hidden: S.reserve.every((pg) => pg.meshes.every((m) => !m.visible && !Object.prototype.hasOwnProperty.call(m, 'onAfterRender')) && !Object.prototype.hasOwnProperty.call(pg.kit, 'onAfterRender')),
            freeBack: enemyPageFree.every((pg) => pg.kit && pg.kit.parent === pg.meshes[0] && pg.kit.count === 0 && pg.kit.frustumCulled) };
        out.programs = [p0, renderer.info.programs.length];
        return out;
    });
    assert.equal(first.builtByPill, false, 'the pill alone builds nothing (CORE\'s applySettings does not call BOTKIT): the build is the next pack\'s');
    assert.ok(first.built && first.check.on && first.check.uIdentity === 1, 'the pack after the pill built the kits and switched them on');
    assert.equal(first.switchRepacks, 1, 'the switch came inside a page\'s flush (the case V2.2\'s structureDirty clear used to lose)');
    assert.ok(first.check.slots >= 3 && first.check.pages < first.check.slots, `live bots on pages, some sharing one (${JSON.stringify(first.check)})`);
    assert.deepEqual(first.check.bad, [], 'after one pack every live slot holds its own bot\'s kit and colour, and every kit its page\'s count');
    assert.equal(first.packDraws, 0, 'the switch-on pack (the build and the reserve) takes no Math.random draw from the game\'s stream');
    assert.equal(first.made, 2, 'the build made the two reserve pages after the warm-up');
    assert.ok(first.waiting, 'the reserve pages wait for the next frame\'s draw');
    assert.ok(first.lone && first.free >= 1 && first.freeKit.length >= 1 && first.freeKit.every(Boolean), `the free page's new kit waits in the scene for its draw (${JSON.stringify(first.freeKit)})`);
    assert.equal(first.prefill.diff, 0, `the prefill draw changes no pixel (${JSON.stringify(first.prefill)})`);
    assert.ok(first.prefill.calls[0] - first.prefill.calls[1] >= 2 * (first.prefill.parts + 1), `the first frame draws the reserve pages (${first.prefill.calls})`);
    assert.equal(first.prefill.prefilled, 2 * (first.prefill.parts + 1) + first.freeKit.length, 'each reserve object and the free kit drawn once');
    assert.ok(first.prefill.hidden && first.prefill.freeBack, 'then hidden, the free kit back under its torso at count 0');
    assert.equal(first.prefill.bufferData[1], 0, 'the frame after creates no buffer');
    assert.deepEqual(first.programs, [watermark0, watermark0], 'the build and the prefill compile nothing');
    console.log('# first switch-on:', JSON.stringify({ slots: first.check.slots, pages: first.check.pages, prefill: first.prefill }));

    // real frames (the game's own loop): the kits stay right
    await frames(5);
    const real = await evaluate(() => window.__kitCheck());
    assert.deepEqual(real.bad, [], `after real frames every live slot still holds its own kit (${JSON.stringify(real)})`);

    // ---- no buffer for a bot taking the free page, or a reserve page in a new chunk ------------------------------------
    const moves = await evaluate(() => {
        const S = V23.bots._state, st = V23.bots._stats, out = {};
        const cam = new THREE.PerspectiveCamera(100, 480 / 270, 0.5, 400);
        cam.position.set(0, 120, 0.01); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
        const draw = () => {
            const keep = new Set(), hidden = [];
            for (const c of enemyChunks.values()) for (const pg of c.pages) for (const m of pg.meshes) keep.add(m);
            for (const o of scene.children) if (!keep.has(o) && !o.isLight && o.visible) { hidden.push(o); o.visible = false; }
            renderer.info.reset(); renderer.setRenderTarget(null); renderer.clear(); renderer.render(scene, cam);
            const calls = renderer.info.render.calls;
            for (const o of hidden) o.visible = true;
            return calls;
        };
        // the hidden bot comes back: V2.2 takes the free page (no new page), its kit was drawn by the prefill
        const lone = window.__lone;
        if (lone) {
            const g0 = perfTelemetry.glBufferDataCalls, free0 = enemyPageFree.length;
            lone.mesh.visible = true; lone.poseDirty = true;
            packEnemyBatches();
            const calls = draw();
            const s = lone.page ? lone.page.members.indexOf(lone) : -1;
            out.free = { tookFree: enemyPageFree.length === free0 - 1, calls: calls, bufferData: perfTelemetry.glBufferDataCalls - g0,
                mask: s >= 0 ? lone.page.kit.geometry.attributes.instanceKit.getX(s) : null, want: V23.bots._kitMask(lone.agentId, S.tier), count: lone.page && lone.page.kit.count };
        }
        // a bot into a chunk with no page: it joins a buddy's page first and the free list is set aside, so V2.2 creates
        // a page, which takes a reserve page's meshes and kit
        const live = enemyObjects.filter((x) => x.isActive && !x.hit && x.renderActive && x.page);
        if (live.length >= 2) {
            const e = live[0], buddy = live[1];
            const used = new Set([...enemyChunks.keys()]);
            let target = null;
            for (const ring of [[-1, 0], [-2, -1, 0, 1]]) for (const cx of ring) for (const cz of ring) if (!target && !used.has(cx + ',' + cz)) target = [cx, cz];
            e.mesh.position.copy(buddy.mesh.position); e.mesh.position.x += 0.8; e.poseDirty = true;
            packEnemyBatches();
            draw();
            const stash = enemyPageFree.splice(0), u0 = st.reserveUsed, g0 = perfTelemetry.glBufferDataCalls;
            e.mesh.position.set(target[0] * 50 + 25, 0, target[1] * 50 + 25); e.poseDirty = true;
            packEnemyBatches();
            const calls = draw();
            enemyPageFree.push(...stash);
            const s = e.page ? e.page.members.indexOf(e) : -1;
            out.chunk = { target: target, reserveUsed: st.reserveUsed - u0, calls: calls, bufferData: perfTelemetry.glBufferDataCalls - g0, at: e.pageCx + ',' + e.pageCz,
                mask: s >= 0 ? e.page.kit.geometry.attributes.instanceKit.getX(s) : null, want: V23.bots._kitMask(e.agentId, S.tier) };
        }
        return out;
    });
    assert.ok(moves.free, 'the hidden bot came back');
    assert.ok(moves.free.tookFree && moves.free.calls > 0, `the bot took the free page (${JSON.stringify(moves.free)})`);
    assert.equal(moves.free.bufferData, 0, `a bot taking the free page creates no GPU buffer (${JSON.stringify(moves.free)})`);
    assert.equal(moves.free.mask, moves.free.want, 'and shows its kit');
    assert.ok(moves.chunk && moves.chunk.target, `a chunk without a page (${JSON.stringify(moves.chunk)})`);
    assert.equal(moves.chunk.reserveUsed, 1, 'the new page took a reserve page');
    assert.equal(moves.chunk.bufferData, 0, `a bot entering a new chunk after the switch-on creates no GPU buffer (${JSON.stringify(moves.chunk)})`);
    assert.equal(moves.chunk.mask, moves.chunk.want, 'and shows its kit');
    console.log('# after the switch-on:', JSON.stringify(moves));

    // ---- off and on again while a bot dissolves; its page-mate takes its slot while off (review round 2, case b) -------
    const caseB = await evaluate(() => {
        const pill = (v) => document.querySelector(`#setting-agent-identity-pills [data-agentidentity="${v}"]`).click();
        const live = enemyObjects.filter((x) => x.isActive && !x.hit && x.renderActive && x.page);
        const out = { live: live.length };
        if (live.length < 2) return out;
        // the first page of the first chunk in enemyChunks' order (flushed first): a is its slot 0, b its slot 1 (another
        // bot is moved in beside a when the page holds one)
        const P = [...enemyChunks.values()][0].pages[0];
        const a = P.members[0];
        if (P.members.length < 2) {
            const o = live.find((x) => x.page !== P);
            o.mesh.position.set(a.mesh.position.x + (Math.sign((a.pageCx + 0.5) * 50 - a.mesh.position.x) || 1) * 0.8, a.mesh.position.y, a.mesh.position.z); o.poseDirty = true;
            packEnemyBatches();
        }
        const b = P.members[1];
        out.samePage = !!b && a.page === P && b.page === P && P.members.indexOf(a) === 0 && P.members.indexOf(b) === 1 && [...enemyChunks.values()][0].pages[0] === P;
        if (!out.samePage) return out;
        a.health = 1; a.armor = 0;
        damageEnemyActor(a, 999, performance.now(), Date.now(), 'Test', 'torso');
        let d = 0;
        for (let i = 0; i < 300 && d < 0.4; i++) {
            stepActorAnimations(); b.poseDirty = true; packEnemyBatches();
            if (!a.page) break;
            const w = a.page.kit.geometry.attributes.instanceKit.getW(a.page.members.indexOf(a));
            d = w - Math.floor(w + 1e-4);
        }
        out.dissolving = +d.toFixed(3);
        pill('off');
        b.poseDirty = true; packEnemyBatches();
        out.off = V23.bots._state.on;
        for (let i = 0; i < 400 && a.renderActive; i++) { stepActorAnimations(); b.poseDirty = true; packEnemyBatches(); }
        b.poseDirty = true; packEnemyBatches();
        out.took = !a.page && P.members.indexOf(b) === 0;
        pill('on');
        b.mesh.position.x += 0.01; b.poseDirty = true;
        packEnemyBatches();
        const A = P.kit.geometry.attributes.instanceKit, s = P.members.indexOf(b);
        out.slot = { x: A.getX(s), w: +A.getW(s).toFixed(4), want: V23.bots._kitMask(b.agentId, V23.bots._state.tier), aMask: V23.bots._kitMask(a.agentId, V23.bots._state.tier), count: P.kit.count, members: P.members.length };
        out.check = window.__kitCheck();
        respawnEnemy(a);
        packEnemyBatches();
        return out;
    });
    assert.ok(caseB.live >= 2 && caseB.samePage, `two bots on the first page (${JSON.stringify(caseB)})`);
    assert.ok(caseB.dissolving >= 0.4, 'the first bot dissolves');
    assert.equal(caseB.off, false, 'identity off');
    assert.ok(caseB.took, 'its page-mate took its slot while off');
    assert.deepEqual([caseB.slot.x, caseB.slot.w, caseB.slot.count], [caseB.slot.want, 1, caseB.slot.members], `on again: the page-mate's slot shows its own kit, no dissolve, the kit at the page's count (${JSON.stringify(caseB.slot)})`);
    assert.deepEqual(caseB.check.bad, [], 'and every live slot holds its own kit');

    await frames(5);
    const rand = await evaluate(() => window.__v23rand);
    console.log('# Math.random draws', rand.total, 'inside BOTKIT', rand.inside, JSON.stringify(rand.sites), 'stats', JSON.stringify(await evaluate(() => V23.bots._stats)));
    assert.equal(rand.inside, 0, `no Math.random draw inside BOTKIT (${JSON.stringify(rand.sites)})`);
    const [programs, watermark, stalls] = await programState(page);
    assert.equal(watermark, watermark0, 'the watermark never moved');
    assert.equal(programs, watermark, 'programs == watermark');
    assert.equal(stalls, 0, 'no first-use stalls');
    assert.deepEqual(errors, []);
});
