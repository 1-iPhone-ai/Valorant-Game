'use strict';
// V2.2 final check, the earlier list (helper A): one boot, a lean check per fix. Bots are frozen (and kept
// alive), the wingmen are off until their own check, and every wait is on game time or on a condition.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, closeBrowser, programState } = require('./harness');

after(closeBrowser);

// Page helpers: a damage log, bot placement, and an end to every ability item that is out
function helpers() {
    window.updateEnemies = () => {};
    game.userSettings.infiniteAbilities = true;
    game.userSettings.infiniteUlt = true;
    tacticalEnhancements.toggleWingmanAI(false);
    window.__log = [];
    const dmg = window.damageEnemyActor;
    window.damageEnemyActor = function (e, amount, effNow, nowMs, label, zone) {
        const before = e.health + (e.armor || 0);
        const r = dmg.apply(this, arguments);
        __log.push({ label: label, amount: amount, zone: zone, dealt: before - (e.health + (e.armor || 0)), t: gameNow(), bot: __bots.indexOf(e) });
        return r;
    };
    // two bots do the work; any others are parked in a far corner
    window.__all = enemyObjects.filter((x) => x.isActive && !x.hit);
    window.__bots = __all.slice(0, 2);
    const put = (e, x, z) => { e.mesh.position.set(x, 0, z); e.poseDirty = true; syncEnemyBroadphase(e); };
    window.__place = (i, x, z) => put(__bots[i], x, z);
    window.__fresh = () => {
        for (const e of __all) { e.health = 1e6; e.maxHealth = 1e6; e.armor = 0; e.revealedUntil = 0; e.slowedUntil = 0; e.blindedUntil = 0; e.burningUntil = 0; }
        __place(0, -40, -40); __place(1, 40, -40);
        __all.slice(2).forEach((e, i) => put(e, 44, 44 - 1.5 * i));
    };
    window.__player = (x, y, z, pitch, yaw) => {
        const cc = characterController;
        cc.position.set(x, y, z); cc.prevSimPosition.copy(cc.position); cc.velocity.set(0, 0, 0);
        camera.position.copy(cc.position);
        camera.rotation.set(pitch, yaw, 0, 'YXZ');
        if (cc.targetRotation) cc.targetRotation.y = yaw;
    };
    // as the High Fidelity kit's clear: every pooled item and single object of agentSystem ends through its own update
    window.__clear = () => {
        game.ultActiveUntil = 0; game.ultAgent = null; game.ultChargesLeft = 0;
        const A = agentSystem;
        const end = (it) => {
            if (!it || typeof it !== 'object' || it.isObject3D) return;
            if ('expireAt' in it) it.expireAt = 1;
            if ('executeAt' in it) it.executeAt = 1;
        };
        for (const k of Object.keys(A)) {
            const v = A[k];
            if (Array.isArray(v)) { for (const it of v) if (it && typeof it === 'object' && ('inUse' in it || 'active' in it)) end(it); }
            else if (v && typeof v === 'object' && ('inUse' in v || 'active' in v)) end(v);
        }
        for (const p of A.projectiles) if (p.inUse) { p.inUse = false; p.mesh.visible = false; }
        __log.length = 0;
    };
    // the ticks of one label on the two bots since t0: [{ dealt, zone, amount, t, bot }]
    window.__ticks = (label, t0) => __log.filter((ev) => ev.label === label && ev.t >= t0 && ev.bot >= 0);
    // the recon diamond a bot gets: the update hands them out in enemyObjects order to the revealed bots
    window.__diamond = (e) => {
        const g = gameNow();
        const i = enemyObjects.filter((x) => x.isActive && !x.hit && x.revealedUntil > g).indexOf(e);
        return i >= 0 ? agentSystem.hudDiamonds[i] : null;
    };
}

