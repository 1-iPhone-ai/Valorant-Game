'use strict';
// V2.1: the checks every rebuilt map gets (Bind and Haven first, then Icebox, Lotus, Split and
// Skyline), on the game's own geometry: its own layout in Ascent's format, the design rules, the
// balance against Ascent, every layout spot open and reachable, bots routing, planting and
// defusing, every mode, callouts, the minimap and High Detail props.
//
// mapSuite(label, MAPS) registers the tests for the maps in MAPS. Per map:
//   keys        the spike sites, ['A', 'B'] or ['A', 'B', 'C'] (A north; B south or centre; C south)
//   lanes       lane interiors (plan rects, cut short of the spawns and the site doors, where lanes
//               may meet) and meet, the lane pairs that may see each other
//   siteRects   each site's plan rect; entrances, a point in each doorway
//   chokes      [axis, at, plan rect]: the lane's narrowest run across, 3-4 m
//   heaven      a walk up the stairs to the raised spot: from, yaw, axis and dir ('x', 1 by default)
//               and past (or x), and the callout up there
//   zones       callouts at known points
//   smallest, nearest   optional: the site that is smallest / nearest the defenders
//   siteCallouts        optional: each site's callout, in key order ('A SITE', 'B SITE'... by default)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, programState } = require('./harness');

// Ascent's route lengths (navGrid, both spawns to each site), the balance reference
const ASCENT = { A: { atk: 88.7, def: 78.4 }, B: { atk: 78.8, def: 68.6 } };

