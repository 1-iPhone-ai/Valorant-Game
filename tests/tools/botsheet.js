#!/usr/bin/env node
'use strict';
// V2.3 (WP6): the bot readability sheet (design 9.5): Sage (armored pool) and Omen (standard pool) bot variants at 15, 25
// and 35 m in all four highlight colours, in the default atmosphere and in Competitive (zero fog). Boots the game once on
// Ascent, freezes the AI, finds a spot with a clear 37 m line of sight (acoustics._dist at chest and head height), stands
// one bot there facing the camera and draws the game scene from the player's eye height with the game camera's field of
// view (no viewmodel, no HUD). For each image it saves the full frame and a crop around the bot scaled up 4x, plus one grid
// per agent and atmosphere (GRID-*.png; rows: red, yellow, purple, cyan; columns: 15, 25, 35 m; each crop scaled into a
// 256 px cell, nearest neighbour). Prints the program count before and after (they must be equal) and the bot's pixel
// footprint per distance. --tier low|medium|high forces the content tier through the saved contentTierMode (the default
// is the machine's own: Low on 4 or fewer hardware threads) and prefixes every file name with it.
//
// Usage (from the repository root): node tests/tools/botsheet.js --out <dir> [--size 960x540] [--tier medium]
const path = require('path'), fs = require('fs');
const { boot, closeBrowser } = require(path.resolve(__dirname, '..', 'harness.js'));

