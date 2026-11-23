'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// V1.8 Ascent: three walled lanes, enclosed sites, per-map data and bot routing.
// Every check runs on the game's own geometry (shot index, colliders, walk grid).

// Lane interiors from the preset's floor plan (the spawns, sites and mid's links
// are where lanes are allowed to meet, so they are left out)
const LANES = () => {
    const P = MAP_PRESETS.ascent.plan;
    const inR = (r, x, z) => x > r[0] + 0.6 && x < r[1] - 0.6 && z > r[2] + 0.6 && z < r[3] - 0.6;
    window.__lane = (x, z) => {
        // (a lane starts 4 m out of its spawn: the spawns are where lanes may see each other)
        if ((inR(P.aMainE, x, z) && x > P.aMainW[1] && x < P.aDoorW[0]) || (inR(P.aMainW, x, z) && z > P.aMainE[3] && z < P.atkSpawn[2] - 4)) return 'A';
        if ((inR(P.bMainE, x, z) && x > P.bMainW[1] && x < P.bDoorW[0]) || (inR(P.bMainW, x, z) && z < P.bMainE[2] && z > P.atkSpawn[3] + 4)) return 'B';
        if ((inR(P.midBotW, x, z) && x > P.atkSpawn[1] + 4) || inR(P.midBotV, x, z) || inR(P.midBotE, x, z) || inR(P.court, x, z) ||
            inR(P.midTopW, x, z) || inR(P.midTopV, x, z) || (inR(P.midTopE, x, z) && x < P.defSpawn[0] - 4)) return 'M';
        return null;
    };
    window.__open = (x, z, y = 1.6) => {
        // Free floor at this height: no map piece there
        for (const p of mapPieces) {
            const b = p.bounds;
            if (b.min.y > y || b.max.y < y) continue;
            if (x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z) return false;
        }
        return true;
    };
    window.__sees = (ax, az, bx, bz, y) => {
        const a = new THREE.Vector3(ax, y, az), b = new THREE.Vector3(bx, y, bz);
        return agentSystem.hasWallLineOfSight(a, b, a.distanceTo(b));
    };
};