const HELPERS = () => {
    window.__open = (x, z, y = 1.6) => {
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

module.exports = function mapSuite(label, MAPS) {
    test(`${label} layouts: own plan, layout and callouts; no sightline between lanes; walls at least 0.5 m thick; lane walls 6 m tall`, { timeout: 600000 }, async () => {
        const { page, errors, evaluate } = await boot({ quality: 'low' });
        await evaluate(HELPERS);
        const out = {};
        for (const [map, spec] of Object.entries(MAPS)) {
            out[map] = await evaluate(([map, lanes, meet]) => {
                rebuildMapPreset(map);
                const pre = MAP_PRESETS[map], P = pre.plan, L = mapLayout();
                const r = { pieces: mapPieces.length, ownLayout: L === pre.layout && L !== MAP_PRESETS.ascent.layout && !!pre.plan && typeof L.zoneName === 'function' };
                // Every field Ascent's layout has
                r.missing = Object.keys(MAP_PRESETS.ascent.layout).filter((k) => k !== '_siteKeys' && k !== '_propSpots' && !(k in L));
                // Lane points every 1.5 m on open floor
                const inR = (q, x, z, lim) => x > q[0] + 0.6 && x < q[1] - 0.6 && z > q[2] + 0.6 && z < q[3] - 0.6 &&
                    (!lim || ((lim.zMax === undefined || z < lim.zMax) && (lim.zMin === undefined || z > lim.zMin) && (lim.xMax === undefined || x < lim.xMax) && (lim.xMin === undefined || x > lim.xMin)));
                const pts = {};
                for (const name in lanes) {
                    pts[name] = [];
                    for (let z = -48.75; z <= 48.75; z += 1.5) for (let x = -48.75; x <= 48.75; x += 1.5) {
                        if (!__open(x, z)) continue;
                        if (lanes[name].some(([k, lim]) => inR(P[k], x, z, lim))) pts[name].push([x, z]);
                    }
                }
                r.lanePoints = Object.fromEntries(Object.entries(pts).map(([k, v]) => [k, v.length]));
                const may = (a, b) => meet.some((m) => (m[0] === a && m[1] === b) || (m[0] === b && m[1] === a));
                const names = Object.keys(pts), cross = [];
                for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
                    if (may(names[i], names[j])) continue;
                    for (const p of pts[names[i]]) for (const q of pts[names[j]]) {
                        if (__sees(p[0], p[1], q[0], q[1], 1.6) && cross.length < 6) cross.push([names[i], names[j], p, q]);
                    }
                }
                r.cross = cross;
                r.thin = mapPieces.filter((p) => p.bounds.min.y < 0.1 && p.bounds.max.y >= 2 &&
                    Math.min(p.bounds.max.x - p.bounds.min.x, p.bounds.max.z - p.bounds.min.z) < 0.5).length;
                // Lane walls: every point just outside a lane's floor is more floor or a 6 m+ building
                const floorAt = (x, z) => { for (const k in P) { const q = P[k]; if (x > q[0] && x < q[1] && z > q[2] && z < q[3]) return true; } return false; };
                const topAt = (x, z) => { let top = 0; for (const p of mapPieces) { const b = p.bounds; if (b.min.y < 0.1 && x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z) top = Math.max(top, b.max.y); } return top; };
                const low = [];
                for (const k in P) {
                    const q = P[k];
                    const edge = [];
                    for (let x = q[0] + 0.3; x < q[1]; x += 1) edge.push([x, q[2] - 0.2], [x, q[3] + 0.2]);
                    for (let z = q[2] + 0.3; z < q[3]; z += 1) edge.push([q[0] - 0.2, z], [q[1] + 0.2, z]);
                    for (const [x, z] of edge) {
                        if (Math.abs(x) > 49.4 || Math.abs(z) > 49.4 || floorAt(x, z)) continue;
                        const top = topAt(x, z);
                        if (top < 6 && low.length < 4) low.push([k, x, z, top]);
                    }
                }
                r.low = low;
                return r;
            }, [map, spec.lanes, spec.meet]);
        }
        for (const [map, r] of Object.entries(out)) {
            assert.equal(r.ownLayout, true, `${map}: its own plan and layout`);
            assert.deepEqual(r.missing, [], `${map}: every field Ascent's layout has`);
            assert.ok(r.pieces >= 100 && r.pieces <= 250, `${map}: ${r.pieces} map pieces`);
            for (const [lane, n] of Object.entries(r.lanePoints)) assert.ok(n > 10, `${map}: points in lane ${lane} (${n})`);
            assert.deepEqual(r.cross, [], `${map}: no sightline from one lane into another`);
            assert.equal(r.thin, 0, `${map}: no standing piece thinner than 0.5 m`);
            assert.deepEqual(r.low, [], `${map}: lane walls at least 6 m tall`);
        }
        const [programs, watermark] = await programState(page);
        assert.equal(programs, watermark);
        assert.deepEqual(errors, []);
    });

    test(`${label} sites: the sites and spawns face the right way; 3-4 m chokepoints; no spot on a site sees every entrance; the heaven stairs climb to a raised spot`, { timeout: 600000 }, async () => {
        const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
        await evaluate(HELPERS);
        for (const [map, spec] of Object.entries(MAPS)) {
            const r = await evaluate(([map, spec]) => {
                rebuildMapPreset(map);
                const L = mapLayout(), P = MAP_PRESETS[map].plan, S = tacticalDirector.spikeSites;
                const keys = siteKeys(L);
                const out = {
                    keys,
                    spawns: [L.spawns.attack.x < -30, L.spawns.defend.x > 30],
                    director: keys.map((k) => [S[k].pos.x, S[k].pos.z]),
                    layout: keys.map((k) => [L.sites[k].x, L.sites[k].z]),
                    zones: spec.zones.map((z) => [z[2], tacticalRadar.getZoneName(z[0], 1.7, z[1])])
                };
                // Each choke: across its lane, the widest open run at eye height (5 cm steps). An 'x'
                // choke is at that x in a lane running along x (scan z); a 'z' choke the other way
                out.chokes = spec.chokes.map(([ax, at, k]) => {
                    const q = P[k];
                    const [v0, v1] = ax === 'x' ? [q[2], q[3]] : [q[0], q[1]];
                    let run = 0, best = 0;
                    for (let v = v0 + 0.025; v < v1; v += 0.05) { if (ax === 'x' ? __open(at, v) : __open(v, at)) { run += 0.05; if (run > best) best = run; } else run = 0; }
                    return [k, +best.toFixed(2)];
                });
                // No standing spot on a site (0.5 m grid) can see every entrance (eye height)
                out.seenAll = {};
                out.sizes = {};
                for (const k of keys) {
                    const q = P[spec.siteRects[k]], ents = spec.entrances[k];
                    out.sizes[k] = [q[1] - q[0], q[3] - q[2]];
                    let n = 0, any = null;
                    for (let x = q[0] + 0.25; x < q[1]; x += 0.5) for (let z = q[2] + 0.25; z < q[3]; z += 0.5) {
                        if (!__open(x, z, 0.5)) continue;
                        if (ents.every((e) => __sees(e[0], e[1], x, z, 1.6))) { n++; if (!any) any = [x, z]; }
                    }
                    out.seenAll[k] = [n, any];
                }
                return out;
            }, [map, { zones: spec.zones, chokes: spec.chokes, siteRects: spec.siteRects, entrances: spec.entrances }]);
            assert.deepEqual(r.spawns, [true, true], `${map}: attackers west, defenders east`);
            assert.deepEqual(r.director, r.layout, `${map}: the spike sites come from the layout`);
            assert.deepEqual(r.keys, spec.keys, `${map}: sites ${spec.keys.join()}`);
            if (spec.keys.length === 2) assert.ok(r.layout[0][1] < -20 && r.layout[1][1] > 20, `${map}: A north, B south`);
            else assert.ok(r.layout[0][1] < -20 && Math.abs(r.layout[1][1]) < 10 && r.layout[2][1] > 20, `${map}: A north, B centre, C south`);
            if (spec.smallest) {
                const area = (s) => s[0] * s[1];
                for (const k of r.keys) if (k !== spec.smallest) assert.ok(area(r.sizes[spec.smallest]) < area(r.sizes[k]), `${map}: ${spec.smallest} is the smallest site`);
            }
            for (const [want, got] of r.zones) assert.equal(got, want, `${map}: callout`);
            for (const [k, w] of r.chokes) assert.ok(w >= 3 && w <= 4.05, `${map}: chokepoint in ${k} is ${w} m`);
            for (const k of r.keys) assert.equal(r.seenAll[k][0], 0, `${map}: a spot on site ${k} sees every entrance (${JSON.stringify(r.seenAll[k][1])})`);
            // The stairs climb to the heaven spot (walk up them)
            await evaluate(([fx, fz, yaw]) => {
                const cc = characterController;
                cc.reset();
                cc.position.set(fx, cc.standHeight, fz);
                cc.prevSimPosition.copy(cc.position);
                cc.velocity.set(0, 0, 0);
                camera.rotation.set(0, yaw, 0, 'YXZ');
                window.__walk = setInterval(() => { game.keys.w = true; }, 20);
            }, [spec.heaven.from[0], spec.heaven.from[1], spec.heaven.yaw]);
            const h = spec.heaven, until = [h.axis || 'x', h.dir || 1, h.past !== undefined ? h.past : h.x];
            await page.waitForFunction(([axis, dir, past]) => (characterController.position[axis] - past) * dir > 0, until, { timeout: 60000, polling: 50 });
            const up = await evaluate(() => { clearInterval(__walk); game.keys.w = false; const cc = characterController; return { y: cc.position.y - cc.standHeight, zone: tacticalRadar.getZoneName(cc.position.x, cc.position.y, cc.position.z) }; });
            assert.ok(up.y > 2.3, `${map}: standing on the raised spot (${up.y.toFixed(2)} m up)`);
            assert.equal(up.zone, spec.heaven.zone);
        }
        await frames(2);
        assert.deepEqual(errors, []);
    });

    test(`${label} routes: both spawns reach every site on clear walking routes, within 20% of Ascent's, defenders 1-2 s ahead; no walled-off pocket; every layout spot is open and reachable`, { timeout: 600000 }, async () => {
        const { errors, evaluate } = await boot({ quality: 'low' });
        for (const map of Object.keys(MAPS)) {
            const r = await evaluate((map) => {
                rebuildMapPreset(map);
                const L = mapLayout(), out = { sites: {} };
                const route = (s, t) => {
                    const path = navGrid.findPath(s.x, s.z, t.x, t.z);
                    if (!path) return null;
                    let clear = true, len = 0, prev = { x: s.x, z: s.z };
                    for (const p of path) { if (!navGrid._clearLine(prev.x, prev.z, p.x, p.z)) clear = false; len += Math.hypot(p.x - prev.x, p.z - prev.z); prev = p; }
                    const end = path[path.length - 1];
                    return { clear, len, ends: end.x === t.x && end.z === t.z };
                };
                for (const k of siteKeys(L)) out.sites[k] = { at: route(L.spawns.attack, L.sites[k]), df: route(L.spawns.defend, L.sites[k]) };
                navGrid.ensure();
                const N = navGrid.N, bl = navGrid.blocked, seen = new Uint8Array(N * N);
                const st = navGrid._cell(L.spawns.attack.x, L.spawns.attack.z), q = [st]; seen[st] = 1;
                while (q.length) { const c = q.pop(), ci = c % N, cj = (c / N) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue; const n = j * N + i; if (!bl[n] && !seen[n]) { seen[n] = 1; q.push(n); } } }
                let stray = 0; for (let c = 0; c < N * N; c++) if (!bl[c] && !seen[c]) stray++;
                out.stray = stray;
                // Every layout spot: an open cell, not moved by the bots' collision, reachable from both spawns
                const a = L.spawns.attack, d = L.spawns.defend, bad = [];
                const check = (name, x, z) => {
                    const blocked = navGrid.blocked[navGrid._cell(x, z)];
                    const moved = resolveEnemyMapCollision(new THREE.Vector3(x, 0, z), 0.5, true);
                    if (blocked || moved || navGrid.routeLength(a.x, a.z, x, z) < 0 || navGrid.routeLength(d.x, d.z, x, z) < 0) bad.push(name + ' ' + x + ',' + z);
                };
                check('attack spawn', a.x, a.z); check('defend spawn', d.x, d.z); check('start', L.start.x, L.start.z); check('bootStart', L.bootStart.x, L.bootStart.z);
                L.botSpawns.concat(L.botSpawnsLow, L.respawnSpots).forEach((p, i) => check('spot' + i, p[0], p[1]));
                L.orbs.forEach((o) => check(o.name, o.x, o.z));
                const S = {}; for (const k of siteKeys(L)) S[k] = L.sites[k];
                L.matchDefend(S).forEach((p, i) => check('defend' + i, p[0], p[1]));
                L.matchAttack(a).forEach((p, i) => check('attack' + i, p[0], p[1]));
                for (const k in L.retake) { check('retake ' + k, L.retake[k].player.x, L.retake[k].player.z); L.retake[k].guards.forEach((g, i) => check('guard ' + k + i, g[0], g[1])); }
                check('range', L.range.player.x, L.range.player.z);
                for (const x of L.range.lanesX) for (const z of L.range.lanesZ) check('lane ' + x + ',' + z, x, z);
                check('aim', L.aim.x, L.aim.z);
                for (const t of (L.teleporters || [])) { check('teleporter', t.from.x, t.from.z); check('teleporter exit', t.to.x, t.to.z); }
                out.bad = bad;
                out.targets = L.targetSpots.filter((t) => targetSpotBlocked(t[0], t[1], t[2])).length;
                return out;
            }, map);
            for (const [k, s] of Object.entries(r.sites)) {
                assert.ok(s.at && s.at.clear && s.at.ends, `${map}: attackers reach ${k}`);
                assert.ok(s.df && s.df.clear && s.df.ends, `${map}: defenders reach ${k}`);
                const gap = (s.at.len - s.df.len) / 6.75;
                assert.ok(gap >= 1 && gap <= 2, `${map}: attackers reach ${k} ${gap.toFixed(2)} s after defenders (${s.at.len.toFixed(1)} vs ${s.df.len.toFixed(1)} m)`);
                // Within 20% of Ascent's (Haven's B and C against Ascent's B)
                const ref = ASCENT[k === 'A' ? 'A' : 'B'];
                assert.ok(Math.abs(s.at.len / ref.atk - 1) <= 0.2, `${map}: attackers to ${k} ${s.at.len.toFixed(1)} m vs Ascent ${ref.atk}`);
                assert.ok(Math.abs(s.df.len / ref.def - 1) <= 0.2, `${map}: defenders to ${k} ${s.df.len.toFixed(1)} m vs Ascent ${ref.def}`);
            }
            if (MAPS[map].nearest) {
                const n = MAPS[map].nearest;
                for (const k of Object.keys(r.sites)) if (k !== n) assert.ok(r.sites[n].df.len < r.sites[k].df.len, `${map}: ${n} is nearest the defenders`);
            }
            assert.equal(r.stray, 0, `${map}: no walled-off pocket`);
            assert.deepEqual(r.bad, [], `${map}: every layout spot is open and reachable`);
            assert.equal(r.targets, 0, `${map}: practice targets clear of walls`);
        }
        assert.deepEqual(errors, []);
    });

    // The bots' own update at 60 Hz for up to maxSecs of game time (as in the Ascent tests)
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
                            log.get(e).push([e.mesh.position.x, e.mesh.position.z]);
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
        window.__inWall = (x, z) => {
            for (const p of mapPieces) { const b = p.bounds; if (b.max.y <= 0.15 || b.min.y >= 2.1) continue; if (x > b.min.x + 0.05 && x < b.max.x - 0.05 && z > b.min.z + 0.05 && z < b.max.z - 0.05) return true; }
            return false;
        };
    };

    test(`${label} bots: attacking bots run from their spawn to every site without sticking`, { timeout: 900000 }, async () => {
        const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
        await evaluate(SIM);
        for (const map of Object.keys(MAPS)) {
            const keys = await evaluate((map) => { rebuildMapPreset(map); return siteKeys(mapLayout()); }, map);
            for (const key of keys) {
                await evaluate((key) => {
                    tacticalDirector.setGameMode('match');
                    game.botAbilityAI = false;
                    matchMode.round = 6;                       // the second half: bots attack
                    matchMode.startRound(performance.now());
                    matchMode.plantSiteKey = key;
                    matchMode.phaseEndsAt = performance.now();
                }, key);
                await page.waitForFunction(() => matchMode.phase === 'live', null, { timeout: 60000 });
                const r = await evaluate(([map, siteRects]) => {
                    const cc = characterController;
                    const d = mapLayout().spawns.defend;
                    cc.position.set(d.x + 3, cc.standHeight, d.z - 6); cc.prevSimPosition.copy(cc.position);
                    const goal = matchMode.botGoal();
                    const room = MAP_PRESETS[map].plan[siteRects[matchMode.plantSiteKey]];
                    const onSite = (x, z) => (x > room[0] + 0.5 && x < room[1] - 0.5 && z > room[2] + 0.5 && z < room[3] - 0.5) || Math.hypot(x - goal.x, z - goal.z) < 6;
                    const bots = enemyObjects.filter((e) => e.isActive && !e.hit);
                    const log = __sim(80, () => bots.every((e) => onSite(e.mesh.position.x, e.mesh.position.z)));
                    const out = { side: matchMode.side, n: bots.length, end: [], on: [], stuck: [], walls: 0 };
                    for (const e of bots) {
                        const tr = log.get(e) || [];
                        out.end.push([+e.mesh.position.x.toFixed(1), +e.mesh.position.z.toFixed(1)]);
                        out.on.push(onSite(e.mesh.position.x, e.mesh.position.z));
                        for (const p of tr) if (__inWall(p[0], p[1])) out.walls++;
                        for (let i = 3; i < tr.length; i++) {
                            if (!onSite(tr[i][0], tr[i][1]) && Math.hypot(tr[i][0] - tr[i - 3][0], tr[i][1] - tr[i - 3][1]) < 1) { out.stuck.push([e.slot, i, tr[i][0].toFixed(1), tr[i][1].toFixed(1)]); break; }
                        }
                    }
                    return out;
                }, [map, MAPS[map].siteRects]);
                assert.equal(r.side, 'defend');
                assert.ok(r.n >= 2, `${map} ${key}: ${r.n} attacking bots`);
                assert.ok(r.on.every(Boolean), `${map}: all reach site ${key} (bots at ${JSON.stringify(r.end)})`);
                assert.deepEqual(r.stuck, [], `${map} ${key}: no bot sticks`);
                assert.equal(r.walls, 0, `${map} ${key}: never inside a wall`);
            }
        }
        await frames(2);
        assert.deepEqual(errors, []);
    });

    // The game's own Match and spike updates as well as the bots', at 60 Hz of simulated time
    const SIM_MATCH = () => {
        window.__simMatch = (maxSecs, done) => {
            const dt = 1 / 60, realPerf = performance.now.bind(performance), realDate = Date.now;
            const p0 = realPerf(), d0 = realDate();
            let el = 0;
            performance.now = () => p0 + el;
            Date.now = () => d0 + el;
            try {
                for (let k = 0; k < maxSecs * 60; k++) {
                    game.health = 100; game.shield = 50; game.isDead = false;
                    el += 1000 / 60;
                    const now = p0 + el;
                    updateEnemies(now, dt);
                    matchMode.update(dt, now);
                    tacticalDirector.updateSpikeSystem(dt, now);
                    if (k % 30 === 0 && done()) return el / 1000;
                }
            } finally {
                performance.now = realPerf;
                Date.now = realDate;
            }
            return -1;
        };
    };

    test(`${label} bots: attacking bots plant at every site; defending bots defuse at every site`, { timeout: 900000 }, async () => {
        const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
        await evaluate(SIM_MATCH);
        for (const map of Object.keys(MAPS)) {
            const keys = await evaluate((map) => { rebuildMapPreset(map); return siteKeys(mapLayout()); }, map);
            for (const key of keys) {
                // Bots attack (the second half): they walk to the site and plant
                await evaluate((key) => {
                    tacticalDirector.setGameMode('match');
                    game.botAbilityAI = false;
                    matchMode.round = 6;
                    matchMode.startRound(performance.now());
                    matchMode.plantSiteKey = key;
                    matchMode.phaseEndsAt = performance.now();
                }, key);
                await page.waitForFunction(() => matchMode.phase === 'live', null, { timeout: 60000 });
                const plant = await evaluate(() => {
                    const cc = characterController, d = mapLayout().spawns.defend;
                    cc.position.set(d.x + 3, cc.standHeight, d.z - 6); cc.prevSimPosition.copy(cc.position);
                    const secs = __simMatch(100, () => tacticalDirector.spikeState === 'planted');
                    return { secs, state: tacticalDirector.spikeState, site: tacticalDirector.activeSpikeSiteKey, side: matchMode.side };
                });
                assert.equal(plant.side, 'defend');
                assert.equal(plant.state, 'planted', `${map}: the bots plant at ${key}`);
                assert.equal(plant.site, key, `${map}: at site ${key}`);
                // The player plants at the site; the defending bots go to the spike and defuse it
                await evaluate(() => {
                    tacticalDirector.setGameMode('match');
                    game.botAbilityAI = false;
                    matchMode.round = 0;
                    matchMode.startRound(performance.now());
                    matchMode.phaseEndsAt = performance.now();
                });
                await page.waitForFunction(() => matchMode.phase === 'live', null, { timeout: 60000 });
                const defuse = await evaluate((key) => {
                    const cc = characterController, a = mapLayout().spawns.attack;
                    cc.position.set(a.x, cc.standHeight, a.z + 6); cc.prevSimPosition.copy(cc.position);
                    const td = tacticalDirector;
                    td.completeSpikePlant(performance.now(), key);
                    let defused = false;
                    const real = matchMode.onSpike;
                    matchMode.onSpike = function (what) { if (what === 'botDefused') defused = true; return real.apply(this, arguments); };
                    const secs = __simMatch(100, () => defused || matchMode.phase !== 'live');
                    matchMode.onSpike = real;
                    return { secs, defused, side: matchMode.side, site: td.activeSpikeSiteKey };
                }, key);
                assert.equal(defuse.side, 'attack');
                assert.equal(defuse.site, key);
                assert.equal(defuse.defused, true, `${map}: the bots defuse at ${key} (${defuse.secs} s)`);
            }
        }
        await evaluate(() => tacticalDirector.setGameMode('wave'));
        await frames(2);
        assert.deepEqual(errors, []);
    });

    test(`${label}: all 8 modes start cleanly, Retake at every site, with the player and bots on open floor`, { timeout: 900000 }, async () => {
        const { page, errors, frames, evaluate } = await boot({ quality: 'low' });
        const out = {};
        for (const map of Object.keys(MAPS)) {
            await evaluate((m) => { tacticalDirector.setGameMode('wave'); rebuildMapPreset(m); }, map);
            const keys = await evaluate(() => siteKeys(mapLayout()));
            const runs = ['wave', 'match', 'ranked', 'deathmatch', 'spikerush', 'range', 'aim'].map((m) => [m, null]).concat(keys.map((k, i) => ['retake', i + 1]));
            for (const [mode, round] of runs) {
                await evaluate(([m, round]) => { if (round) game.roundNumber = round; tacticalDirector.setGameMode(m); }, [mode, round]);
                await frames(4);
                const run = map + ' ' + mode + (round ? ' ' + round : '');
                out[run] = await evaluate(() => {
                    const embedded = (x, z, y0, y1, r) => {
                        for (const p of mapPieces) { const b = p.bounds; if (b.max.y <= y0 + 0.2 || b.min.y >= y1) continue; if (x > b.min.x - r && x < b.max.x + r && z > b.min.z - r && z < b.max.z + r) return true; }
                        return false;
                    };
                    const cc = characterController;
                    const bots = enemyObjects.filter((e) => e.isActive && !e.hit);
                    return {
                        map: game.mapPreset, mode: game.gameMode, site: tacticalDirector.activeSpikeSiteKey,
                        player: embedded(cc.position.x, cc.position.z, cc.position.y - cc.standHeight, cc.position.y, 0.25),
                        bots: bots.filter((e) => embedded(e.mesh.position.x, e.mesh.position.z, 0, 1.8, 0.3)).map((e) => [e.mesh.position.x.toFixed(1), e.mesh.position.z.toFixed(1)]),
                        n: bots.length
                    };
                });
                // ...and through one whole turn of the patrol clock: a bot far from the player walks a 5 m
                // circle round its spot, and the look above only sees one point of it (96 steps, no shots)
                out[run].swept = await evaluate(() => {
                    const embedded = (x, z, r) => {
                        for (const p of mapPieces) { const b = p.bounds; if (b.max.y <= 0.2 || b.min.y >= 1.8) continue; if (x > b.min.x - r && x < b.max.x + r && z > b.min.z - r && z < b.max.z + r) return true; }
                        return false;
                    };
                    const shoot = enemyShoot;
                    enemyShoot = () => {};
                    const turn = Math.PI * 2 / 0.0005, t0 = performance.now(), hits = new Map();
                    for (let k = 0; k < 96; k++) {
                        updateEnemies(t0 + k * turn / 96, 1 / 60);
                        for (const e of enemyObjects) {
                            if (!e.isActive || e.hit || !embedded(e.mesh.position.x, e.mesh.position.z, 0.3)) continue;
                            const spot = e.position.x.toFixed(1) + ',' + e.position.z.toFixed(1);
                            if (!hits.has(spot)) hits.set(spot, [spot, e.mesh.position.x.toFixed(1), e.mesh.position.z.toFixed(1)]);
                        }
                    }
                    enemyShoot = shoot;
                    return [...hits.values()];
                });
            }
            await evaluate(() => tacticalDirector.setGameMode('wave'));
        }
        for (const [run, r] of Object.entries(out)) {
            assert.equal(r.player, false, `${run}: the player starts on open floor`);
            assert.deepEqual(r.bots, [], `${run}: no bot starts inside a wall`);
            assert.deepEqual(r.swept, [], `${run}: no bot ends a tick inside a wall over a whole patrol circle (spot, where)`);
        }
        for (const map of Object.keys(MAPS)) {
            assert.ok(out[map + ' match'].n >= 2 && out[map + ' wave'].n >= 2, `${map}: bots in Wave and Match`);
            const retakes = Object.entries(out).filter(([k]) => k.startsWith(map + ' retake')).map(([, r]) => r.site).sort();
            assert.deepEqual(retakes, MAPS[map].keys, `${map}: Retake at every site`);
        }
        await frames(2);
        assert.deepEqual(errors, []);
    });

    test(`${label}: callouts on every site, minimap markers for every site, High Detail props build, no shader compiles`, { timeout: 600000 }, async () => {
        const { page, errors, frames, evaluate } = await boot({ quality: 'cinematic' });
        const [baseline] = await programState(page);
        for (const map of Object.keys(MAPS)) {
            const r = await evaluate((map) => {
                tacticalDirector.setGameMode('wave');
                rebuildMapPreset(map);
                const L = mapLayout(), cc = characterController, out = { zones: [] };
                // Walk the player through a few spots: the HUD's callout follows
                for (const k of siteKeys(L)) {
                    cc.position.set(L.sites[k].x, cc.standHeight, L.sites[k].z); cc.prevSimPosition.copy(cc.position);
                    out.zones.push(tacticalRadar.getZoneName(cc.position.x, cc.position.y, cc.position.z));
                }
                const ctx = tacticalRadar.ctx, drawn = [];
                const ft = ctx.fillText;
                ctx.fillText = function (t, x, y) { if (t === 'A' || t === 'B' || t === 'C') drawn.push(t); return ft.call(ctx, t, x, y); };
                tacticalRadar.lastDrawAt = 0;
                if (tacticalRadar.update) tacticalRadar.update(performance.now() + 100000);
                ctx.fillText = ft;
                out.radar = Array.from(new Set(drawn)).sort();
                out.hiDecor = mapDecor.instanceCount;
                return out;
            }, map);
            await frames(4);
            const keys = MAPS[map].keys;
            assert.deepEqual(r.zones, MAPS[map].siteCallouts || keys.map((k) => k + ' SITE'), `${map}: callouts on the sites`);
            assert.deepEqual(r.radar, keys, `${map}: the minimap marks every site`);
            assert.ok(r.hiDecor > 400, `${map}: High Detail props (${r.hiDecor})`);
        }
        const [programs] = await programState(page);
        assert.equal(programs, baseline, 'no shader compiles on any of these maps');
        assert.deepEqual(errors, []);
    });
};
