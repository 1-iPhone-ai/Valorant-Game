#!/usr/bin/env node
'use strict';
// V2.3: contact sheet for agent looks (design 3.7: the coordinator reviews front, 3/4 and back before a role batch merges).
// Boots the game once (menu, so the sim is paused), builds each agent's show LOD with V23.core.build and poses it with
// V23.motion.sample (idle at t, or a clip), then draws it with the game's own renderer into an sRGB render target, in a
// scene with exactly the viewmodel's light set (one hemisphere, one directional, no fog) and the game's environment map
// (so the stage's programs: nothing new compiles) over a plain backdrop card, reads the pixels back and saves PNGs.
// Also one PNG per world LOD (drawn the same way, with its own toneMapped world materials). Prints the program count
// before and after: they must be equal.
//
// Usage (from the repository root): node tests/tools/contact.js --agents sage,omen --out <dir> [--clip idle --t 2.0]
//   [--size 560x840] [--dpr 2]. Prints one line per image and the median build time per figure.
const path = require('path'), fs = require('fs');
const { boot, closeBrowser } = require(path.resolve(__dirname, '..', 'harness.js'));

const args = {};
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) { const k = a.slice(2), v = process.argv[i + 1]; if (v && !v.startsWith('--')) { args[k] = v; i++; } else args[k] = true; } }
const AGENTS = String(args.agents || 'sage,omen').split(',');
const OUT = path.resolve(args.out || 'contact');
const [W, H] = String(args.size || '560x840').split('x').map(Number);
const DPR = +(args.dpr || 2);
const CLIP = args.clip || 'idle', T = +(args.t || 2.0);

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const { evaluate, errors } = await boot({ menu: true, viewport: { width: 960, height: 540 } });
    const res = await evaluate(({ agents, W, H, DPR, clip, t }) => {
        // the game's renderer, an sRGB target W*DPR x H*DPR, and a scene with the viewmodel's light set and environment
        // rendered at twice the output size and scaled down (supersampled edges)
        const RW = W * DPR * 2, RH = H * DPR * 2;
        const rt = new THREE.WebGLRenderTarget(RW, RH);
        rt.texture.encoding = THREE.sRGBEncoding;
        const sc = new THREE.Scene();
        sc.environment = scene.environment;
        const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x20242c, 0.6), sun = new THREE.DirectionalLight(0xffffff, 0.9);
        sun.position.set(-3, 6, -5);
        sc.add(hemi, sun);
        const cam = new THREE.PerspectiveCamera(30, W / H, 0.05, 50);
        const pixels = new Uint8Array(RW * RH * 4);
        const c = document.createElement('canvas');
        c.width = RW; c.height = RH;
        const g2 = c.getContext('2d');
        const half = document.createElement('canvas');
        half.width = RW / 2; half.height = RH / 2;
        const gh = half.getContext('2d');
        gh.imageSmoothingEnabled = true;
        gh.imageSmoothingQuality = 'high';
        const programs0 = renderer.info.programs.length;
        const out = { images: [], builds: [] };
        // world: inside the game scene (its lights, fog and shadows: the ghost's programs), high above the map
        const shot = (root, yaw, label, world) => {
            const host = world ? scene : sc, P = world ? new THREE.Vector3(0, 40, 0) : new THREE.Vector3();
            const holder = new THREE.Group();
            holder.add(root);
            holder.rotation.y = yaw;
            holder.position.copy(P);
            host.add(holder);
            holder.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(holder);
            const h = Math.max(2.2, box.max.y - box.min.y), cy = (box.max.y + box.min.y) / 2;
            const dist = (h * 0.62) / Math.tan((cam.fov * Math.PI / 180) / 2);
            // the figure faces -Z: the camera stands in front of it at -Z
            cam.position.set(P.x, cy + 0.1, P.z - dist);
            cam.lookAt(P.x, cy, P.z);
            const prevT = renderer.getRenderTarget();
            renderer.setRenderTarget(rt);
            renderer.setClearColor(0x2b3038, 1);
            renderer.clear(true, true, true);
            renderer.render(host, cam);
            renderer.readRenderTargetPixels(rt, 0, 0, RW, RH, pixels);
            renderer.setRenderTarget(prevT);
            const img = g2.createImageData(RW, RH);
            for (let y = 0; y < RH; y++) img.data.set(pixels.subarray((RH - 1 - y) * RW * 4, (RH - y) * RW * 4), y * RW * 4);
            g2.putImageData(img, 0, 0);
            gh.drawImage(c, 0, 0, RW / 2, RH / 2);
            const url = half.toDataURL('image/png');
            host.remove(holder);
            holder.remove(root);
            out.images.push({ label: label, url: url });
        };
        for (const id of agents) {
            const t0 = performance.now();
            const show = V23.core.build(id, 'show');
            out.builds.push({ id: id, tier: 'show', ms: performance.now() - t0, stats: show.userData.v23.stats });
            V23.motion.sample(id, clip, t, show);
            const wasParent = show.parent;
            shot(show, 0, id + '-show-front');
            shot(show, -Math.PI / 4, id + '-show-34');
            shot(show, Math.PI, id + '-show-back');
            if (wasParent) wasParent.add(show);
            const t1 = performance.now();
            const world = V23.core.build(id, 'world');
            out.builds.push({ id: id, tier: 'world', ms: performance.now() - t1, stats: world.userData.v23.stats });
            const wp = world.parent;
            shot(world, -Math.PI / 4, id + '-world-34', true);
            if (wp) wp.add(world);
        }
        rt.dispose();
        out.programs = [programs0, renderer.info.programs.length, perfTelemetry.programWatermark];
        return out;
    }, { agents: AGENTS, W, H, DPR, clip: CLIP, t: T });
    for (const im of res.images) {
        const f = path.join(OUT, im.label + '.png');
        fs.writeFileSync(f, Buffer.from(im.url.split(',')[1], 'base64'));
        console.log('wrote', f);
    }
    for (const b of res.builds) console.log('build', b.id, b.tier, b.ms.toFixed(2) + ' ms', JSON.stringify(b.stats));
    console.log('programs before / after / watermark', res.programs.join(' / '));
    if (errors.length) console.log('page errors:', errors);
    await closeBrowser();
})().catch((e) => { console.error(e); process.exit(1); });