test('Ascent layout: 150-250 pieces; no sightline between A Main, Mid and B Main, even from a raised spot; longest sightline about 45 m; walls at least 0.5 m thick', { timeout: 300000 }, async () => {
    const { page, errors, evaluate } = await boot({ quality: 'low' });
    await evaluate(LANES);
    const r = await evaluate(() => {
        const out = { map: game.mapPreset, pieces: mapPieces.length };
        const P = MAP_PRESETS.ascent.plan;
        // Points every 1.5 m on the open floor of each lane
        const pts = { A: [], M: [], B: [] }, all = [];
        for (let z = -48.75; z <= 48.75; z += 1.5) for (let x = -48.75; x <= 48.75; x += 1.5) {
            let inPlan = false;
            for (const k in P) { const q = P[k]; if (x > q[0] && x < q[1] && z > q[2] && z < q[3]) { inPlan = true; break; } }
            if (!inPlan || !__open(x, z)) continue;
            all.push([x, z]);
            const l = __lane(x, z);
            if (l) pts[l].push([x, z]);
        }
        out.lanePoints = [pts.A.length, pts.M.length, pts.B.length];
        // Across lanes: at eye height, and from 4.2 m (standing on the site platform)
        const cross = [];
        for (const [la, lb] of [['A', 'M'], ['B', 'M'], ['A', 'B']]) {
            for (const p of pts[la]) for (const q of pts[lb]) {
                for (const y of [1.6, 4.2]) if (__sees(p[0], p[1], q[0], q[1], y)) { if (cross.length < 6) cross.push([la, lb, p, q, y]); }
            }
        }
        out.cross = cross;
        // Longest line of sight anywhere on the open floor (2 m sampling)
        let longest = 0, pair = null;
        for (let i = 0; i < all.length; i++) {
            const p = all[i];
            if ((Math.round((p[0] + 48.75) / 1.5) + Math.round((p[1] + 48.75) / 1.5)) % 2) continue;
            for (let j = i + 1; j < all.length; j++) {
                const q = all[j];
                const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
                if (d <= longest || d < 40) continue;
                if (__sees(p[0], p[1], q[0], q[1], 1.6)) { longest = d; pair = [p, q]; }
            }
        }
        out.longest = +longest.toFixed(1);
        out.pair = pair;
        // Standing pieces (walls, cover) are never thinner than 0.5 m
        out.thin = mapPieces.filter((p) => p.bounds.min.y < 0.1 && p.bounds.max.y >= 2 &&
            Math.min(p.bounds.max.x - p.bounds.min.x, p.bounds.max.z - p.bounds.min.z) < 0.5).length;
        // The lane walls stand at least 6 m tall with no gaps: every point just outside
        // a lane's floor is either more floor (a junction) or inside a 6 m+ building
        const low = [];
        const floorAt = (x, z) => { for (const k in P) { const q = P[k]; if (x > q[0] && x < q[1] && z > q[2] && z < q[3]) return true; } return false; };
        const topAt = (x, z) => { let top = 0; for (const p of mapPieces) { const b = p.bounds; if (b.min.y < 0.1 && x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z) top = Math.max(top, b.max.y); } return top; };
        // (samples sit off the 0.25 m grid every piece edge lies on)
        for (const k of ['aMainW', 'aMainE', 'court', 'midBotW', 'midBotV', 'midBotE', 'midTopW', 'midTopV', 'midTopE', 'bMainW', 'bMainE']) {
            const q = P[k], edge = [];
            for (let x = q[0] + 0.3; x < q[1]; x += 1) edge.push([x, q[2] - 0.2], [x, q[3] + 0.2]);
            for (let z = q[2] + 0.3; z < q[3]; z += 1) edge.push([q[0] - 0.2, z], [q[1] + 0.2, z]);
            for (const [x, z] of edge) {
                if (Math.abs(x) > 49.4 || Math.abs(z) > 49.4 || floorAt(x, z)) continue;
                const top = topAt(x, z);
                if (top < 6 && low.length < 4) low.push([k, x, z, top]);
            }
        }
        out.low = low;
        return out;
    });
    assert.equal(r.map, 'ascent');
    assert.ok(r.pieces >= 150 && r.pieces <= 250, `${r.pieces} map pieces`);
    assert.ok(r.lanePoints.every((n) => n > 30), `points in every lane ${r.lanePoints}`);
    assert.deepEqual(r.cross, [], 'no sightline from one lane into another');
    assert.ok(r.longest >= 38 && r.longest <= 47, `longest sightline ${r.longest} m ${JSON.stringify(r.pair)}`);
    assert.equal(r.thin, 0, 'no standing piece thinner than 0.5 m');
    assert.deepEqual(r.low, [], 'lane walls at least 6 m tall');
    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

test('Ascent sides and sites: attackers west, defenders east, A north, B south; 3-4 m chokepoints; enclosed 16 m sites with stairs to a raised spot; a thin wall is wallbangable', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(LANES);
    const r = await evaluate(() => {
        const L = mapLayout(), P = MAP_PRESETS.ascent.plan;
        const out = {
            spawns: [L.spawns.attack.x < -30, L.spawns.defend.x > 30],
            sites: [L.sites.A.z < -20, L.sites.B.z > 20],
            director: [tacticalDirector.spikeSites.A.pos.x, tacticalDirector.spikeSites.A.pos.z, tacticalDirector.spikeSites.B.pos.x, tacticalDirector.spikeSites.B.pos.z],
            layout: [L.sites.A.x, L.sites.A.z, L.sites.B.x, L.sites.B.z],
            zones: [tacticalRadar.getZoneName(L.sites.A.x, 0, L.sites.A.z), tacticalRadar.getZoneName(L.sites.B.x, 0, L.sites.B.z), tacticalRadar.getZoneName(0, 0, 11), tacticalRadar.getZoneName(-30, 0, -37), tacticalRadar.getZoneName(-30, 0, 37)]
        };
        // Each lane's narrowest passage: at every x, the widest open run across the lane
        // (eye height, 5 cm steps), then the smallest of those along the stretch
        const width = (x, z0, z1) => { let run = 0, best = 0; for (let z = z0 + 0.025; z < z1; z += 0.05) { if (__open(x, z)) { run += 0.05; if (run > best) best = run; } else run = 0; } return best; };
        let a = 99, m = 99, b = 99;
        for (let x = -24.1; x <= -16; x += 0.5) { a = Math.min(a, width(x, P.aMainE[2], P.aMainE[3])); m = Math.min(m, width(x, P.midBotE[2], P.midBotE[3])); b = Math.min(b, width(x, P.bMainE[2], P.bMainE[3])); }
        out.chokes = [a, m, b].map((v) => +v.toFixed(2));
        // Sites: about 16 x 16 m of floor
        out.siteSize = [P.aSite[1] - P.aSite[0], P.aSite[3] - P.aSite[2], P.bSite[1] - P.bSite[0], P.bSite[3] - P.bSite[2]];
        return out;
    });
    assert.deepEqual(r.spawns, [true, true], 'attackers west, defenders east');
    assert.deepEqual(r.sites, [true, true], 'A north, B south');
    assert.deepEqual(r.director, r.layout, 'the spike sites come from the map layout');
    assert.deepEqual(r.zones, ['A SITE', 'B SITE', 'MID COURTYARD', 'A MAIN', 'B MAIN']);
    for (const w of r.chokes) assert.ok(w >= 3 && w <= 4, `chokepoint ${w} m`);
    for (const s of r.siteSize) assert.ok(s >= 14 && s <= 18, `site ${s} m`);

    // The stairs on A climb to the raised spot (walk up them)
    await evaluate(() => {
        const cc = characterController;
        cc.reset();
        cc.position.set(9.5, cc.standHeight, -31.6);
        cc.prevSimPosition.copy(cc.position);
        cc.velocity.set(0, 0, 0);
        camera.rotation.set(0, 0, 0, 'YXZ');
        window.__walk = setInterval(() => { game.keys.w = true; }, 20);
    });
    await page.waitForFunction(() => characterController.position.z < -38.6, null, { timeout: 60000, polling: 50 });
    const up = await evaluate(() => { clearInterval(__walk); game.keys.w = false; const cc = characterController; return { y: cc.position.y - cc.standHeight, zone: tacticalRadar.getZoneName(cc.position.x, cc.position.y, cc.position.z) }; });
    assert.ok(up.y > 2.3, `standing on the raised spot (${up.y.toFixed(2)} m up)`);
    assert.equal(up.zone, 'A HEAVEN');

    // The thin wall between A link and A site: a rifle shot goes through it
    const bang = await evaluate(() => {
        window.updateEnemies = () => {};
        game.userSettings.headshotOnly = false;
        equipGun('vandal');
        game.activeWeapon = 'rifle';
        const e = enemyObjects.find((x) => x.isActive && !x.hit);
        e.health = 150; e.armor = 0;
        e.mesh.position.set(1.75, 0, -29); e.poseDirty = true; syncEnemyBroadphase(e);
        const cc = characterController;
        cc.position.set(1.75, cc.standHeight, -22);
        cc.prevSimPosition.copy(cc.position);
        camera.position.copy(cc.position);
        camera.lookAt(1.75, 1.25, -29);
        camera.updateMatrixWorld();
        const blocked = !agentSystem.hasWallLineOfSight(camera.position.clone(), new THREE.Vector3(1.75, 1.25, -29), 7);
        game.lastShot = 0; game.reloading = false; game.recoilHeat = 0; game.recoilAccumYaw = 0; game.recoilAccumPitch = 0;
        const w = game.weapons[game.activeWeapon]; w.ammo = w.maxAmmo;
        const h0 = e.health;
        shoot();
        return { blocked, dealt: h0 - e.health };
    });
    assert.equal(bang.blocked, true, 'the wall is in the way');
    assert.ok(bang.dealt > 0, `the shot goes through it (${bang.dealt} damage)`);
    await frames(2);
    assert.deepEqual(errors, []);
});

test('Ascent routes: both spawns reach both sites on clear walking routes; attackers arrive 1-2 s after defenders', { timeout: 240000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'low' });
    const r = await evaluate(() => {
        const L = mapLayout(), out = {};
        const route = (s, t) => {
            const path = navGrid.findPath(s.x, s.z, t.x, t.z);
            if (!path) return null;
            let clear = true, len = 0, prev = { x: s.x, z: s.z };
            for (const p of path) { if (!navGrid._clearLine(prev.x, prev.z, p.x, p.z)) clear = false; len += Math.hypot(p.x - prev.x, p.z - prev.z); prev = p; }
            const end = path[path.length - 1];
            return { clear, len, ends: end.x === t.x && end.z === t.z };
        };
        for (const k of ['A', 'B']) {
            const site = L.sites[k];
            const at = route(L.spawns.attack, site), df = route(L.spawns.defend, site);
            out[k] = { at, df, gap: at && df ? (at.len - df.len) / 6.75 : null };
        }
        // Every open cell is reachable from the attacker spawn
        navGrid.ensure();
        const N = navGrid.N, bl = navGrid.blocked, seen = new Uint8Array(N * N);
        const st = navGrid._cell(L.spawns.attack.x, L.spawns.attack.z), q = [st]; seen[st] = 1;
        while (q.length) { const c = q.pop(), ci = c % N, cj = (c / N) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue; const n = j * N + i; if (!bl[n] && !seen[n]) { seen[n] = 1; q.push(n); } } }
        let stray = 0; for (let c = 0; c < N * N; c++) if (!bl[c] && !seen[c]) stray++;
        out.stray = stray;
        return out;
    });
    for (const k of ['A', 'B']) {
        const s = r[k];
        assert.ok(s.at && s.at.clear && s.at.ends, `attackers reach ${k}`);
        assert.ok(s.df && s.df.clear && s.df.ends, `defenders reach ${k}`);
        assert.ok(s.gap >= 1 && s.gap <= 2, `attackers reach ${k} ${s.gap.toFixed(2)} s after defenders (${s.at.len.toFixed(1)} vs ${s.df.len.toFixed(1)} m)`);
    }
    assert.equal(r.stray, 0, 'no walled-off pocket');
    assert.deepEqual(errors, []);
});

