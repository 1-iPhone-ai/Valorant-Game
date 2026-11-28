#!/usr/bin/env node
'use strict';
// V2.3 (WP5): vm-same.js, the viewmodel's pixels against V2.2 (a tool, not a test). same.js's views hide the gun; this
// renders the gun alone. Both builds boot side by side (each in its own browser context, three.js from node_modules,
// every other request blocked); the game loop is stopped and each case is posed and drawn by hand in one synchronous
// step, the same in both: the animator's springs, sprint and slide kick zeroed, the gun's transform reset, 30 settle
// frames on a fixed clock, then the clip frozen at its progress p (its start moved back by p x its length), with
// Math.random seeded and setTimeout held (no refill or eject timer), the viewmodel scene's weaponGroup (the guns, their
// hands and arms, castFX) and lights alone drawn over black, and its pixels read back. (The viewmodel scene's other
// child, the main menu's showcase, is left out: V2.2 leaves it visible after a skipped menu, V2.3's stage keeps it
// hidden; that is WP3's, not the gun's.) V2.3 runs with Agent Identity 'off' and botUtility 'classic' (design 17.3: V2.2's picture), and
// weaponAnims 'classic' (default) or 'v23' (--mode v23: the contrast, where reloads, draws and inspects must differ).
// Cases (gun:kind:p): reloads (tac, empty), inspects, draws from another slot, the knife's flourish, and 'last', the
// pistol right after its last round (V2.3's slide lock is a 'v23' look only). Enhanced Animations off, then on.
// Usage (from the repository root, NODE_PATH=tests/node_modules):
//   node tests/tools/vm-same.js [--a '(V2.2) valorant-fps.html'] [--b '(V2.3) valorant-fps.html'] [--mode classic|v23]
//        [--out <dir>] [--cases vandal:tac:0.3,...]
// Writes <out>/vm-same-<mode>.json and, for a case that differs, <out>/<mode>-<case>-{a,b}.png. Exit code 1 when a
// 'classic' case differs (or a 'v23' reload, draw or inspect does not).
const path = require('path'), fs = require('fs'), os = require('os');
const { chromium } = require('playwright');
const THREE_JS = fs.readFileSync(require.resolve('three/build/three.min.js'));
const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
const REPO = path.resolve(__dirname, '..', '..');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
    else if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args[a.slice(2)] = process.argv[++i];
    else args[a.slice(2)] = true;
}
const FILE_A = path.resolve(REPO, args.a || '(V2.2) valorant-fps.html');
const FILE_B = path.resolve(REPO, args.b || '(V2.3) valorant-fps.html');
const MODE = String(args.mode || 'classic');
const OUT = path.resolve(args.out || path.join(os.tmpdir(), 'v23-vm-same'));
const CASES = String(args.cases || [
    'vandal:tac:0.3', 'vandal:empty:0.45', 'vandal:empty:0.85', 'vandal:inspect:0.5', 'vandal:inspect:0.9', 'vandal:draw:0.2',
    'classic:tac:0.3', 'classic:empty:0.85', 'classic:inspect:0.5', 'classic:draw:0.2', 'classic:last:0',
    'ghost:last:0', 'sheriff:empty:0.5', 'spectre:empty:0.5', 'bucky:tac:0.3', 'odin:empty:0.5', 'operator:empty:0.5',
    'outlaw:empty:0.3', 'marshal:tac:0.5', 'knife:flourish:0.5', 'knife:draw:0.3'
].join(',')).split(',');
fs.mkdirSync(OUT, { recursive: true });
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- in the page: one case, posed and drawn synchronously -----------------------------------------------------------
const PAGE = () => {
    window.requestAnimationFrame = () => 0;   // the game loop stops after the frame in flight
    window.__vmCase = (spec, T) => {
        const [gun, kind, p] = spec;
        const realRandom = Math.random, realTimeout = window.setTimeout;
        let seed = 4242;
        Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
        window.setTimeout = () => 0;
        const has23 = typeof V23 !== 'undefined' && V23.vm;
        // a frame of the viewmodel as animate runs it: the group on the camera, the gun's pose, then V2.3's step
        const step = (t) => { updateWeaponPosition(); applyWeaponBobbing(t, false); if (has23) V23.vm.step(0.016, t); };
        try {
            if (castFX.active) { castFX.active = null; castFX.hide(); }
            if (vmAnim.clip) vmAnim.finishClip(game.weapons[game.activeWeapon]);
            game.reloading = false; game.adsActive = false; game.adsProgress = 0;
            const cc = characterController;
            cc.position.set(0, cc.standHeight, 22); if (cc.velocity) cc.velocity.set(0, 0, 0);
            camera.position.copy(cc.position); camera.rotation.set(-0.05, 0, 0, 'YXZ');
            weaponGroup.rotation.z = 0;
            const slot = gun === 'knife' ? 'knife' : GUN_DEFS[gun].slot;
            // the gun in hand (a draw starts from another slot)
            const from = kind === 'draw' ? (slot === 'pistol' ? 'rifle' : 'pistol') : slot;
            if (gun !== 'knife') applyGunDef(gun);
            switchWeapon(from);
            if (vmAnim.clip) vmAnim.finishClip(game.weapons[game.activeWeapon]);
            game.reloading = false;
            // the animator and the gun at rest, the same in both builds
            for (const k of Object.keys(vmAnim.sp)) vmAnim.sp[k] = 0;
            vmAnim.sprint = 0; vmAnim.slideKickAt = 0; vmAnim.wasGrounded = true; vmAnim.lastT = T - 16;
            if (enhancedAnim.on && eaFP.reset) { eaFP.reset(); eaFP.bobPh = 0; eaFP.lastT = T - 16; }
            for (const s of Object.keys(game.weapons)) {
                const m = game.weapons[s] && game.weapons[s].model;
                if (m) { m.position.set(0, 0, 0); m.rotation.set(0, 0, 0); }
            }
            const L = vmAnim.last;
            if (L) for (const k of ['px', 'py', 'pz', 'rx', 'ry', 'rz']) L[k] = 0;
            let t = T;
            for (let i = 0; i < 30; i++, t += 16) step(t);
            const w = game.weapons[slot];
            if (kind === 'tac' || kind === 'empty') {
                w.ammo = kind === 'empty' ? 0 : 1; reload();
                const c = vmAnim.clip; c.start = t - p * c.dur;
            } else if (kind === 'inspect') {
                inspectWeapon();
                const c = vmAnim.clip; c.start = t - p * c.dur;
            } else if (kind === 'draw') {
                switchWeapon(slot);
                const c = vmAnim.clip; c.start = t - p * c.dur;
            } else if (kind === 'flourish') {
                reload();
                const c = vmAnim.clip; c.start = t - p * c.dur;
            } else if (kind === 'last') {
                // the last round, then 200 ms (shoot reloads on the next pull, not this one)
                w.ammo = 1; game.lastShot = 0; shoot();
                for (let i = 0; i < 12; i++, t += 16) step(t);
            }
            step(t);
            syncViewmodelCamera();
            viewmodelScene.environment = scene.environment;
            renderer.setRenderTarget(null);
            renderer.setClearColor(0x000000, 1);
            renderer.clear();
            const hidden = viewmodelScene.children.filter((c) => c !== weaponGroup && !c.isLight && c.visible);
            for (const c of hidden) c.visible = false;
            renderer.render(viewmodelScene, viewmodelCamera);
            for (const c of hidden) c.visible = true;
            const gl = renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
            const px = new Uint8Array(W * H * 4);
            gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const info = { clip: vmAnim.clip ? vmAnim.clip.kind : null, ammo: w.ammo, W, H };
            if (window.__dump) {
                // (--dump) every mesh drawn: its path in the scene graph (child indices), name, and the screen box of its
                // bounding sphere's centre
                info.drawn = [];
                const walk = (o, at) => {
                    if (!o.visible) return;
                    if ((o.isMesh || o.isSprite || o.isPoints) && o.geometry) {
                        const c = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).project(viewmodelCamera);
                        info.drawn.push([at, o.name || '', o.geometry.type || '', o.material && o.material.type, +c.x.toFixed(2), +c.y.toFixed(2)]);
                    }
                    o.children.forEach((k, i) => walk(k, at + '/' + i));
                };
                walk(viewmodelScene, '');
            }
            // put it away
            if (vmAnim.clip) vmAnim.finishClip(game.weapons[game.activeWeapon]);
            if (typeof cancelReload === 'function') { game.reloading = true; cancelReload(); }
            game.reloading = false;
            if (w.maxAmmo) w.ammo = w.maxAmmo;
            if (has23) V23.vm.step(0.016, t + 16);
            return { px: Array.from(px), info };
        } finally {
            Math.random = realRandom; window.setTimeout = realTimeout;
        }
    };
};