const args = {};
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) { const k = a.slice(2), v = process.argv[i + 1]; if (v && !v.startsWith('--')) { args[k] = v; i++; } else args[k] = true; } }
const OUT = path.resolve(args.out || 'botsheet');
const [W, H] = String(args.size || '960x540').split('x').map(Number);
const TIER = ['low', 'medium', 'high'].indexOf(args.tier) >= 0 ? args.tier : null;
const PRE = TIER ? TIER + '-' : '';

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const { evaluate, errors } = await boot({ viewport: { width: W, height: H }, quality: 'medium', initArg: TIER,
        initScript: (tier) => {
            Element.prototype.requestPointerLock = function () {}; document.exitPointerLock = function () {};
            if (tier) try { const k = 'valorant_v16_user_settings'; const o = JSON.parse(localStorage.getItem(k) || '{}'); o.contentTierMode = tier; localStorage.setItem(k, JSON.stringify(o)); } catch (e) {}
        } });
    const res = await evaluate(() => {
        window.updateEnemies = () => {};
        if (tacticalEnhancements.wingmanEnabled) tacticalEnhancements.toggleWingmanAI(false);
        if (game.mapPreset !== 'ascent') tacticalDirector.cycleMapPreset('ascent');
        const programs0 = renderer.info.programs.length;
        // a clear 37 m line: bot at (x, z), camera along direction a
        // the spot: no wall within 0.9 m of the bot, and the line to 36 m clear at three heights and 0.4 m to each side
        let spot = null, best = 0;
        for (let x = -36; x <= 36; x += 2) for (let z = -36; z <= 36; z += 2) {
            if (resolveEnemyMapCollision(new THREE.Vector3(x, 0, z), 0.9, true)) continue;
            for (let k = 0; k < 16; k++) {
                const a = k * Math.PI / 8, d = new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), side = new THREE.Vector3(d.z, 0, -d.x);
                let clear = 99;
                for (const h of [0.6, 1.2, 1.8]) for (const o of [-0.4, 0, 0.4]) clear = Math.min(clear, acoustics._dist(new THREE.Vector3(x + side.x * o, h, z + side.z * o), d, 45));
                if (clear >= 36 && Math.abs(x + d.x * 35) < 46 && Math.abs(z + d.z * 35) < 46 && clear > best) { best = clear; spot = { x: x, z: z, a: a, clear: clear }; }
            }
        }
        if (!spot) return { error: 'no clear line found' };
        const e = enemyObjects.find((x) => x.isActive && !x.hit) || enemyObjects[0];
        for (const x of enemyObjects) if (x !== e) { x.isActive = false; x.hit = true; x.renderActive = false; x.mesh.visible = false; }
        const gl = renderer.getContext();
        const shots = [];
        const canvas = document.createElement('canvas'), g2 = canvas.getContext('2d');
        const crop = document.createElement('canvas'), gc = crop.getContext('2d');
        gc.imageSmoothingEnabled = false;
        const save = (name, w, h, px, box) => {
            canvas.width = w; canvas.height = h;
            const img = g2.createImageData(w, h);
            for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
            g2.putImageData(img, 0, 0);
            const full = canvas.toDataURL('image/png');
            const S = 4, cw = box[2], ch = box[3];
            crop.width = cw * S; crop.height = ch * S;
            gc.imageSmoothingEnabled = false;
            gc.drawImage(canvas, box[0], box[1], cw, ch, 0, 0, cw * S, ch * S);
            shots.push({ name: name, full: full, crop: crop.toDataURL('image/png') });
        };
        const out = { spot: spot, images: [], footprint: {} };
        const cam = camera, keepPos = cam.position.clone(), keepRot = cam.rotation.clone();
        for (const atmos of ['daylight', 'competitive']) {
            game.userSettings.atmosphereMode = atmos;
            settingsManager.applyAtmosphereTheme();
            for (const [agent, arch] of [['sage', 'armored'], ['omen', 'standard']]) {
                activateEnemy(e, spot.x, 0, spot.z, arch);
                e.mesh.position.set(spot.x, 0, spot.z);   // the spot is clear of walls: no push needed
                e.mesh.rotation.set(0, spot.a, 0);   // its +Z (the drawn front) toward the camera
                e.poseDirty = true;
                V23.bots.kitRep(e, { agentId: agent });
                for (const mode of ['red', 'yellow', 'purple', 'cyan']) {
                    game.userSettings.enemyHighlightColor = mode;
                    settingsManager.applyEnemyHighlightColor();
                    e.colorDirty = true; e.poseDirty = true;
                    for (const dist of [15, 25, 35]) {
                        cam.position.set(spot.x + Math.sin(spot.a) * dist, 1.6, spot.z + Math.cos(spot.a) * dist);
                        cam.lookAt(spot.x, 1.15, spot.z);
                        cam.updateMatrixWorld();
                        packEnemyBatches();
                        shadowManager.markEvent(); shadowManager.beforeRender(performance.now() + 1e5);
                        skyDome.position.copy(cam.position); skyDome.updateMatrix();
                        renderer.info.reset();   // a new info frame: r128 uploads changed geometry attributes (instanceKit) once per frame
                        renderer.setRenderTarget(null); renderer.setClearColor(scene.background, 1); renderer.clear(); renderer.render(scene, cam);
                        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
                        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
                        // the bot's screen box: its 2.3 m figure projected
                        const p0 = new THREE.Vector3(spot.x, 0, spot.z).project(cam), p1 = new THREE.Vector3(spot.x, 2.3, spot.z).project(cam);
                        const sx = (p0.x * 0.5 + 0.5) * w, y0 = (1 - (p0.y * 0.5 + 0.5)) * h, y1 = (1 - (p1.y * 0.5 + 0.5)) * h;
                        const bh = Math.max(8, Math.ceil(y0 - y1)), side = Math.ceil(bh * 1.4);
                        const box = [Math.max(0, Math.round(sx - side / 2)), Math.max(0, Math.round(y1 - bh * 0.2)), Math.min(side, w), Math.min(Math.ceil(bh * 1.4), h)];
                        const name = `${agent}-${arch}-${atmos}-${mode}-${dist}m`;
                        save(name, w, h, px, box);
                        out.footprint[dist] = bh;
                        out.images.push(name);
                    }
                }
            }
        }
        cam.position.copy(keepPos); cam.rotation.copy(keepRot); cam.updateMatrixWorld();
        game.userSettings.atmosphereMode = 'daylight'; settingsManager.applyAtmosphereTheme();
        game.userSettings.enemyHighlightColor = 'red'; settingsManager.applyEnemyHighlightColor();
        V23.bots.kitRep(e, null);
        out.shots = shots;
        out.programs = [programs0, renderer.info.programs.length, perfTelemetry.programWatermark, perfTelemetry.firstUseStalls];
        out.identity = [enemyAnimUniforms.uIdentity.value, V23.bots._state.tier];
        return out;
    });
    if (res.error) { console.error(res.error); process.exit(1); }
    // one grid per agent and atmosphere: rows the highlight colours, columns the distances, each crop fitted into a cell
    const grids = await evaluate(async (shots) => {
        const CELL = 256, GAP = 4, out = [];
        const load = (u) => new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = u; });
        const byName = new Map(shots.map((s) => [s.name, s.crop]));
        for (const atmos of ['daylight', 'competitive']) for (const [agent, arch] of [['sage', 'armored'], ['omen', 'standard']]) {
            const c = document.createElement('canvas'), g = c.getContext('2d');
            c.width = 3 * CELL + 4 * GAP; c.height = 4 * CELL + 5 * GAP;
            g.fillStyle = '#202020'; g.fillRect(0, 0, c.width, c.height);
            g.imageSmoothingEnabled = false;
            const modes = ['red', 'yellow', 'purple', 'cyan'], dists = [15, 25, 35];
            for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) {
                const u = byName.get(`${agent}-${arch}-${atmos}-${modes[r]}-${dists[k]}m`);
                if (!u) continue;
                const im = await load(u), s = Math.min(CELL / im.width, CELL / im.height), w = Math.floor(im.width * s), h = Math.floor(im.height * s);
                g.drawImage(im, GAP + k * (CELL + GAP) + ((CELL - w) >> 1), GAP + r * (CELL + GAP) + ((CELL - h) >> 1), w, h);
            }
            out.push({ name: `GRID-${agent}-${arch}-${atmos}`, url: c.toDataURL('image/png') });
        }
        return out;
    }, res.shots.map((s) => ({ name: s.name, crop: s.crop })));
    const png = (u) => Buffer.from(u.split(',')[1], 'base64');
    for (const s of res.shots) {
        fs.writeFileSync(path.join(OUT, PRE + s.name + '.png'), png(s.full));
        fs.writeFileSync(path.join(OUT, PRE + s.name + '-crop.png'), png(s.crop));
    }
    for (const g of grids) fs.writeFileSync(path.join(OUT, PRE + g.name + '.png'), png(g.url));
    console.log('spot', JSON.stringify(res.spot), 'bot height in px by distance', JSON.stringify(res.footprint));
    console.log('programs before / after / watermark / stalls', JSON.stringify(res.programs), 'uIdentity, tier', JSON.stringify(res.identity));
    console.log('saved', res.shots.length * 2 + grids.length, 'images to', OUT, TIER ? '(content tier ' + TIER + ')' : '');
    console.log('errors', JSON.stringify(errors));
    await closeBrowser();
})().catch((e) => { console.error(e); process.exit(1); });