// Runs the bots' own update at 60 Hz for up to maxSecs of game time, recording
// every bot's position each second; stops early when done() is true. The page
// clocks run on the simulated time meanwhile, so every bot timer (re-planning,
// line-of-sight checks, turning off a wall) fires as it would in play.
const SIM = () => {
    window.__sim = (maxSecs, done) => {
        const log = new Map(), dt = 1 / 60;
        const realPerf = performance.now.bind(performance), realDate = Date.now;
        const p0 = realPerf(), d0 = realDate();
        let el = 0;
        performance.now = () => p0 + el;
        Date.now = () => d0 + el;
        try {
            for (let k = 0; k < maxSecs * 60; k++) {
                game.health = 100; game.shield = 50;
                el += 1000 / 60;
                updateEnemies(p0 + el, dt);
                if (k % 60 === 0) {
                    for (const e of enemyObjects) {
                        if (!e.isActive || e.hit) continue;
                        if (!log.has(e)) log.set(e, []);
                        log.get(e).push([e.mesh.position.x, e.mesh.position.z, e.hasSight ? 1 : 0]);
                    }
                    if (done()) break;
                }
            }
        } finally {
            performance.now = realPerf;
            Date.now = realDate;
        }
        return log;
    };
    // A position inside a wall (bots are never pushed into one)
    window.__inWall = (x, z) => {
        for (const p of mapPieces) { const b = p.bounds; if (b.max.y <= 0.15 || b.min.y >= 2.1) continue; if (x > b.min.x + 0.05 && x < b.max.x - 0.05 && z > b.min.z + 0.05 && z < b.max.z - 0.05) return true; }
        return false;
    };
};