async function open(browser, file, b23) {
    const ctx = await browser.newContext({ viewport: { width: 480, height: 270 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.addInitScript(() => { window.__skipMainMenu = true; });
    await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ body: THREE_JS, contentType: 'application/javascript' }));
    await page.route((url) => !url.href.startsWith('file:') && !url.href.startsWith('https://cdnjs.cloudflare.com'), (r) => r.abort());
    await page.goto('file://' + file, { timeout: 300000 });
    await page.waitForFunction(() => window.perfTelemetry && perfTelemetry.programWatermark > 0, null, { timeout: 300000 });
    const profile = await page.evaluate((mode) => {
        Element.prototype.requestPointerLock = function () {}; document.exitPointerLock = function () {};
        window.updateEnemies = () => {};
        try { tacticalEnhancements.toggleWingmanAI(false); } catch (e) {}
        setQualitySettings('medium');
        const u = game.userSettings, changed = [];
        u.infiniteAmmo = false; u.leftHanded = false;
        const set = (k, v) => { if (k in u) { u[k] = v; changed.push(k + '=' + v); } };
        set('agentIdentity', 'off');
        set('botUtility', 'classic');
        set('weaponAnims', mode);
        if (typeof V23 !== 'undefined') {
            if (V23.arena) V23.arena.enabled = false;
            if (V23.core && V23.core.applySettings) V23.core.applySettings(u, null);
        }
        return changed;
    }, MODE);
    // a few real frames with the settings applied, then the loop stops
    const f0 = await page.evaluate(() => frameIndex);
    await page.waitForFunction((f0) => frameIndex >= f0 + 8, f0, { timeout: 120000, polling: 50 });
    await page.evaluate(PAGE);
    if (args.dump) await page.evaluate(() => { window.__dump = true; });
    await new Promise((r) => setTimeout(r, 500));
    return { page, ctx, errors, profile, file };
}