test('V2.2 final check (earlier list): smokes, ticks, rings, teleports, Thrash, Armageddon, Arc Rose, burning, wingman tracer', { timeout: 900000 }, async (t) => {
    const { page, errors, frames, evaluate } = await boot({ quality: 'medium' });
    await evaluate(helpers);
    const waitGame = async (ms) => {
        const g0 = await evaluate(() => gameNow());
        await page.waitForFunction(([g0, ms]) => gameNow() - g0 >= ms, [g0, ms], { timeout: 240000, polling: 20 });
    };
    const reset = async () => { await evaluate(() => { __clear(); __fresh(); }); await frames(3); };
    await reset();

    await t.test('1. the minimap sky smoke is a plain smoke where you click, on game time, and it ends', async () => {
        const r = await evaluate(() => {
            __player(-40, 1.7, 0, -0.1, Math.PI);
            const rect = minimapCanvas.getBoundingClientRect();
            const before = agentSystem.smokes.map((s) => s.inUse);
            minimapCanvas.dispatchEvent(new MouseEvent('mousedown', { clientX: rect.left + rect.width * 0.5 + 12, clientY: rect.top + rect.height * 0.5 - 8, shiftKey: true, bubbles: true, cancelable: true }));
            const s = agentSystem.smokes.find((x, i) => x.inUse && !before[i]);
            const ping = tacticalEnhancements.activePings[tacticalEnhancements.activePings.length - 1];
            if (!s) return { found: false, rect: [rect.width, rect.height] };
            // a sight line through the smoke's middle is blocked; a bot inside is not slowed (it is no Cyber Cage)
            const e = __bots[0];
            e.mesh.position.set(s.position.x, 0, s.position.z); e.slowedUntil = 0; e.revealedUntil = 0;
            const from = new THREE.Vector3(s.position.x - 8, s.position.y, s.position.z), to = new THREE.Vector3(s.position.x + 8, s.position.y, s.position.z);
            window.__sky = s;
            return { found: true, at: [s.position.x - ping.x, s.position.z - ping.z].map((v) => Math.abs(v)), y: s.position.y, radius: s.radius,
                lasts: s.expireAt - s.startAt, startLag: gameNow() - s.startAt, cage: s.isCyberCage, dark: s.isDarkCover, blocks: agentSystem.isBlockedBySmoke(from, to) };
        });
        assert.ok(r.found, 'the click spawns a smoke');
        assert.ok(r.at[0] < 1e-6 && r.at[1] < 1e-6, 'the smoke is at the clicked spot (the ping\'s)');
        assert.ok(Math.abs(r.y - Math.max(4.6 * 0.65, 1.5)) < 1e-9 && r.radius === 4.6, `a 4.6 m smoke on the floor (y ${r.y}, radius ${r.radius})`);
        assert.equal(r.lasts, 8500, 'it lasts 8.5 s');
        assert.ok(r.startLag >= 0 && r.startLag < 100, 'it runs on game time');
        assert.equal(r.cage, false, 'it is not a Cyber Cage');
        assert.equal(r.dark, false);
        assert.ok(r.blocks, 'it blocks sight');
        await frames(3);
        assert.equal(await evaluate(() => __bots[0].slowedUntil > gameNow()), false, 'a bot inside is not slowed');
        // it ends (its slot comes back): shortened, through the normal update
        await evaluate(() => { __sky.expireAt = gameNow() + 50; });
        await page.waitForFunction(() => !__sky.inUse, null, { timeout: 60000, polling: 20 });
        await reset();
    });

    await t.test('2. Dark Cover is Dark Cover: its look, the slow and reveal inside it; a smoke thrown after it is not', async () => {
        const cast = async (agent, slot) => {
            await evaluate(([agent, slot]) => {
                __player(-40, 1.7, 0, -0.12, Math.PI);
                agentSystem.selectAgent(agent);
                window.__before = agentSystem.smokes.map((s) => s.inUse);
                agentSystem.castAbility(slot);
            }, [agent, slot]);
            await page.waitForFunction(() => agentSystem.smokes.some((s, i) => s.inUse && !__before[i]), null, { timeout: 120000, polling: 20 });
            return evaluate(() => {
                const s = agentSystem.smokes.find((x, i) => x.inUse && !__before[i]);
                const e = __bots[0];
                e.mesh.position.set(s.position.x + 1, 0, s.position.z); e.slowedUntil = 0; e.revealedUntil = 0;
                window.__sm = s;
                return { dark: s.isDarkCover, outer: s.outerMat.color.clone().convertLinearToSRGB().getHex(), key: s.lookKey };
            });
        };
        const near = (a, b) => [16, 8, 0].every((sh) => Math.abs(((a >> sh) & 255) - ((b >> sh) & 255)) <= 2);
        const omen = await cast('omen', 'e');
        assert.equal(omen.dark, true, 'Omen\'s Dark Cover is flagged as Dark Cover');
        assert.ok(near(omen.outer, 0x312e81), `its Classic shell is Dark Cover's indigo (${omen.outer.toString(16)})`);
        assert.equal(omen.key, 'omen.e', 'High Fidelity still knows it as Omen\'s');
        await frames(3);
        assert.deepEqual(await evaluate(() => ({ slowed: __bots[0].slowedUntil > gameNow(), revealed: __bots[0].revealedUntil > gameNow() })), { slowed: true, revealed: true }, 'a bot inside is slowed and revealed');
        await evaluate(() => { __sm.expireAt = 1; });
        await frames(2);
        const jett = await cast('jett', 'c');   // the next smoke projectile (the pool's first free one) carries no flag
        assert.equal(jett.dark, false, 'Jett\'s Cloudburst is not Dark Cover');
        await frames(3);
        assert.equal(await evaluate(() => __bots[0].slowedUntil > gameNow()), false, 'a bot in Cloudburst is not slowed');
        await reset();
    });

    await t.test('8. the rings of Sonic Sensor\'s blast, Annihilation\'s execution and Mosh Pit\'s eruption are drawn', async () => {
        await evaluate(() => {
            const A = agentSystem, now = gameNow();
            window.__rings = [];
            const spawn = A.spawnWindRing;
            window.__ringSpawn = spawn;
            A.spawnWindRing = function (x, y, z, hex, s) {
                const r = spawn.apply(this, arguments);
                const it = this.windRings.find((w) => w.inUse && w.mesh.position.x === x && w.mesh.position.z === z && w.maxScale === s);
                __rings.push({ tag: abilityLook.tag, it: it, startAt: it && it.startAt, at: gameNow(), seen: 0 });
                return r;
            };
            const render = renderer.render;
            window.__render = render;
            renderer.render = function (sc) {
                if (sc === scene) for (const r of __rings) if (r.it && r.it.inUse && r.it.mesh.visible) r.seen++;
                return render.apply(this, arguments);
            };
            const ds = A.deadlockSensors[0];
            ds.inUse = true; ds.triggered = true; ds.detonateAt = now + 50; ds.position.set(10, 0.02, -30); ds.radius = AGENT_TUNING.deadlock.q.radiusM;
            ds.startAt = now; ds.expireAt = now + 26000; ds.group.position.copy(ds.position); ds.group.visible = true;
            const dc = A.deadlockCocoon;   // a cocoon with no captive executes at once
            dc.active = true; dc.targetEnemy = null; dc.executeAt = now + 50; dc.position.set(-10, 0.02, -30);
            A.spawnGekkoMoshPit(-10, 0, 10, now);
            A.gekkoMoshPits.find((m) => m.inUse).eruptAt = now + 50;
        });
        await page.waitForFunction(() => ['deadlock.q', 'deadlock.x', 'gekko.c'].every((k) => __rings.some((r) => r.tag === k && r.it && !r.it.inUse)), null, { timeout: 120000, polling: 20 });
        const r = await evaluate(() => {
            agentSystem.spawnWindRing = __ringSpawn; renderer.render = __render;
            return ['deadlock.q', 'deadlock.x', 'gekko.c'].map((k) => { const x = __rings.find((r) => r.tag === k); return { k: k, startLag: x.at - x.startAt, seen: x.seen }; });
        });
        for (const x of r) {
            assert.ok(x.startLag >= 0 && x.startLag < 1e-6, `${x.k}: the ring starts when it is spawned (it started at its duration)`);
            assert.ok(x.seen >= 1, `${x.k}: the ring is drawn (in ${x.seen} frames)`);
        }
        await reset();
    });

    await t.test('9. a revealed bot in a fire, acid or gas zone gets the orange (burning) recon diamond, and loses it after', async () => {
        await evaluate(() => {
            __player(-40, 1.7, 0, -0.05, Math.PI);   // looking along +Z
            __place(0, -40, 9);
            // Viper's Snake Bite: its acid burns and reveals
            agentSystem.spawnMollyZone(-40, 0, 9, gameNow(), false, false, true);
        });
        await page.waitForFunction(() => __bots[0].burningUntil > gameNow() && __diamond(__bots[0]) && __diamond(__bots[0]).visible, null, { timeout: 60000, polling: 20 });
        await frames(2);
        const on = await evaluate(() => { const d = __diamond(__bots[0]); return { burning: d.el.classList.contains('burning'), colour: getComputedStyle(d.el.querySelector('.recon-diamond')).borderTopColor }; });
        assert.equal(on.burning, true, 'the diamond is marked burning');
        assert.equal(on.colour, 'rgb(255, 123, 0)', 'in orange');
        await evaluate(() => { for (const m of agentSystem.mollies) m.expireAt = 1; });
        await page.waitForFunction(() => __bots[0].burningUntil < gameNow() - 50, null, { timeout: 60000, polling: 20 });
        await frames(2);
        // still revealed (Snake Bite's reveal outlasts its burn), so its diamond is still up
        assert.deepEqual(await evaluate(() => { const d = __diamond(__bots[0]); return d && [d.visible, d.el.classList.contains('burning')]; }), [true, false], 'out of the zone it is not');
        await reset();
    });

    await t.test('3. a tick of GravNet, Barrier Mesh, Razorvine, Mosh Pit, High Tide and Cosmic Divide deals its tuned damage once (a body hit)', async () => {
        // two bots, so three pairs: each tick's damage, its hit zone and how often it ticks
        const pairs = [
            [['GravNet Nanowire', 'deadlock.c', true], ['Barrier Mesh', 'deadlock.e', true]],
            [['Razorvine Thorns', 'vyse.e', true], ['Mosh Pit Acid', 'gekko.c', false]],
            [['High Tide', 'harbor.e', true], ['Cosmic Divide', 'astra.x', true]]
        ];
        for (let p = 0; p < 3; p++) {
            const t0 = await evaluate((p) => {
                const A = agentSystem, now = gameNow();
                __fresh();
                __place(0, -30, -30); __place(1, 30, -30);
                if (p === 0) {
                    A.spawnDeadlockGravNet(-30, 0, -30, now);
                    const db = A.deadlockBarriers[0];   // its arm along X through bot 1, held on it every step (a bot walking into it)
                    db.inUse = true; db.position.set(27, 0.02, -30); db.yaw = 0; db.radius = AGENT_TUNING.deadlock.e.halfLengthM;
                    db.startAt = now; db.expireAt = now + AGENT_TUNING.deadlock.e.lifetimeMs; db.nextTickAt = now + AGENT_TUNING.deadlock.e.firstTickMs;
                    db.group.position.copy(db.position); db.group.rotation.y = 0; db.group.visible = true;
                    const step = A.stepSimulation;
                    window.__step = step;
                    A.stepSimulation = function (dt, tm) { __bots[1].mesh.position.set(30, 0, -29.8); return step.call(this, dt, tm); };
                } else if (p === 1) {
                    A.spawnVyseRazorvine(-30, 0, -30, now);
                    A.spawnGekkoMoshPit(30, 0, -30, now);
                } else {
                    const ht = A.harborHighTides[0];
                    ht.inUse = true; ht.startPos.set(-30, 0, -38); ht.endPos.set(-30, 0, -22); ht.length = 16; ht.startAt = now;
                    ht.expireAt = now + AGENT_TUNING.harbor.e.lifetimeMs; ht.nextTickAt = now + AGENT_TUNING.harbor.e.firstTickMs;
                    ht.group.position.set(-30, 0, -30); ht.group.visible = true;
                    const cd = A.astraCosmicDivide;
                    cd.active = true; cd.position.set(30, 0, -30); cd.startPos.set(30, 0, -40); cd.endPos.set(30, 0, -20); cd.startAt = now;
                    cd.expireAt = now + 4000; cd.nextTickAt = now + AGENT_TUNING.astra.x.firstTickMs; cd.group.position.set(30, 0, -30); cd.group.visible = true;
                }
                return now;
            }, p);
            await waitGame(700);
            const got = await evaluate(([labels, t0]) => {
                if (window.__step) { agentSystem.stepSimulation = __step; window.__step = null; }
                return labels.map(([label, key]) => {
                    const [agent, slot] = key.split('.');
                    const T = AGENT_TUNING[agent][slot];
                    const ticks = __ticks(label, t0).filter((ev) => ev.t <= t0 + 700);
                    return { label: label, per: T.damagePerTick, tickMs: T.tickMs, n: ticks.length, amounts: ticks.map((x) => x.amount), zones: ticks.map((x) => String(x.zone)), dealt: ticks.map((x) => x.dealt),
                        gaps: ticks.slice(1).map((x, i) => x.t - ticks[i].t) };
                });
            }, [pairs[p].map((x) => [x[0], x[1]]), t0]);
            for (let i = 0; i < 2; i++) {
                const g = got[i], reveals = pairs[p][i][2];
                const want = Math.round(g.per * (reveals ? 1.2 : 1));   // the tick reveals (except Mosh Pit's), and revealed bots take 20% more
                assert.ok(g.n >= 2, `${g.label}: it ticks (${g.n} ticks)`);
                assert.ok(g.amounts.every((a) => a === g.per), `${g.label}: each tick asks for damagePerTick ${g.per} (${g.amounts})`);
                assert.ok(g.zones.every((z) => z !== 'true' && z !== 'head'), `${g.label}: as a body hit (${g.zones})`);
                assert.ok(g.dealt.every((d) => d === want), `${g.label}: each tick deals ${want} (${g.dealt})`);
                assert.ok(g.gaps.every((d) => d >= g.tickMs - 1e-6), `${g.label}: once per ${g.tickMs} ms tick (${g.gaps})`);
            }
            await evaluate(() => __clear());
            await frames(3);
        }
        await reset();
    });

    await t.test('4. Arc Rose: a press plants one rose and the next pops it; a bot walking up to a rose pops that rose', async () => {
        const live = () => evaluate(() => agentSystem.vyseArcRoses.filter((r) => r.inUse && gameNow() < r.expireAt).length);
        await evaluate(() => { __player(-40, 1.7, 0, -0.35, Math.PI); agentSystem.selectAgent('vyse'); agentSystem.castAbility('q'); });
        assert.equal(await live(), 1, 'the first press plants a rose');
        await evaluate(() => agentSystem.castAbility('q'));
        assert.equal(await live(), 0, 'the second press pops it (so only one is ever out from presses)');
        // two roses at once (only reachable from code): a bot at the second pops the second
        await evaluate(() => {
            const A = agentSystem, now = gameNow();
            A.castVyseArcRose(now); A.castVyseArcRose(now);
            const [a, b] = A.vyseArcRoses;
            a.position.set(-40, 0.55, 6); a.group.position.copy(a.position);
            b.position.set(-40, 0.55, 30); b.group.position.copy(b.position);
            window.__roses = [a, b];
            __place(0, -40, 31);
        });
        await page.waitForFunction(() => !__roses[1].inUse, null, { timeout: 60000, polling: 20 });
        await frames(2);
        assert.equal(await evaluate(() => __roses[0].inUse), true, 'the other rose is still out');
        await reset();
    });

    await t.test('6. Thrash bursts when the ultimate runs out first (as Wingman does at its time limit)', async () => {
        const r = await evaluate(() => {
            __player(-40, 1.7, 0, -0.1, Math.PI);
            agentSystem.selectAgent('gekko');
            game.ultPoints = game.maxUltPoints;
            window.__glob = agentSystem.gekkoGlobules.filter((g) => g.inUse && g.kind === 'x').length;
            agentSystem.castAbility('x');
            const gt = agentSystem.gekkoThrash;
            // the ultimate's end comes before Thrash's own: in a frame whose game time is past it before a step is
            // (Thrash's own end, the same moment, is only seen by the next step)
            game.ultActiveUntil = gameNow() + 150;
            return { out: gt.active, ownEndLeft: gt.expireAt - gameNow() };
        });
        assert.ok(r.out && r.ownEndLeft > 1000, 'Thrash is out, with its own end well after the ultimate\'s');
        await page.waitForFunction(() => !agentSystem.gekkoThrash.active, null, { timeout: 120000, polling: 20 });
        const g = await evaluate(() => ({ globules: agentSystem.gekkoGlobules.filter((x) => x.inUse && x.kind === 'x').length - __glob, ult: game.ultAgent }));
        assert.equal(g.globules, 1, 'it burst (its globule is down)');
        assert.equal(g.ult, null, 'the ultimate is over');
        await reset();
    });

    await t.test('7. Armageddon bombs the corridor it draws: waves from where Tejo stands, the Classic wave block with them', async () => {
        // Tejo at (-40, 0) looking along +Z: the corridor runs 3.5 m to 31.5 m ahead (the origin, then 28 m)
        await evaluate(() => {
            const A = agentSystem;
            __player(-40, 1.7, 0, -0.1, Math.PI);
            __fresh();
            __place(0, -40, 3.5 + 2);    // 2 m into the corridor
            __place(1, -40, 3.5 + 31);   // 3 m past its end
            agentSystem.selectAgent('tejo');
            game.ultPoints = game.maxUltPoints;
            agentSystem.castAbility('x');
            const ta = A.tejoArmageddon;
            window.__waves = [];
            const step = A.stepSimulation;
            window.__step = step;
            A.stepSimulation = function (dt, tm) {
                if (ta.active) ta.nextWaveAt = 0;   // a wave every step (the spacing in time is not what is checked)
                const n = ta.wavesFired;
                const r = step.call(this, dt, tm);
                if (ta.wavesFired > n) __waves.push({ along: (ta.currentWavePos.x - ta.origin.x) * ta.dir.x + (ta.currentWavePos.z - ta.origin.z) * ta.dir.z,
                    block: [ta.waveMesh.position.x - ta.currentWavePos.x, ta.waveMesh.position.z - ta.currentWavePos.z], floor: (ta.floorMesh.position.x - ta.origin.x) * ta.dir.x + (ta.floorMesh.position.z - ta.origin.z) * ta.dir.z });
                return r;
            };
        });
        await page.waitForFunction(() => __waves.length >= AGENT_TUNING.tejo.x.waveCount, null, { timeout: 120000, polling: 20 });
        const r = await evaluate(() => {
            agentSystem.stepSimulation = __step; window.__step = null;
            const hits = __log.filter((ev) => ev.label === 'Armageddon Airstrike');
            return { waves: __waves, T: AGENT_TUNING.tejo.x, near: hits.filter((h) => h.bot === 0).length, past: hits.filter((h) => h.bot === 1).length };
        });
        r.waves.forEach((w, i) => {
            const want = r.T.waveStartM - r.T.spawnAheadM + (i + 1) * r.T.waveSpacingM;
            assert.ok(Math.abs(w.along - want) < 1e-6, `wave ${i + 1} is ${want} m along the corridor (${w.along.toFixed(2)})`);
            assert.ok(Math.abs(w.block[0]) < 1e-6 && Math.abs(w.block[1]) < 1e-6, `wave ${i + 1}: the Classic wave block is on it`);
        });
        const floorMid = r.waves[0].floor;   // the corridor's floor plane (28 m long) is centred 14 m along
        assert.ok(Math.abs(floorMid - 14) < 1e-6);
        const first = r.waves[0].along - r.T.hitDepthM, last = r.waves[r.waves.length - 1].along + r.T.hitDepthM;
        assert.ok(first >= -1 && first <= 1 && last >= 27 && last <= 29, `the waves cover the corridor, 0 to 28 m (${first.toFixed(1)} to ${last.toFixed(1)})`);
        assert.ok(r.near >= 1, 'a bot 2 m into the corridor is hit');
        assert.equal(r.past, 0, 'a bot 3 m past its end is not');
        await reset();
    });

    await t.test('5. Veto\'s Crosscut and Waylay\'s Refract put you on the floor they mark, a raised one too', async () => {
        // a raised floor in the open: a box top 0.8-3.5 m up, at least 3 x 3 m, nothing over it
        const box = await evaluate(() => {
            const all = new Set();
            for (const cell of collisionIndex.cells.values()) for (const r of cell) all.add(r);
            const list = [...all];
            let best = null;
            for (const b of list) {
                const top = b.maxY, w = b.maxX - b.minX, d = b.maxZ - b.minZ;
                if (top < 0.8 || top > 3.5 || w < 3 || d < 3) continue;
                const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
                if (Math.abs(cx) > 40 || Math.abs(cz) > 40) continue;
                if (list.some((o) => o !== b && o.maxX > cx - 1.5 && o.minX < cx + 1.5 && o.maxZ > cz - 1.5 && o.minZ < cz + 1.5 && o.maxY > top + 0.05 && o.minY < top + 2.4)) continue;
                if (!best || w * d > best.area) best = { cx: cx, cz: cz, top: top, area: w * d };
            }
            return best;
        });
        assert.ok(box, 'the map has a raised floor to stand on');
        const settle = async () => { await frames(12); return evaluate(() => { const cc = characterController; return { x: cc.position.x, z: cc.position.z, feet: cc.position.y - cc.height }; }); };
        // Veto: an anchor on the box top (where castVetoCrosscut puts one aimed there), then C again from the ground
        await evaluate((box) => {
            __player(box.cx + 6, 1.7, box.cz + 6, 0, 0);
            agentSystem.selectAgent('veto');
            const vc = agentSystem.vetoCrosscutAnchor, now = gameNow();
            vc.active = true; vc.position.set(box.cx, agentSystem.findSupportFloorY(box.cx, box.top + 1.5, box.cz), box.cz);
            vc.startAt = now; vc.expireAt = now + 22000; vc.group.position.copy(vc.position); vc.group.visible = true;
            agentSystem.castAbility('c');
        }, box);
        let p = await settle();
        assert.ok(Math.abs(p.x - box.cx) < 0.05 && Math.abs(p.z - box.cz) < 0.05 && Math.abs(p.feet - box.top) < 0.05, `Veto stands on the anchor's floor (${JSON.stringify(p)}, top ${box.top})`);
        // Waylay: Refract on the box top, a walk off, E again
        await evaluate((box) => {
            __player(box.cx, box.top + characterController.height, box.cz, 0, 0);
            agentSystem.selectAgent('waylay');
            agentSystem.castAbility('e');
            __player(box.cx + 6, 1.7, box.cz + 6, 0, 0);
        }, box);
        await frames(4);
        await evaluate(() => agentSystem.castAbility('e'));
        p = await settle();
        assert.ok(Math.abs(p.x - box.cx) < 0.05 && Math.abs(p.z - box.cz) < 0.05 && Math.abs(p.feet - box.top) < 0.05, `Waylay is back on the beacon's floor (${JSON.stringify(p)}, top ${box.top})`);
        // and on the ground floor nothing changes: Crosscut to an anchor on open ground
        await evaluate(() => {
            __player(-40, 1.7, 0, -0.35, Math.PI);
            agentSystem.selectAgent('veto');
            agentSystem.castAbility('c');
            window.__anchor = agentSystem.vetoCrosscutAnchor.position.clone();
            __player(-40, 1.7, -4, 0, Math.PI);
            agentSystem.castAbility('c');
        });
        p = await settle();
        const a = await evaluate(() => [__anchor.x, __anchor.y, __anchor.z]);
        assert.ok(Math.abs(p.x - a[0]) < 0.05 && Math.abs(p.z - a[2]) < 0.05 && Math.abs(p.feet - Math.max(0, a[1] - 0.02)) < 0.05, `on open ground Veto stands at the anchor (${JSON.stringify(p)})`);
        await reset();
    });

    await t.test('10. a wingman\'s shot draws the bots\' tracer from its muzzle', async () => {
        await evaluate(() => {
            __player(-40, 1.7, 0, 0, Math.PI);
            __fresh();
            __place(0, -40, 5);
            window.__trails = [];
            const ct = window.createBulletTrail;
            window.__ct = ct;
            window.createBulletTrail = function (s, d) {
                __trails.push({ s: [s.x, s.y, s.z], d: [d.x, d.y, d.z], wing: tacticalEnhancements.wingmanBots.map((b) => [b.group.position.x, b.group.position.z]) });
                return ct.apply(this, arguments);
            };
            window.__shots = tacticalEnhancements.combatMatrix.wingman.body;
            // the wingmen beside you in the open corridor (they escort you; from wherever they stood they could be walls away)
            tacticalEnhancements.wingmanBots.forEach((b, i) => { b.group.position.x = i ? -38.8 : -41.2; b.group.position.z = -1.5; b.lastFireAt = 0; });
            tacticalEnhancements.toggleWingmanAI(true);
        });
        await page.waitForFunction(() => tacticalEnhancements.combatMatrix.wingman.body > __shots, null, { timeout: 180000, polling: 20 });
        const r = await evaluate(() => {
            window.createBulletTrail = __ct;
            tacticalEnhancements.toggleWingmanAI(false);
            const bot = __bots[0].mesh.position;
            return { shots: tacticalEnhancements.combatMatrix.wingman.body - __shots,
                trails: __trails.map((tr) => ({ y: tr.s[1], muzzle: Math.min(...tr.wing.map((w) => Math.hypot(tr.s[0] - w[0], tr.s[2] - w[1]))),
                    toBot: (bot.x - tr.s[0]) * tr.d[0] + (bot.z - tr.s[2]) * tr.d[2] - Math.hypot(bot.x - tr.s[0], bot.z - tr.s[2]) })) };
        });
        assert.ok(r.trails.length >= 1, `a tracer is drawn (${r.shots} shots, ${r.trails.length} tracers)`);
        const tr = r.trails[0];
        assert.ok(Math.abs(tr.y - 1.25) < 1e-6 && Math.abs(tr.muzzle - 0.85) < 0.05, `from the wingman's muzzle (${JSON.stringify(tr)})`);
        assert.ok(Math.abs(tr.toBot) < 1e-3, 'towards the bot it shot');
        await reset();
    });

    await t.test('11. ultraRealism has no unread fellBack flag', async () => {
        assert.equal(await evaluate(() => 'fellBack' in ultraRealism), false);
    });

    const [programs, watermark] = await programState(page);
    assert.equal(programs, watermark, 'no shader compiled after the warm-up');
    assert.deepEqual(errors, []);
});