test('Ascent bots: attacking bots run from their spawn to either site without sticking', { timeout: 300000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(SIM);
    const runs = {};
    for (const key of ['A', 'B']) {
        await evaluate((key) => {
            tacticalDirector.setGameMode('match');
            game.botAbilityAI = false;
            matchMode.round = 6;                       // the second half: bots attack
            matchMode.startRound(performance.now());
            matchMode.plantSiteKey = key;
            matchMode.phaseEndsAt = performance.now();
        }, key);
        await page.waitForFunction(() => matchMode.phase === 'live', null, { timeout: 60000 });
        runs[key] = await evaluate(() => {
            // The player waits out of the way in the defender spawn
            const cc = characterController;
            cc.position.set(46, cc.standHeight, 6); cc.prevSimPosition.copy(cc.position);
            const goal = matchMode.botGoal();
            // On site: inside the site's room, or within 6 m of the plant spot (a bot
            // that gets there second waits a few metres behind the first)
            const room = MAP_PRESETS.ascent.plan[matchMode.plantSiteKey === 'A' ? 'aSite' : 'bSite'];
            const onSite = (x, z) => (x > room[0] + 0.5 && x < room[1] - 0.5 && z > room[2] + 0.5 && z < room[3] - 0.5) || Math.hypot(x - goal.x, z - goal.z) < 6;
            const bots = enemyObjects.filter((e) => e.isActive && !e.hit);
            const start = bots.map((e) => Math.hypot(e.mesh.position.x - goal.x, e.mesh.position.z - goal.z));
            const log = __sim(70, () => bots.every((e) => onSite(e.mesh.position.x, e.mesh.position.z)));
            const out = { side: matchMode.side, n: bots.length, start, end: [], on: [], stuck: [], walls: 0, secs: 0 };
            for (const e of bots) {
                const tr = log.get(e) || [];
                out.secs = Math.max(out.secs, tr.length);
                out.end.push([+e.mesh.position.x.toFixed(1), +e.mesh.position.z.toFixed(1), +Math.hypot(e.mesh.position.x - goal.x, e.mesh.position.z - goal.z).toFixed(1)]);
                out.on.push(onSite(e.mesh.position.x, e.mesh.position.z));
                for (const p of tr) if (__inWall(p[0], p[1])) out.walls++;
                // Stuck: under 1 m moved in 3 s while not yet on site
                for (let i = 3; i < tr.length; i++) {
                    if (!onSite(tr[i][0], tr[i][1]) && Math.hypot(tr[i][0] - tr[i - 3][0], tr[i][1] - tr[i - 3][1]) < 1) {
                        out.stuck.push([e.slot, e.archetype, i, tr[i][0].toFixed(1), tr[i][1].toFixed(1), tr.slice(Math.max(0, i - 6), i + 1).map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')]);
                        break;
                    }
                }
            }
            return out;
        });
    }
    for (const key of ['A', 'B']) {
        const r = runs[key];
        assert.equal(r.side, 'defend');
        assert.ok(r.n >= 2, `${r.n} attacking bots`);
        assert.ok(Math.min(...r.start) > 40, 'they start in their spawn');
        assert.ok(r.on.every(Boolean), `all reach site ${key} (bots at ${JSON.stringify(r.end)} after ${r.secs} s)`);
        assert.deepEqual(r.stuck, [], `site ${key}: no bot sticks ${JSON.stringify(r.stuck)}`);
        assert.equal(r.walls, 0, 'never inside a wall');
    }
    await frames(2);
    assert.deepEqual(errors, []);
});

test('Ascent bots: a bot hunting a player it cannot see goes round the lane wall instead of into it', { timeout: 300000 }, async () => {
    const { errors, frames, evaluate } = await boot({ quality: 'low' });
    await evaluate(SIM);
    const r = await evaluate(() => {
        tacticalEnhancements.toggleWingmanAI(false);
        game.botAbilityAI = false;
        const bots = enemyObjects.filter((e) => e.isActive && !e.hit);
        const e = bots[0];
        for (const o of bots) if (o !== e) { o.isActive = false; o.hit = true; if (o.broadKeys) actorBroadphase.remove(o); }
        // Player in A Main; the bot 29 m away in mid, behind a solid wall
        const cc = characterController;
        cc.position.set(-30, cc.standHeight, -37); cc.prevSimPosition.copy(cc.position);
        window.updateGameState = () => {};
        e.mesh.position.set(-30, 0, -8); e.position.x = -30; e.position.z = -8;
        e.archetype = 'standard'; e.archetypeDef = ENEMY_ARCHETYPES.standard;
        enemyTactics.reset(e); e.poseDirty = true; syncEnemyBroadphase(e);
        const blocked = !agentSystem.hasWallLineOfSight(new THREE.Vector3(-30, 1.4, -8), new THREE.Vector3(-30, 1.5, -37), 29);
        const near = () => e.hasSight || Math.hypot(e.mesh.position.x + 30, e.mesh.position.z + 37) < 10;
        const log = __sim(60, near);
        const tr = log.get(e) || [];
        const out = { blocked, secs: tr.length, reached: near(), sight: tr.some((p) => p[2]), walls: tr.filter((p) => __inWall(p[0], p[1])).length, stuck: null, path: tr.filter((p, i) => i % 5 === 0).map((p) => [+p[0].toFixed(1), +p[1].toFixed(1)]) };
        for (let i = 3; i < tr.length; i++) {
            const far = Math.hypot(tr[i][0] + 30, tr[i][1] + 37) > 10;
            if (far && !tr[i][2] && Math.hypot(tr[i][0] - tr[i - 3][0], tr[i][1] - tr[i - 3][1]) < 1) { out.stuck = [i, tr[i][0], tr[i][1]]; break; }
        }
        // It went round by the attacker spawn (west of mid), not through the wall
        out.wentWest = tr.some((p) => p[0] < -38);
        return out;
    });
    assert.equal(r.blocked, true, 'no line of sight at the start');
    assert.ok(r.reached, `the bot finds the player (${r.secs} s, path ${JSON.stringify(r.path)})`);
    assert.equal(r.stuck, null, 'never stuck against a wall');
    assert.equal(r.walls, 0, 'never inside a wall');
    assert.ok(r.wentWest, 'it took the way round through the spawn');
    await frames(2);
    assert.deepEqual(errors, []);
});

test('Ascent: all 8 modes start cleanly, with the player and bots on open floor', { timeout: 400000 }, async () => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
    const [baseline] = await programState(page);
    const out = {};
    for (const mode of ['wave', 'match', 'ranked', 'deathmatch', 'spikerush', 'retake', 'range', 'aim']) {
        await evaluate((m) => tacticalDirector.setGameMode(m), mode);
        await frames(4);
        out[mode] = await evaluate(() => {
            const embedded = (x, z, y0, y1, r) => {
                for (const p of mapPieces) { const b = p.bounds; if (b.max.y <= y0 + 0.2 || b.min.y >= y1) continue; if (x > b.min.x - r && x < b.max.x + r && z > b.min.z - r && z < b.max.z + r) return true; }
                return false;
            };
            const cc = characterController;
            const bots = enemyObjects.filter((e) => e.isActive && !e.hit);
            return {
                map: game.mapPreset, mode: game.gameMode,
                player: embedded(cc.position.x, cc.position.z, cc.position.y - cc.standHeight, cc.position.y, 0.25),
                inArena: Math.abs(cc.position.x) < 49 && Math.abs(cc.position.z) < 49,
                bots: bots.filter((e) => embedded(e.mesh.position.x, e.mesh.position.z, 0, 1.8, 0.3)).map((e) => [e.mesh.position.x.toFixed(1), e.mesh.position.z.toFixed(1)]),
                n: bots.length
            };
        });
    }
    for (const [mode, r] of Object.entries(out)) {
        assert.equal(r.map, 'ascent', mode);
        assert.equal(r.player, false, `${mode}: the player starts on open floor`);
        assert.equal(r.inArena, true, mode);
        assert.deepEqual(r.bots, [], `${mode}: no bot starts inside a wall`);
    }
    assert.ok(out.match.n >= 2 && out.wave.n >= 2 && out.retake.n >= 2, 'bots in the modes that have them');
    const [programs, watermark] = await programState(page);
    assert.equal(programs, baseline, 'no shader compiles');
    assert.equal(programs, watermark);
    assert.deepEqual(errors, []);
});

// The six other maps, read the same way from V1.7 and from this build
const FINGERPRINT = async (evaluate, frames) => {
    const out = {};
    for (const map of ['bind', 'haven', 'icebox', 'lotus', 'split', 'skyline']) {
        await evaluate((m) => tacticalDirector.cycleMapPreset(m), map);
        await frames(2);
        out[map] = await evaluate(() => {
            let h = 2166136261 >>> 0;
            const add = (v) => { const s = String(Math.round(v * 100)) + ','; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
            for (const p of mapPieces) { const b = p.bounds; add(b.min.x); add(b.min.y); add(b.min.z); add(b.max.x); add(b.max.y); add(b.max.z); }
            let zones = '';
            for (let z = -45; z <= 45; z += 6) for (let x = -45; x <= 45; x += 6) zones += tacticalRadar.getZoneName(x, 1.7, z) + '|';
            let zh = 0; for (let i = 0; i < zones.length; i++) zh = (Math.imul(zh, 31) + zones.charCodeAt(i)) >>> 0;
            const S = tacticalDirector.spikeSites;
            const spawn = typeof matchSpawn === 'function' ? [matchSpawn('attack'), matchSpawn('defend')] : [MATCH_SPAWN.attack, MATCH_SPAWN.defend];
            return {
                pieces: mapPieces.length, hash: h, zones: zh,
                sites: [S.A.pos.x, S.A.pos.z, S.B.pos.x, S.B.pos.z],
                spawns: spawn.map((s) => [s.x, s.z]),
                orbs: (tacticalDirector.ultOrbs || []).map((o) => [o.group.position.x, o.group.position.z]),
                targets: targetObjects.filter((t) => t.active && !t.hit && !t.moveData).map((t) => [t.initialPosition.x, t.initialPosition.y, t.initialPosition.z])
            };
        });
    }
    return out;
};

test('the six other maps are exactly as in V1.7: pieces, sites, spawns, ult orbs, callout zones, practice targets', { timeout: 400000 }, async () => {
    const old = await boot({ quality: 'low', file: '(V1.7) valorant-fps.html' });
    const before = await FINGERPRINT(old.evaluate, old.frames);
    assert.deepEqual(old.errors, []);
    const cur = await boot({ quality: 'low' });
    const now = await FINGERPRINT(cur.evaluate, cur.frames);
    for (const map of Object.keys(before)) {
        assert.ok(before[map].pieces > 10, `${map} has pieces`);
        assert.deepEqual(now[map], before[map], `${map} unchanged`);
    }
    assert.deepEqual(cur.errors, []);
});

// V1.8 Part 3 regression run: a bot pressed into the corner where a site's raised
// platform meets the stairs up to it was pushed back and forth between the two boxes
// and stayed wedged inside the platform (Spike Rush); it is now stepped out
test('Ascent: a bot pushed into the platform and stairs corner of a site is freed, not wedged inside', { timeout: 300000 }, async () => {
    const { errors, evaluate } = await boot({ quality: 'low' });
    const r = await evaluate(() => {
        const inside = (p, r) => mapPieces.some((pc) => { const b = pc.bounds; return b.max.y > p.y + 0.15 && b.min.y < p.y + 2.1 && p.x > b.min.x - r + 0.02 && p.x < b.max.x + r - 0.02 && p.z > b.min.z - r + 0.02 && p.z < b.max.z + r - 0.02; });
        const out = [];
        for (const [x, z] of [[8.76, -38.68], [8.76, 38.68], [9.5, -38.2], [10.5, 38.4]]) {
            const p = new THREE.Vector3(x, 0, z);
            for (let i = 0; i < 3; i++) resolveEnemyMapCollision(p, 0.68);
            out.push({ at: [x, z], to: [+p.x.toFixed(2), +p.z.toFixed(2)], inside: inside(p, 0.68), moved: Math.hypot(p.x - x, p.z - z) });
        }
        return out;
    });
    for (const c of r) {
        assert.equal(c.inside, false, `freed from ${c.at} (now at ${c.to})`);
        assert.ok(c.moved < 6, `stepped out nearby (${c.moved.toFixed(2)} m)`);
    }
    assert.deepEqual(errors, []);
});