function png(file, px, W, H) {
    // a minimal PNG writer (RGBA, rows bottom-up from readPixels, flipped here)
    const zlib = require('zlib');
    const raw = Buffer.alloc((W * 4 + 1) * H);
    for (let y = 0; y < H; y++) {
        raw[y * (W * 4 + 1)] = 0;
        const src = (H - 1 - y) * W * 4;
        for (let i = 0; i < W * 4; i++) raw[y * (W * 4 + 1) + 1 + i] = px[src + i];
    }
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

(async () => {
    const browser = await chromium.launch({ args: LAUNCH_ARGS });
    say('mode', MODE, 'a', path.basename(FILE_A), 'b', path.basename(FILE_B));
    const A = await open(browser, FILE_A, false);
    const B = await open(browser, FILE_B, true);
    say('profiles', JSON.stringify({ a: A.profile, b: B.profile }));
    const results = [];
    let bad = 0, T = 5e6;
    for (const ea of [false, true]) {
        for (const P of [A, B]) await P.page.evaluate((ea) => enhancedAnim.set(ea), ea);
        for (const c of CASES) {
            const [gun, kind, ps] = c.split(':');
            const spec = [gun, kind, +ps];
            const ra = await A.page.evaluate(([s, T]) => __vmCase(s, T), [spec, T]);
            const rb = await B.page.evaluate(([s, T]) => __vmCase(s, T), [spec, T]);
            T += 100000;
            let diff = 0, maxd = 0, lit = 0;
            for (let j = 0; j < ra.px.length; j += 4) {
                const d = Math.abs(ra.px[j] - rb.px[j]) + Math.abs(ra.px[j + 1] - rb.px[j + 1]) + Math.abs(ra.px[j + 2] - rb.px[j + 2]);
                if (d) diff++;
                if (d > maxd) maxd = d;
                if (ra.px[j] + ra.px[j + 1] + ra.px[j + 2] > 0) lit++;
            }
            const name = (ea ? 'ea-' : '') + c.replace(/:/g, '-');
            const row = { case: name, ea, differ: diff, of: ra.px.length / 4, maxDiff: maxd, gunPixels: lit, a: ra.info, b: rb.info };
            if (args.dump && diff) {
                const key = (d) => d.join('|');
                const sa = new Set(ra.info.drawn.map(key)), sb = new Set(rb.info.drawn.map(key));
                say('  drawn only in a:', JSON.stringify(ra.info.drawn.filter((d) => !sb.has(key(d)))));
                say('  drawn only in b:', JSON.stringify(rb.info.drawn.filter((d) => !sa.has(key(d)))));
            }
            results.push(row);
            // classic: every case equal; v23: a reload, draw, inspect or flourish differs (a 'last' differs only on a slide-lock pistol)
            const expectDiff = MODE === 'v23' && kind !== 'last';
            if (MODE === 'classic' ? diff > 0 : (expectDiff && diff === 0)) bad++;
            if (diff > 0) {
                png(path.join(OUT, MODE + '-' + name + '-a.png'), ra.px, ra.info.W, ra.info.H);
                png(path.join(OUT, MODE + '-' + name + '-b.png'), rb.px, rb.info.W, rb.info.H);
            }
            say(name, 'differ', diff + '/' + row.of, 'max', maxd, 'gun pixels', lit);
        }
    }
    for (const P of [A, B]) await P.page.evaluate(() => 0);
    const programs = {};
    for (const [k, P] of [['a', A], ['b', B]]) programs[k] = await P.page.evaluate(() => [renderer.info.programs.length, perfTelemetry.programWatermark]);
    const summary = { mode: MODE, a: path.basename(FILE_A), b: path.basename(FILE_B), cases: results.length, differing: results.filter((r) => r.differ).length, bad, programs, errors: { a: A.errors, b: B.errors } };
    fs.writeFileSync(path.join(OUT, 'vm-same-' + MODE + '.json'), JSON.stringify({ summary, results }, null, 1));
    say('summary', JSON.stringify(summary));
    await browser.close();
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
