'use strict';
// V2.3 static checks that need no browser (well under 10 s), run after every milestone and every merge (design 17.4):
// the marked blocks, their owners and anchors, the rules inside them (no Math.random, no lights, no materials outside
// V23.mat), every hook line exactly once in the function the design names, the three new settings in both default
// blocks, V23.CONTRACT (read as data) against the blocks' source, the V2.2 file unchanged, the two V2.3 labels, and
// every V2.2 Math.random() call site kept in order.
//
// Nothing here runs a block's code: blocks, owners and regions come from the source scan, and only the V23.CONTRACT
// literal (pure data) and the two helper statements V23.rand / V23.seeded are evaluated. So a helper's block may use
// THREE, game state or private `_` members freely. Each contract function must be defined in its block, in one of the
// forms findDef lists, with the contract's arguments; a module whose functions are all still one-line literal stubs
// must return the inert values (null, false, [], 6, 1). The booted page's checks (every contract function present,
// no public function outside the contract, the boot order) are in identity-budget.test.js.
//
// The main script is scanned once by a small tokenizer (comments, strings, template literals and regex literals told
// apart from code), which also names every '{' it opens (function, method, object literal, event listener), so a hook
// can be checked against the function it sits in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const FILE = path.resolve(REPO, process.env.GAME_FILE || '(V2.3) valorant-fps.html');
const V22_FILE = '(V2.2) valorant-fps.html';
// SHA-256 of '(V2.2) valorant-fps.html' as merged on main (b19aacf); used when git history is not available (CI clones
// one commit)
const V22_MAIN_COMMIT = 'b19aacf';
const V22_MAIN_SHA256 = 'bbcf424b4446800711276cc085a192606aa9e1d6d6f57349ee629f6ba6f7d74c';

const HTML = fs.readFileSync(FILE, 'utf8');

// ---- the main script and the tokenizer --------------------------------------------------------------------------
function mainScript(html) {
    const re = /<script>\n/g;
    let m;
    while ((m = re.exec(html))) {
        const end = html.indexOf('</script>', m.index);
        const body = html.slice(m.index + m[0].length, end);
        if (body.indexOf('var V23 = {};') >= 0 || body.length > 1e6) return { start: m.index + m[0].length, text: body };
    }
    throw new Error('main script not found');
}

const KEYWORDS_BEFORE_REGEX = /(?:^|[^\w$])(return|typeof|case|in|of|void|delete|instanceof|new|throw|else|do|yield|await)\s*$/;
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'else', 'do', 'try', 'finally']);

function scan(src) {
    const n = src.length;
    const noComments = new Array(n);   // comments blanked (newlines kept), strings kept
    const codeOnly = new Array(n);     // comments and string / template / regex contents blanked
    const closeToOpen = new Map();     // ')' index -> '(' index
    const braces = [];                 // { open, close, label, depth, kind }
    const stack = [];                  // open brace records (kind 'tpl' for ${ })
    const parens = [];
    let i = 0;
    const put = (k, c, keepCode) => { noComments[k] = c; codeOnly[k] = keepCode ? c : (c === '\n' ? '\n' : ' '); };
    const prevSig = (k) => { let j = k - 1; while (j >= 0 && /\s/.test(noComments[j])) j--; return j; };
    const before = (k, len) => noComments.slice(Math.max(0, k - len), k).join('');
    const label = (k) => {
        const j = prevSig(k);
        if (j < 0) return { label: null, kind: 'block' };
        const c = noComments[j];
        if (c === ')') {
            const o = closeToOpen.get(j);
            if (o === undefined) return { label: null, kind: 'block' };
            const head = before(o, 240);
            let m;
            if ((m = /function\s+([\w$]+)\s*$/.exec(head))) return { label: m[1], kind: 'fn' };
            if ((m = /([\w$]+)\s*[:=]\s*(?:async\s+)?function\s*\*?\s*[\w$]*\s*$/.exec(head))) return { label: m[1], kind: 'fn' };
            if ((m = /([\w$]+)\s*$/.exec(head))) return CONTROL.has(m[1]) ? { label: null, kind: 'block' } : { label: m[1], kind: 'fn' };
            return { label: null, kind: 'block' };
        }
        if (c === '>' && noComments[j - 1] === '=') {
            let h = prevSig(j - 1);
            let headEnd;
            if (noComments[h] === ')') { const o = closeToOpen.get(h); headEnd = o === undefined ? h : o; }
            else { while (h >= 0 && /[\w$]/.test(noComments[h])) h--; headEnd = h + 1; }
            const head = before(headEnd, 240);
            let m;
            if ((m = /addEventListener\(\s*['"]([\w-]+)['"]\s*,\s*$/.exec(head))) return { label: 'on:' + m[1], kind: 'fn' };
            if ((m = /([\w$]+)\s*[:=]\s*(?:async\s*)?$/.exec(head))) return { label: m[1], kind: 'fn' };
            return { label: '=>', kind: 'arrow' };
        }
        if (c === '=' && noComments[j - 1] !== '=' && noComments[j - 1] !== '!') {
            const m = /([\w$.]+)\s*=\s*$/.exec(before(j + 1, 200));
            return m ? { label: m[1].split('.').pop(), kind: 'obj' } : { label: null, kind: 'obj' };
        }
        if (c === ':') {
            const m = /([\w$]+)\s*:\s*$/.exec(before(j + 1, 200));
            return m ? { label: m[1], kind: 'obj' } : { label: null, kind: 'obj' };
        }
        return { label: null, kind: 'block' };
    };
    let state = 'code';
    const tplStack = [];   // the state to return to when a template literal ends (code, or the code of an outer ${ })
    let regexClass = false;
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (state === 'code') {
            if (c === '/' && d === '/') { state = 'line'; put(i, ' '); put(i + 1, ' '); i += 2; continue; }
            if (c === '/' && d === '*') { state = 'block'; put(i, ' '); put(i + 1, ' '); i += 2; continue; }
            if (c === '/') {
                const j = prevSig(i);
                const pc = j >= 0 ? noComments[j] : '';
                const isRegex = j < 0 || '(,=:[!&|?{};+-*%<>~^'.indexOf(pc) >= 0 || KEYWORDS_BEFORE_REGEX.test(before(j + 1, 12));
                if (isRegex) { state = 'regex'; regexClass = false; put(i, c, true); i++; continue; }
            }
            if (c === "'" || c === '"') { state = c === "'" ? 'sq' : 'dq'; put(i, c, true); i++; continue; }
            if (c === '`') { tplStack.push('code'); state = 'tpl'; put(i, c, true); i++; continue; }
            if (c === '(') parens.push(i);
            else if (c === ')') { const o = parens.pop(); if (o !== undefined) closeToOpen.set(i, o); }
            else if (c === '{') {
                put(i, c, true);
                const l = label(i);
                const rec = { open: i, close: -1, label: l.label, kind: l.kind, depth: stack.length };
                stack.push(rec); braces.push(rec);
                i++; continue;
            } else if (c === '}') {
                const rec = stack.pop();
                if (rec) rec.close = i;
                put(i, c, true);
                if (rec && rec.kind === 'tpl') { state = 'tpl'; }
                i++; continue;
            }
            put(i, c, true); i++; continue;
        }
        if (state === 'line') { if (c === '\n') { state = 'code'; put(i, '\n', true); } else put(i, ' '); i++; continue; }
        if (state === 'block') { if (c === '*' && d === '/') { put(i, ' '); put(i + 1, ' '); i += 2; state = 'code'; continue; } put(i, c === '\n' ? '\n' : ' '); i++; continue; }
        if (state === 'sq' || state === 'dq') {
            if (c === '\\') { noComments[i] = c; noComments[i + 1] = d; codeOnly[i] = ' '; codeOnly[i + 1] = ' '; i += 2; continue; }
            if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) { state = 'code'; put(i, c, true); i++; continue; }
            if (c === '\n') { state = 'code'; }   // unterminated: recover
            noComments[i] = c; codeOnly[i] = c === '\n' ? '\n' : ' '; i++; continue;
        }
        if (state === 'tpl') {
            if (c === '\\') { noComments[i] = c; noComments[i + 1] = d; codeOnly[i] = ' '; codeOnly[i + 1] = ' '; i += 2; continue; }
            if (c === '`') { state = tplStack.pop() || 'code'; put(i, c, true); i++; continue; }
            if (c === '$' && d === '{') {
                put(i, '$', true); put(i + 1, '{', true);
                // the matching '}' (a 'tpl' record) returns to this template
                const rec = { open: i + 1, close: -1, label: null, kind: 'tpl', depth: stack.length };
                stack.push(rec); braces.push(rec);
                state = 'code'; i += 2; continue;
            }
            noComments[i] = c; codeOnly[i] = c === '\n' ? '\n' : ' '; i++; continue;
        }
        if (state === 'regex') {
            if (c === '\\') { noComments[i] = c; noComments[i + 1] = d; codeOnly[i] = ' '; codeOnly[i + 1] = ' '; i += 2; continue; }
            if (c === '[') regexClass = true;
            else if (c === ']') regexClass = false;
            else if (c === '/' && !regexClass) { state = 'code'; put(i, c, true); i++; continue; }
            else if (c === '\n') state = 'code';
            noComments[i] = c; codeOnly[i] = c === '\n' ? '\n' : ' '; i++; continue;
        }
    }
    const nc = noComments.join(''), co = codeOnly.join('');
    return { noComments: nc, codeOnly: co, braces, unclosed: stack.length };
}

const SCRIPT = mainScript(HTML);
const SRC = SCRIPT.text;
const T0 = Date.now();
const SCAN = scan(SRC);
const SCAN_MS = Date.now() - T0;
const lineStarts = [0];
for (let i = 0; i < SRC.length; i++) if (SRC[i] === '\n') lineStarts.push(i + 1);
const lineOf = (pos) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
const htmlLine = (pos) => HTML.slice(0, SCRIPT.start + pos).split('\n').length;
const lineText = (ln) => SRC.slice(lineStarts[ln], (lineStarts[ln + 1] || SRC.length + 1) - 1);
// open braces enclosing pos, outermost first
function chainAt(pos) {
    const out = [];
    for (const b of SCAN.braces) if (b.open < pos && (b.close < 0 || b.close > pos)) out.push(b);
    out.sort((a, b) => a.open - b.open);
    return out;
}
const depthAt = (pos) => chainAt(pos).length;

// ---- blocks ----------------------------------------------------------------------------------------------------------
function findBlocks(text, re, endRe) {
    const blocks = [];
    let m;
    const starts = [];
    re.lastIndex = 0;
    while ((m = re.exec(text))) starts.push({ name: m[1], owners: m[2], at: m.index, end: -1, endAt: -1 });
    endRe.lastIndex = 0;
    const ends = [];
    while ((m = endRe.exec(text))) ends.push({ name: m[1], at: m.index, len: m[0].length });
    return { starts, ends };
}
const JS_BLOCK = /\/\/ ===== V2\.3 BLOCK ([A-Z][A-Z-]*) \[(WP\d+(?:,WP\d+)*)\] =====/g;
const JS_END = /\/\/ ===== END V2\.3 BLOCK ([A-Z][A-Z-]*) =====/g;
const CSS_BLOCK = /\/\* ===== V2\.3 CSS ([A-Z][A-Z-]*) \[(WP\d+(?:,WP\d+)*)\] ===== \*\//g;
const CSS_END = /\/\* ===== END V2\.3 CSS ([A-Z][A-Z-]*) ===== \*\//g;

function pairBlocks(starts, ends, what) {
    const errs = [];
    const all = starts.map((s) => ({ t: 's', ...s })).concat(ends.map((e) => ({ t: 'e', ...e }))).sort((a, b) => a.at - b.at);
    const out = [];
    let open = null;
    for (const x of all) {
        if (x.t === 's') { if (open) errs.push(`${what} ${x.name} starts inside ${open.name}`); open = x; }
        else {
            if (!open) { errs.push(`${what} END ${x.name} without a start`); continue; }
            if (open.name !== x.name) errs.push(`${what} ${open.name} ends as ${x.name}`);
            out.push({ name: open.name, owners: open.owners, start: open.at, end: x.at + x.len });
            open = null;
        }
    }
    if (open) errs.push(`${what} ${open.name} never ends`);
    return { blocks: out, errs };
}
const jsFound = findBlocks(SRC, JS_BLOCK, JS_END);
const JS = pairBlocks(jsFound.starts, jsFound.ends, 'block');
const styleStart = HTML.indexOf('<style>'), styleEnd = HTML.indexOf('</style>');
const STYLE = HTML.slice(styleStart, styleEnd);
const cssFound = findBlocks(STYLE, CSS_BLOCK, CSS_END);
const CSSB = pairBlocks(cssFound.starts, cssFound.ends, 'css block');
const blockAt = (pos) => JS.blocks.find((b) => pos >= b.start && pos < b.end) || null;

// Where each block sits (design 2.1): after `after` (a definition that must come before it) and before `before`
const ANCHORS = {
    CORE: ['const AGENT_TUNING = {', 'const agentSystem = {'],
    PARTS: ['// ===== END V2.3 BLOCK CORE =====', 'const agentSystem = {'],
    'LOOKS-DUELISTS': ['// ===== END V2.3 BLOCK PARTS =====', 'const agentSystem = {'],
    'LOOKS-INITIATORS': ['// ===== END V2.3 BLOCK PARTS =====', 'const agentSystem = {'],
    'LOOKS-CONTROLLERS': ['// ===== END V2.3 BLOCK PARTS =====', 'const agentSystem = {'],
    'LOOKS-SENTINELS': ['// ===== END V2.3 BLOCK PARTS =====', 'const agentSystem = {'],
    FP: ['const eaFP = {', 'function applyWeaponSway('],
    VMANIM: ['// ===== END V2.3 BLOCK FP =====', 'function applyWeaponSway('],
    BOTKIT: ['function activateEnemy(', 'function spawnTargets('],
    BOTMOTION: ['// ===== END V2.3 BLOCK BOTKIT =====', 'function spawnTargets('],
    AUDIO: ['const soundFX = {', 'let _shotCalloutTimer'],
    ARENA: ['const mapHiDetail = {', 'function pointAabbDistanceSq('],
    BOTUTIL: ['const tacticalDirector = {', 'const _meleeForward'],
    SCREENS: ['const replayDirector = {', 'const MENU_MODES'],
    SHOWROOM: ['window.tacticalEnhancements = tacticalEnhancements;', 'function initGame('],
    PROTO: ['// ===== END V2.3 BLOCK SHOWROOM =====', 'function initGame(']
};

// ---- the hook lines (design 2.3). fn: the function path (object.method, a top-level function, on:<event> for a
// listener, an object path for data, or '<top>'); code: what the tagged line (or, for a comment-only tag line, the
// next line) must contain -------------------------------------------------------------------------------------------
const H = (id, fn, code) => ({ id, fn, code });
const HOOKS = [
    H('H1', '<top>', 'var V23 = {};'),
    H('H2', 'initGame', 'V23.core && V23.core.init()'),
    H('H3a', 'warmShaderVariants', 'V23.core && V23.core.warmPre(p)'),
    H('H3b', 'warmShaderVariants', 'V23.core && V23.core.warmVm()'),
    H('H3c', 'warmShaderVariants', 'V23.core && V23.core.warmWorld(p)'),
    H('H3d', 'warmShaderVariants', 'V23.core && V23.core.warmPost()'),
    H('H4', 'animate', 'V23.stage && V23.stage.render(now)'),
    H('H5', 'animate', 'V23.stage && V23.stage.update(delta, now)'),
    H('H6', 'agentSystem.refreshAgentTheme', 'V23.core && V23.core.onAgentChanged(game.activeAgent)'),
    H('H7', 'tacticalDirector.inspectAgentInPicker', 'V23.stage && V23.stage.setAgent(agentId)'),
    H('H8.1', 'tacticalDirector.toggleAgentPicker', "V23.stage && V23.stage.open('picker')"),
    H('H8.2', 'tacticalDirector.toggleAgentPicker', "V23.stage && V23.stage.close('picker')"),
    H('H9', 'tacticalDirector.renderAgentPickerGrid', 'if (V23.stage && V23.stage.renderGrid(this)) return;'),
    H('H10.1', 'mainMenu.buildShowcase', 'if (V23.stage && V23.stage.buildShowcase(this)) return;'),
    H('H10.2', 'mainMenu.show', "V23.stage && V23.stage.open('menu')"),
    H('H10.3', 'mainMenu.hide', "V23.stage && V23.stage.close('menu')"),
    H('H10.4', 'mainMenu.onAgentLocked', "V23.stage && V23.stage.close('locked')"),
    H('H10.5', 'mainMenu.onPickerClosed', "V23.stage && V23.stage.close('pickerClosed')"),
    H('H10.6', 'mainMenu.update', 'if (!(V23.stage && V23.stage.menuFrame(this, id, dt, now))) {'),
    H('H11.1', 'on:keydown', 'if (game.agentPickerOpen && V23.stage && V23.stage.onKey(event)) return;'),
    H('H11.2', 'on:wheel', 'if (V23.stage && V23.stage.onWheel(e)) return;'),
    H('H12.1', 'gamepadController.poll', 'this.navigate(pad, cur, pressed, left, now, right);'),
    H('H12.2', 'gamepadController.navigate', 'if (V23.stage && V23.stage.onPad(pad, pressed, left, right, now)) return;'),
    H('H12.3', 'gamepadController.setNavFocus', 'V23.stage && V23.stage.onFocus(el)'),
    H('H13.1', 'createWeapons', "V23.fp && V23.fp.attach(rifleGroup, 'rifle', 0.2)"),
    H('H13.2', 'createWeapons', "V23.fp && V23.fp.attach(sniperGroup, 'sniper', 0.3)"),
    H('H13.3', 'createWeapons', "V23.fp && V23.fp.attach(pistolGroup, 'pistol', 0.16)"),
    H('H13.4', 'createWeapons', "V23.fp && V23.fp.attach(knifeGroup, 'knife', 0.11)"),
    H('H14.1', 'settingsManager.applyWeaponSkin', 'if (mesh.userData.isAgentArm) continue;'),
    H('H14.2', 'skinWorkshop.ensurePreview', 'clone.children.filter((o) => o.userData.isAgentArm)) clone.remove(c);'),
    H('H14.3', 'characterDetail._buildGuns', 'if (child.userData.isAgentArm) continue;'),
    H('H14.4', 'ultraGuns.build', 'if (o.userData.isAgentArm || (o.parent && o.parent.userData.isAgentArm)) return;'),
    H('H15.1', 'characterDetail.set', 'V23.fp && V23.fp.reapply()'),
    H('H15.2', 'ultraGuns.apply', 'V23.fp && V23.fp.reapply()'),
    H('H16.1', 'castFX.init', 'V23.fp && V23.fp.initCast(this)'),
    H('H16.2', 'castFX.start', 'V23.fp && V23.fp.onStart(this, kind, abilityKey)'),
    H('H16.3', 'castFX._pose', 'const v23 = V23.fp && V23.fp.pose(this, kind, p, now, null);'),
    H('H16.4', 'eaFP.castPose', "const v23 = V23.fp && V23.fp.pose(fx, fx.active ? fx.active.kind : 'cast', p, now, variant);"),
    ...Array.from({ length: 11 }, (_, k) => H('H17.' + (k + 1), 'agentSystem.castAbility', "castFX.start('tap', def.themeColor, agentId + '.' + slotKey);")),
    H('H18', 'agentSystem.activateUltimate', "castFX.start('ult', def.themeColor, agentId + '.x');"),
    H('H19.1', 'shoot', "V23.fp && V23.fp.onSecondaryFire('sova.x')"),
    H('H19.2', 'shoot', "V23.fp && V23.fp.onSecondaryFire('raze.x')"),
    H('H19.3', 'shoot', "V23.fp && V23.fp.onSecondaryFire('neon.x')"),
    H('H19.4', 'shoot', "V23.fp && V23.fp.onSecondaryFire('chamber.x')"),
    H('H19.5', 'shoot', 'V23.vm && V23.vm.onShot()'),
    H('H20.1', 'vmAnim.pose', 'if (V23.vm && V23.vm.pose(kind, p, w, o, this.clip, hand)) return;'),
    H('H20.2', 'vmAnim.pose', 'if (V23.vm && V23.vm.pose(kind, p, w, o, this.clip, hand)) return;'),
    H('H20.3', 'vmAnim.pose', 'if (V23.vm && V23.vm.pose(kind, p, w, o, this.clip, hand)) return;'),
    H('H20.4a', 'vmAnim.finishClip', 'V23.vm && V23.vm.reset()'),
    H('H20.4b', 'cancelReload', 'V23.vm && V23.vm.reset()'),
    H('H20.5', 'reload', 'V23.vm && V23.vm.onReload(weapon)'),
    H('H20.6', 'switchWeapon', 'V23.vm && V23.vm.onSwitch(v23Prev, weaponName)'),
    H('H20.7', 'eaFP.reload', 'if (V23.vm && V23.vm.eaReload(p, w, o, hand)) return true;'),
    H('H20.8', 'applyWeaponSway', 'if (V23.vm && V23.vm.swayHold()) return;'),
    H('H20.9', 'animate', 'V23.vm && V23.vm.step(Math.min(0.05, delta), now)'),
    H('H21.1', 'activateEnemy', 'V23.bots && V23.bots.assign(actor)'),
    H('H21.2', 'activateEnemy', 'V23.util && V23.util.onActivate(actor)'),
    H('H22.1', 'createEnemyPage', 'V23.bots && V23.bots.onPage(page)'),
    H('H22.2', 'releaseEnemyPageGPU', 'V23.bots && V23.bots.releasePage(page)'),
    H('H22.3', 'packEnemyBatches', 'writeMatrix && V23.bots && V23.bots.packPose(page, s, enemy)'),
    H('H22.4', 'packEnemyBatches', 'writeColor && V23.bots && V23.bots.packColor(page, s, enemy)'),
    H('H22.5', 'packEnemyBatches', 'V23.bots && V23.bots.flush(page, n, colorLo, colorHi)'),
    H('H22.6', 'enhancedAnim.geomAttrs', 'V23.bots && V23.bots.geomAttrs(geom, src)'),
    H('H22.7', 'enhancedAnim._buildWingRig', 'V23.bots && V23.bots.wingRig(bot, rig, meshes)'),
    H('H22.8', 'characterDetail.set', 'V23.bots && V23.bots.onTier()'),
    H('H22.9', 'ultraChars.apply', 'V23.bots && V23.bots.onTier()'),
    H('H25.1', 'damageEnemyActor', 'deathRecap.onDealt(enemy, dealt, sourceLabel, hitZone);'),
    H('H25.2', 'damageEnemyActor', 'V23.bots && V23.bots.onKilled(enemy, hitZone, sourceLabel)'),
    H('H26', 'stepActorAnimation', 'if (V23.bots && V23.bots.deathStep(anim.actor, anim)) return;'),
    H('H27.1', 'settingsManager.applyEnemyHighlightColor', "V23.bots && V23.bots.setRim((game.userSettings && game.userSettings.enemyHighlightColor) || 'red');"),
    H('H27.2', 'settingsManager.drawCrosshairPreview', 'const v23c = V23.bots && V23.bots.previewColors(hlMode);'),
    H('H28', 'tacticalEnhancements.buildWingmanBots3D', 'V23.bots && V23.bots.wingKit(this.wingmanBots[i],'),
    H('H29.1', 'updateEnemies', 'V23.util && V23.util.step(enemy, gNow, distanceToPlayer, nx, nz, perpX, perpZ)'),
    H('H29.6', 'enemyTactics.step', 'if (V23.util && V23.util.peekHook(enemy, peek, perfNow)) return true;'),
    H('H29.7', 'agentSystem.isBlockedBySmoke', 'if (V23.util && V23.util.blocksSight(origin, targetPos)) return true;'),
    H('H29.8', 'updateGunplayAndCrosshair', '* (V23.util ? V23.util.playerSpeedMult(gNow) : 1);'),
    H('H29.9', 'make_flash', 'P.x = it.x + (o ? o.x : 0); P.y = it.y + (o ? o.y : 0); P.z = it.z + (o ? o.z : 0);'),
    H('H30.1', 'replayRec.init', "V23.replay && V23.replay.alloc(this, 'init')"),
    H('H30.2', 'replayRec._eaAlloc', "V23.replay && V23.replay.alloc(this, 'ea')"),
    H('H30.3', 'replayRec.capture', 'V23.replay && V23.replay.capture(this, i)'),
    H('H30.4', 'replayDirector.init', 'V23.replay && V23.replay.ghostInit(this, g)'),
    H('H30.5', 'replayDirector.onPlayerDeath', 'V23.replay && V23.replay.onPlayerDeath(this, this.pending.clip, killer, now)'),
    H('H30.6', 'replayDirector._start', 'V23.replay && V23.replay.start(this, clip, now)'),
    H('H30.7', 'replayDirector.beginFrame', 'V23.replay && V23.replay.beginSlot(this, e, k, br, saved)'),
    H('H30.8', 'replayDirector.beginFrame', 'V23.replay && V23.replay.ghostFrame(this, g, c, fall)'),
    H('H30.9', 'replayDirector.endFrame', 'const RS = 10 + (V23.replay ? V23.replay.SAVED : 0);'),
    H('H30.10', 'replayDirector.endFrame', 'V23.replay && V23.replay.endSlot(this, e, k, s, o + 10)'),
    H('H30.11', 'deathRecap.onPlayerHit', 'V23.replay && V23.replay.recapHit(this, r, source, amount, shieldAbsorb, healthDamage)'),
    H('H30.12', 'deathRecap.onDealt', 'V23.replay && V23.replay.recapDealt(this, r, enemy, amount, sourceLabel, hitZone)'),
    H('H30.13', 'deathRecap.show', 'V23.replay && V23.replay.recapShow(this)'),
    H('H30.14', 'takeDamage', 'deathRecap.onPlayerHit(source, amount, sourcePos, shieldAbsorb, healthDamage);'),
    H('H30.15', 'enemyShoot', 'weapon: V23.replay && V23.replay.weaponLabel(enemy)'),
    H('H30.16', 'tacticalDirector.setGameMode', 'V23.replay && V23.replay.resetRing()'),
    H('H30.17', 'rebuildMapPreset', 'V23.replay && V23.replay.resetRing()'),
    H('H30.18', 'replayDirector._finish', 'V23.replay && V23.replay.finish(this)'),
    H('H30.19', 'replayDirector._pollPad', 'if (V23.replay && V23.replay.pollPad(this)) return;'),
    H('H30.20', 'matchMode.startRound', 'V23.replay && V23.replay.roundStart(this, now)'),
    H('H30.21', 'matchMode.onEnemyKilled', 'V23.replay && V23.replay.roundKill(this, enemy, isHeadshot)'),
    H('H30.22', 'matchMode.roundEndExtras', 'V23.replay && V23.replay.roundMvp(this, won, reason, rs)'),
    H('H30.23', 'matchMode.finish', 'V23.replay && V23.replay.matchFinish(this, won)'),
    H('H31.1', 'enemyAudio.update', 'soundFX.enemyStep(V23.audio && V23.audio.surfAt(e))'),
    H('H31.2a', 'soundFX.playNoise', 'src.start(t0, (this._rand || Math.random)() * 0.04);'),
    H('H31.2b', 'soundFX.noiseLayer', 'src.start(t0, (this._rand || Math.random)() * 0.5);'),
    H('H31.3', 'soundFX._route', 'const out = this._out || ctx.destination;'),
    H('H31.3b', 'soundFX._route', 'if (!this._out) this._send(ctx, node);'),
    H('H31.3c', 'soundFX._route', 'if (!this._out) this._send(ctx, panner);'),
    H('H31.4', 'fxKit._emit', 'r.seed = (this._rng || Math.random)();'),
    H('H32.1', 'mapHiDetail.onMapBuilt', 'V23.arena && V23.arena.onMapBuilt()'),
    H('H32.2', 'applyVisualOverrides', 'V23.arena && V23.arena.applyTier()'),
    H('H32.3', 'settingsManager.applyAtmosphereTheme', 'V23.arena && V23.arena.onAtmosphere(mode)'),
    H('H33.1a', 'game.userSettings', "agentIdentity: 'on',"),
    H('H33.1b', 'game.userSettings', "weaponAnims: 'v23',"),
    H('H33.1c', 'game.userSettings', "botUtility: 'classic',"),
    H('H33.2a', 'DEFAULT_USER_SETTINGS', "agentIdentity: 'on',"),
    H('H33.2b', 'DEFAULT_USER_SETTINGS', "weaponAnims: 'v23',"),
    H('H33.2c', 'DEFAULT_USER_SETTINGS', "botUtility: 'classic',"),
    H('H33.3', 'settingsManager.applyAllSettings', 'V23.core && V23.core.applySettings(cfg, null)'),
    H('H33.4', 'rankedLadder.onMatchStart', 'V23.util && V23.util.rankedPin(true)'),
    H('H33.5', 'rankedLadder.restoreDifficulty', 'V23.util && V23.util.rankedPin(false)'),
    H('H33.6', 'settingsManager.bindEvents', "V23.core && V23.core.applySettings(game.userSettings, 'agentIdentity')"),
    H('H33.7', 'settingsManager.bindEvents', "V23.core && V23.core.applySettings(game.userSettings, 'weaponAnims')"),
    H('H33.8', 'settingsManager.bindEvents', "V23.core && V23.core.applySettings(game.userSettings, 'botUtility')"),
    H('H33.9', 'settingsManager.init', "u.agentIdentity = u.agentIdentity === 'off' ? 'off' : 'on'; u.weaponAnims = u.weaponAnims === 'classic' ? 'classic' : 'v23'; u.botUtility = u.botUtility === 'agent' ? 'agent' : 'classic';"),
    H('H34.1', 'playerBody.update', 'V23.proto && V23.proto.body(this, dt)'),
    H('H34.2', 'enemyTactics.onKilled', 'if (V23.proto && V23.proto.trade(enemy, partner)) return;')
];

// Single-owner regions (marker comments only in WP1): id -> [owner, what follows the marker within 3 lines]
const REGIONS = {
    'R6.enemyAnimUniforms': ['WP6', 'const enemyAnimUniforms = {'],
    'R6.installEnemyAnimation': ['WP6', 'function installEnemyAnimation('],
    'R7.EA_SHADER_POSE': ['WP7', 'const EA_SHADER_POSE = `'],
    'R7.EA_GESTURES': ['WP7', 'const EA_GESTURES = ['],
    'R7.stepBots': ['WP7', 'stepBots: function'],
    'R7._gesture': ['WP7', '_gesture: function'],
    'R7.onHit': ['WP7', 'onHit: function (e, zone, label)'],
    'R7.startDeath': ['WP7', 'startDeath: function'],
    'R7._headMatrix': ['WP7', '_headMatrix: function'],
    'R8.initBotAbilities3D': ['WP8', 'initBotAbilities3D: function'],
    'R8.acquireBotHazard': ['WP8', 'acquireBotHazard: function'],
    'R8.tryCastBotAbility': ['WP8', 'tryCastBotAbility: function'],
    'R8.updateBotAbilities': ['WP8', 'updateBotAbilities: function'],
    'R10.enemyStep': ['WP10', 'enemyStep: function'],
    'R11.floorShader': ['WP11', 'floorMaterial.onBeforeCompile = (s) => {'],
    'R11.mapShader': ['WP11', 'mapMaterial.onBeforeCompile = (s) => {'],
    'R11.decalColour': ['WP11', 'mesh.setColorAt(n, linearColorFromHex(0x333333));'],
    'R11.autoFog': ['WP11', 'scene.fog.density = profile.fogDensity;']
};

const TAG_RE = /V2\.3: (H\d+(?:\.\d+)?[a-z]?)(?![\w.])/g;

function hookSites() {
    const sites = {};
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(SRC))) {
        const ln = lineOf(m.index);
        const own = lineText(ln);
        const commentOnly = /^\s*\/\//.test(own);
        const lines = commentOnly ? [ln, ln + 1] : [ln];
        const codeLine = commentOnly ? ln + 1 : ln;
        (sites[m[1]] = sites[m[1]] || []).push({ ln, lines, text: lines.map(lineText).join('\n'), codePos: lineStarts[codeLine] + lineText(codeLine).search(/\S/) });
    }
    return sites;
}

// ---- tests ------------------------------------------------------------------------------------------------------
test('the scan is fast and every brace closes', () => {
    assert.equal(SCAN.unclosed, 0, 'every { in the main script closes');
    assert.ok(SCAN_MS < 5000, `scan took ${SCAN_MS} ms`);
});

test('block markers are balanced, owned, headed, at top level and at their anchors', () => {
    assert.deepEqual(JS.errs, []);
    assert.deepEqual(CSSB.errs, []);
    const contract = loadContract();
    const names = JS.blocks.map((b) => b.name);
    assert.deepEqual([...names].sort(), Object.keys(contract.blocks).sort(), 'the design 2.1 block set');
    assert.equal(new Set(names).size, names.length, 'each block once');
    for (const b of JS.blocks) {
        assert.equal(b.owners, contract.blocks[b.name], `${b.name} owner tag matches V23.CONTRACT.blocks`);
        const head = SRC.slice(b.start, b.end).split('\n').slice(1, 12).join('\n');
        for (const k of ['Owner:', 'Purpose:', 'Clocks:']) assert.match(head, new RegExp('^\\s*// ' + k, 'm'), `${b.name} header has ${k}`);
        assert.equal(depthAt(b.start), 0, `${b.name} starts at the top level of the script`);
        assert.equal(depthAt(b.end), 0, `${b.name} ends at the top level`);
        const [after, before] = ANCHORS[b.name];
        const a = SRC.indexOf(after), z = SRC.indexOf(before);
        assert.ok(a >= 0 && z >= 0, `${b.name} anchors exist`);
        assert.ok(a < b.start && b.end < z, `${b.name} sits after "${after}" and before "${before}" (line ${htmlLine(b.start)})`);
    }
    assert.deepEqual(CSSB.blocks.map((b) => b.name).sort(), Object.keys(contract.css).sort(), 'CSS blocks');
    // the CSS blocks close the style: nothing but whitespace between them and after the last
    const css = [...CSSB.blocks].sort((a, b) => a.start - b.start);
    for (let i = 0; i < css.length; i++) {
        const b = css[i];
        assert.equal(b.owners, contract.css[b.name], `CSS ${b.name} owner`);
        const gap = STYLE.slice(b.end, i + 1 < css.length ? css[i + 1].start : STYLE.length);
        assert.equal(gap.trim(), '', `CSS ${b.name} is followed only by the other V2.3 CSS blocks and the end of the style`);
    }
});

test('inside V2.3 blocks: no Math.random, no lights, no material constructor outside V23.mat', () => {
    const matStart = SRC.indexOf('// ----- V23.mat begin'), matEnd = SRC.indexOf('// ----- V23.mat end');
    const core = JS.blocks.find((b) => b.name === 'CORE');
    assert.ok(matStart > core.start && matEnd > matStart && matEnd < core.end, 'the V23.mat markers are inside CORE');
    // V2.3 (coordinator): the one sanctioned exception, CORE's quiet(fn) between its markers: it swaps Math.random for a
    // V23.rand stream while three.js constructs objects (uuids) and restores it; it never calls Math.random
    const qStart = SRC.indexOf('// ----- V23 quiet begin'), qEnd = SRC.indexOf('// ----- V23 quiet end');
    assert.ok(qStart > core.start && qEnd > qStart && qEnd < core.end, 'the V23 quiet markers are inside CORE');
    const qCode = SCAN.codeOnly.slice(qStart, qEnd);
    assert.deepEqual(qCode.match(/Math\s*\.\s*random[^;]*;/g), ['Math.random;', 'Math.random = V23.rand(((performance.now() * 1000) ^ Math.imul(++quietN, 0x9E3779B1)) >>> 0);', 'Math.random = mr;'],
        'quiet only saves, swaps and restores Math.random');
    for (const b of JS.blocks) {
        const code = SCAN.codeOnly.slice(b.start, b.end);
        const outsideQuiet = b.name === 'CORE' ? code.slice(0, qStart - b.start) + code.slice(qEnd - b.start) : code;
        assert.ok(!/Math\s*\.\s*random/.test(outsideQuiet), `${b.name}: no Math.random`);
        const lights = code.match(/THREE\s*\.\s*\w*Light\b/g) || [];
        if (b.name === 'SHOWROOM') {
            const hemi = (code.match(/new\s+THREE\s*\.\s*HemisphereLight\s*\(/g) || []).length;
            const dir = (code.match(/new\s+THREE\s*\.\s*DirectionalLight\s*\(/g) || []).length;
            assert.ok(hemi <= 1 && dir <= 1, 'SHOWROOM: at most one HemisphereLight and one DirectionalLight');
            assert.equal(lights.filter((l) => !/HemisphereLight|DirectionalLight/.test(l)).length, 0, 'SHOWROOM: no other lights');
        } else assert.deepEqual(lights, [], `${b.name}: no THREE lights`);
        const re = /new\s+THREE\s*\.\s*\w*Material\s*\(/g;
        let m;
        while ((m = re.exec(code))) {
            const at = b.start + m.index;
            assert.ok(at > matStart && at < matEnd, `${b.name}: material constructor outside V23.mat at line ${htmlLine(at)}`);
        }
    }
});

test('every hook line is present exactly once, in the function the design names', () => {
    const sites = hookSites();
    const want = new Set(HOOKS.map((h) => h.id));
    const unknown = Object.keys(sites).filter((id) => !want.has(id));
    assert.deepEqual(unknown, [], 'no hook tags outside the list');
    const problems = [];
    for (const h of HOOKS) {
        const s = sites[h.id] || [];
        if (s.length !== 1) { problems.push(`${h.id}: ${s.length} tags`); continue; }
        const site = s[0];
        if (site.text.indexOf(h.code) < 0) { problems.push(`${h.id}: line ${htmlLine(lineStarts[site.ln])} lacks ${h.code}`); continue; }
        if (blockAt(site.codePos)) { problems.push(`${h.id}: inside a V2.3 block`); continue; }
        const chain = chainAt(site.codePos);
        const fns = chain.filter((b) => b.kind === 'fn').map((b) => b.label);
        const all = chain.filter((b) => b.label && b.label !== '=>').map((b) => b.label);
        const parts = h.fn.split('.');
        if (h.fn === '<top>') { if (chain.length) problems.push(`${h.id}: not at the top level (${all.join(' > ')})`); continue; }
        const isData = h.fn === 'game.userSettings' || h.fn === 'DEFAULT_USER_SETTINGS';
        if (isData) {
            if (all.slice(-parts.length).join('.') !== h.fn) problems.push(`${h.id}: in ${all.join(' > ')}, not ${h.fn}`);
            continue;
        }
        if (fns[fns.length - 1] !== parts[parts.length - 1]) { problems.push(`${h.id}: innermost function ${fns[fns.length - 1]} (chain ${all.join(' > ')}), not ${h.fn}`); continue; }
        let k = 0;
        for (const l of all) if (l === parts[k]) k++;
        if (k < parts.length) problems.push(`${h.id}: chain ${all.join(' > ')} does not hold ${h.fn}`);
    }
    assert.deepEqual(problems, []);
    // the 11 tap calls all carry their key now, and nothing calls a stub without the guard
    assert.equal((SRC.match(/castFX\.start\('tap', def\.themeColor\);/g) || []).length, 0, 'no tap call without its key');
    assert.equal((SRC.match(/castFX\.start\('tap', def\.themeColor, agentId \+ '\.' \+ slotKey\);/g) || []).length, 11, 'the 11 keyed tap calls');
});

test('outside the blocks, V23 is used only on hook lines', () => {
    const sites = hookSites();
    const hookLines = new Set();
    for (const id in sites) for (const s of sites[id]) for (const ln of s.lines) hookLines.add(ln);
    const stray = [];
    const re = /\bV23\b/g;
    let m;
    while ((m = re.exec(SCAN.codeOnly))) {
        if (blockAt(m.index)) continue;
        const ln = lineOf(m.index);
        if (!hookLines.has(ln)) stray.push(`line ${htmlLine(m.index)}: ${lineText(ln).trim().slice(0, 100)}`);
    }
    assert.deepEqual(stray, []);
    // and every guarded call checks its module first
    const unguarded = [];
    const call = /V23\.(\w+)\.(\w+)\s*\(/g;
    while ((m = call.exec(SCAN.codeOnly))) {
        if (blockAt(m.index)) continue;
        const pre = SCAN.codeOnly.slice(Math.max(0, m.index - 80), m.index);
        if (!new RegExp('V23\\.' + m[1] + '\\s*(&&|\\?)[^;]*$').test(pre)) unguarded.push(`line ${htmlLine(m.index)}: V23.${m[1]}.${m[2]}`);
    }
    assert.deepEqual(unguarded, []);
});

test('single-owner regions carry their markers', () => {
    const contract = loadContract();
    assert.deepEqual(Object.keys(REGIONS).sort(), Object.keys(contract.regions).sort(), 'the region list matches V23.CONTRACT.regions');
    for (const [id, [owner, next]] of Object.entries(REGIONS)) {
        const marker = `// V2.3 REGION ${id} [${owner}]`;
        const n = SRC.split(marker).length - 1;
        assert.equal(n, 1, `${marker} once`);
        const at = SRC.indexOf(marker);
        const following = SRC.slice(at, at + 900).split('\n').slice(1, 4).join('\n');
        assert.ok(following.indexOf(next) >= 0, `${id} marker sits right before ${next}`);
        assert.equal(contract.regions[id], owner, `${id} owner`);
    }
});

test('the three settings are in both default blocks, with pills bound, synced and saved', () => {
    const wantKeys = { agentIdentity: 'on', weaponAnims: 'v23', botUtility: 'classic' };
    const span = (pred) => {
        const b = SCAN.braces.find(pred);
        assert.ok(b, 'literal found');
        return SRC.slice(b.open, b.close);
    };
    const gameBrace = SCAN.braces.find((b) => b.kind === 'obj' && b.label === 'game' && b.depth === 0);
    const user = span((b) => b.label === 'userSettings' && b.open > gameBrace.open && b.close < gameBrace.close);
    const defaults = span((b) => b.label === 'DEFAULT_USER_SETTINGS' && b.depth === 0);
    for (const [k, v] of Object.entries(wantKeys)) {
        const re = new RegExp(`^\\s{12,16}${k}: '${v}',`, 'm');
        assert.match(user, re, `game.userSettings.${k} = '${v}'`);
        assert.match(defaults, re, `DEFAULT_USER_SETTINGS.${k} = '${v}'`);
    }
    const pills = [['setting-agent-identity-pills', 'data-agentidentity', ['on', 'off']], ['setting-weapon-anims-pills', 'data-weaponanims', ['v23', 'classic']], ['setting-bot-utility-pills', 'data-botutility', ['classic', 'agent']]];
    for (const [id, attr, vals] of pills) {
        assert.equal(HTML.split(`id="${id}"`).length - 1, 1, `${id} markup once`);
        for (const v of vals) assert.ok(HTML.indexOf(`${attr}="${v}"`) >= 0, `${id} has ${v}`);
        assert.ok(SRC.indexOf(`this.bindPillGroup('${id}', '${attr}'`) >= 0, `${id} bound`);
        assert.ok(SRC.indexOf(`setActivePill('${id}', '${attr}'`) >= 0, `${id} synced`);
    }
    // saved like the others: each binding ends with saveToStorage
    for (const [id] of pills) {
        const at = SRC.indexOf(`this.bindPillGroup('${id}'`);
        assert.match(SRC.slice(at, at + 600), /this\.saveToStorage\(\);\s*\n\s*\}\);/, `${id} saves`);
    }
    // older saves keep working: the load merges DEFAULT_USER_SETTINGS under the saved object
    assert.ok(SRC.indexOf('Object.assign(game.userSettings, DEFAULT_USER_SETTINGS, parsed, {') >= 0, 'load merges defaults first');
});

// ---- V23.CONTRACT, read as data -------------------------------------------------------------------------------------
// Only the `V23.CONTRACT = Object.freeze({...})` literal is evaluated (it is data: strings, numbers, arrays and
// Object.freeze), never a block's code, so these checks hold whatever the blocks' code needs at load time
let CONTRACT = null;
function braceAt(open) { return SCAN.braces.find((b) => b.open === open) || null; }
function loadContract() {
    if (CONTRACT) return CONTRACT;
    const head = 'V23.CONTRACT = Object.freeze(';
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, 'V23.CONTRACT is defined');
    assert.equal(SRC.indexOf(head, at + 1), -1, 'V23.CONTRACT is defined once');
    const core = JS.blocks.find((b) => b.name === 'CORE');
    assert.ok(core && at > core.start && at < core.end, 'V23.CONTRACT is in the CORE block');
    const b = braceAt(at + head.length);
    assert.ok(b && b.close > 0, 'the contract literal closes');
    const lit = vm.runInContext('Object.freeze(' + SRC.slice(b.open, b.close + 1) + ')', vm.createContext({}), { filename: 'V23.CONTRACT' });
    CONTRACT = JSON.parse(JSON.stringify(lit));   // plain data in this realm
    return CONTRACT;
}

// ---- the contract's functions, found in the source of their blocks (design 2.2) --------------------------------------
// A function counts as defined when its block holds one of these forms (on the module object or added to it):
//   name: function (args) {      name(args) {      name: (args) => ...      .name = function (args) {      .name = (args) =>
const KIND_STUB = { void: 'null', bool: 'false', list: '[]', obj: 'null', size: '6', mult: '1' };
const splitParams = (p) => {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of p) {
        if ('([{'.indexOf(ch) >= 0) depth++;
        else if (')]}'.indexOf(ch) >= 0) depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
};
function findDef(blockNames, name) {
    const id = name.replace(/\$/g, '\\$');
    const forms = [
        new RegExp('(?:^|[^\\w$.])' + id + '\\s*:\\s*(?:async\\s+)?function\\b\\s*\\*?\\s*[\\w$]*\\s*\\(([^)]*)\\)\\s*\\{', 'g'),
        new RegExp('(?:^|[^\\w$.])' + id + '\\s*\\(([^)]*)\\)\\s*\\{', 'g'),
        new RegExp('(?:^|[^\\w$.])' + id + '\\s*:\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>', 'g'),
        new RegExp('\\.' + id + '\\s*=\\s*(?:async\\s+)?function\\b\\s*[\\w$]*\\s*\\(([^)]*)\\)\\s*\\{', 'g'),
        new RegExp('\\.' + id + '\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>', 'g')
    ];
    const found = [];
    for (const bn of blockNames) {
        const blk = JS.blocks.find((x) => x.name === bn);
        if (!blk) continue;
        const code = SCAN.codeOnly.slice(blk.start, blk.end);
        for (const re of forms) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(code))) {
                const end = blk.start + m.index + m[0].length;
                const bodyBrace = SRC[end - 1] === '{' ? braceAt(end - 1) : null;
                const body = bodyBrace ? SCAN.codeOnly.slice(bodyBrace.open + 1, bodyBrace.close).trim() : null;
                found.push({ block: bn, params: splitParams(m[1]), line: htmlLine(blk.start + m.index), body });
            }
        }
    }
    return found;
}
const literalReturn = (body) => { const m = body && /^return\s+(null|false|true|\[\s*\]|-?\d+(?:\.\d+)?)\s*;?$/.exec(body); return m ? m[1].replace(/\s+/g, '') : null; };

test('V23.CONTRACT: every function is defined in its block with the declared arguments; untouched stubs stay inert', () => {
    const c = loadContract();
    assert.ok(Number.isInteger(c.version) && c.version >= 0, 'a contract version');
    const blockNames = new Set(JS.blocks.map((b) => b.name));
    assert.deepEqual(Object.keys(c.modules).sort(), Object.keys(c.api).sort(), 'V23.CONTRACT.modules names the block of every API module');
    const problems = [];
    let stubbed = 0;
    for (const [mod, fns] of Object.entries(c.api)) {
        const blocks = c.modules[mod];
        for (const bn of blocks) if (!blockNames.has(bn)) problems.push(`${mod}: no block ${bn}`);
        // the module is attached in one of its blocks
        const attach = blocks.some((bn) => { const b = JS.blocks.find((x) => x.name === bn); return b && new RegExp('V23\\.' + mod + '\\s*=').test(SCAN.codeOnly.slice(b.start, b.end)); });
        if (!attach) problems.push(`V23.${mod} is never assigned in ${blocks.join(' / ')}`);
        const defs = {};
        for (const [fn, sig] of Object.entries(fns)) {
            const m = /^(\w+)\(([^)]*)\) -> (\w+)$/.exec(sig);
            if (!m || m[1] !== fn) { problems.push(`${mod}.${fn}: bad signature ${sig}`); continue; }
            if (!(m[3] in KIND_STUB)) { problems.push(`${mod}.${fn}: unknown kind ${m[3]}`); continue; }
            const want = m[2].trim() ? m[2].split(',').map((x) => x.trim()) : [];
            const found = findDef(blocks, fn);
            if (!found.length) { problems.push(`V23.${mod}.${fn} is not defined in ${blocks.join(' / ')}`); continue; }
            const d = found[0];
            const rest = d.params.some((x) => x.startsWith('...'));
            if (!rest && d.params.length !== want.length) problems.push(`V23.${mod}.${fn} (line ${d.line}) takes ${d.params.length} arguments, the contract says ${want.length} (${sig})`);
            defs[fn] = { kind: m[3], lit: literalReturn(d.body), line: d.line };
        }
        // While every function of a module is still a one-line literal stub (WP1's skeleton), each must return its
        // kind's inert value. Once a helper fills the module, the stubs left in it are its own business.
        const all = Object.values(defs);
        if (all.length && all.every((d) => d.lit !== null)) {
            for (const [fn, d] of Object.entries(defs)) {
                stubbed++;
                if (d.lit !== KIND_STUB[d.kind]) problems.push(`V23.${mod}.${fn} (line ${d.line}) is a stub returning ${d.lit}, not ${KIND_STUB[d.kind]} (${d.kind})`);
            }
        }
    }
    // data fields: declared in the module's block(s)
    for (const k of Object.keys(c.fields)) {
        const [mod, f] = k.split('.');
        const blocks = c.modules[mod] || [];
        const ok = blocks.some((bn) => { const b = JS.blocks.find((x) => x.name === bn); return b && new RegExp('(?:^|[^\\w$.])' + f + '\\s*:|\\.' + f + '\\s*=[^=]').test(SCAN.codeOnly.slice(b.start, b.end)); });
        if (!ok) problems.push(`field V23.${k} is not declared in ${blocks.join(' / ')}`);
    }
    // the shared helpers on V23 itself
    const coreCode = (() => { const b = JS.blocks.find((x) => x.name === 'CORE'); return SCAN.codeOnly.slice(b.start, b.end); })();
    for (const h of Object.keys(c.helpers || {})) if (!new RegExp('V23\\.' + h + '\\s*=\\s*function\\b').test(coreCode)) problems.push(`V23.${h} is not defined in CORE`);
    assert.deepEqual(problems, []);
    assert.ok(stubbed >= 0);
});

test('V23.CONTRACT: the data the design fixes (gestures, kit modules, instanceKit, clocks, materials, settings, markers, boot order)', () => {
    const c = loadContract();
    assert.deepEqual(Object.keys(c.gestures).map(Number), [7, 8, 9, 10, 11]);
    assert.deepEqual([c.gestures[7], c.gestures[8], c.gestures[9], c.gestures[10], c.gestures[11]], ['throw', 'channel', 'snap/tap', 'place/slam', 'ready dip']);
    assert.equal(c.kitModules.length, 24);
    assert.equal(c.kitModules[0], 'helmShell');
    assert.equal(c.kitModules[23], 'orbHand');
    assert.equal(new Set(c.kitModules).size, 24, 'kit module names are distinct');
    for (const k of ['x', 'y', 'z', 'w']) assert.ok(c.instanceKit[k], `instanceKit.${k}`);
    for (const k of ['display', 'real', 'audio', 'game', 'sim', 'replay']) assert.ok(c.clocks[k], `clock ${k}`);
    assert.match(c.materialRule, /V23\.mat/);
    assert.deepEqual(c.settings, { agentIdentity: ['on', 'off'], weaponAnims: ['v23', 'classic'], botUtility: ['classic', 'agent'] });
    assert.deepEqual(c.helpers, { rand: 'rand(seed) -> fn', seeded: 'seeded(fn, rng) -> any' });
    // the marker forms written in the contract are the ones this test enforces
    assert.equal(c.markers.block, '// ===== V2.3 BLOCK <NAME> [WPn] =====');
    assert.equal(c.markers.blockEnd, '// ===== END V2.3 BLOCK <NAME> =====');
    assert.equal(c.markers.css, '/* ===== V2.3 CSS <NAME> [WPn] ===== */');
    assert.equal(c.markers.cssEnd, '/* ===== END V2.3 CSS <NAME> ===== */');
    assert.equal(c.markers.region, '// V2.3 REGION <id> [WPn]');
    const form = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace('<NAME>', '[A-Z][A-Z-]*').replace('\\[WPn\\]', '\\[WP\\d+(?:,WP\\d+)*\\]'));
    for (const b of JS.blocks) assert.match(SRC.slice(b.start, b.end).split('\n')[0], form(c.markers.block), `${b.name} start marker`);
    for (const b of CSSB.blocks) assert.match(STYLE.slice(b.start, b.end).split('\n')[0], form(c.markers.css), `CSS ${b.name} start marker`);
    // the indirections and the helpers that are safe inside V23.seeded
    assert.deepEqual(Object.keys(c.indirections).sort(), ['fxKit._rng', 'soundFX._out', 'soundFX._rand']);
    assert.deepEqual(c.seededSafe, ['fxKit._emit', 'fxKit.burst', 'fxKit.ring', 'fxKit.smokeCloud', 'fxKit.smokeShell', 'fxKit.embers',
        'abilityLook.emit', 'abilityLook.spray', 'soundFX.playNoise', 'soundFX.noiseLayer', 'soundFX.playTone', 'soundFX.gunshot']);
    // the boot order names only contract functions, each once (identity-budget checks it against a real boot)
    assert.equal(new Set(c.bootOrder).size, c.bootOrder.length, 'boot order entries are distinct');
    for (const e of c.bootOrder) { const [mod, fn] = e.split('.'); assert.ok(c.api[mod] && c.api[mod][fn], `boot order entry ${e} is a contract function`); }
    for (const e of ['fp.attach', 'fp.initCast', 'core.applySettings', 'core.init', 'core.warmPre', 'core.warmPost']) assert.ok(c.bootOrder.includes(e), e);
    const ix = (e) => c.bootOrder.indexOf(e);
    assert.ok(ix('fp.attach') < ix('fp.initCast') && ix('fp.initCast') < ix('core.applySettings') && ix('core.applySettings') < ix('core.init') && ix('core.init') < ix('core.warmPre') && ix('core.warmPre') < ix('core.warmPost'),
        'H13 attach, H16.1 initCast, H33.3 applySettings(cfg, null), H2 init, H3 warm, in that order');
});

// V23.rand and V23.seeded: their two statements only, evaluated on their own (they need nothing else from CORE)
function loadHelpers() {
    const ctx = vm.createContext({});
    vm.runInContext('var V23 = {}; var __randomCalls = 0; Math.random = function () { __randomCalls++; return 0.5; };' +
        'var fxKit = { _rng: null }; var soundFX = { _rand: null };', ctx);
    for (const head of ['V23.rand = function (seed) {', 'V23.seeded = function (fn, rng) {']) {
        const at = SRC.indexOf(head);
        assert.ok(at >= 0, head);
        const b = braceAt(at + head.length - 1);
        assert.ok(b && b.close > 0, head + ' closes');
        vm.runInContext(SRC.slice(at, b.close + 1) + ';', ctx, { filename: head });
    }
    return ctx;
}

test('V23.rand is mulberry32 and V23.seeded sets and restores the call-time indirections (rng required)', () => {
    const ctx = loadHelpers();
    const V = vm.runInContext('V23', ctx);
    const r = V.rand(1);
    assert.deepEqual([r(), r(), r()], [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
    const a = V.rand(7), b = V.rand(7);
    for (let i = 0; i < 50; i++) assert.equal(a(), b(), 'the same seed gives the same stream');
    const inside = JSON.parse(vm.runInContext(`(function () {
        const s = V23.rand(9), seen = [];
        const out = V23.seeded(function (rr) { seen.push(fxKit._rng === s, soundFX._rand === s, rr === s); return 42; }, s);
        let threw = false, noRng = false;
        try { V23.seeded(function () { throw new Error('x'); }, s); } catch (e) { threw = true; }
        try { V23.seeded(function () { return 1; }); } catch (e) { noRng = e instanceof TypeError; }
        return JSON.stringify({ out, seen, threw, noRng, after: [fxKit._rng, soundFX._rand] });
    })()`, ctx));
    assert.equal(inside.out, 42);
    assert.deepEqual(inside.seen, [true, true, true]);
    assert.ok(inside.threw);
    assert.ok(inside.noRng, 'V23.seeded without a stream throws a TypeError (no shared fallback stream)');
    assert.deepEqual(inside.after, [null, null], 'restored to null, also after a throw');
    assert.equal(vm.runInContext('__randomCalls', ctx), 0);
});

test("the V2.2 file is unchanged (SHA-256 equal to main's)", () => {
    const here = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, V22_FILE))).digest('hex');
    let main = null;
    try {
        const buf = execFileSync('git', ['show', `${V22_MAIN_COMMIT}:${V22_FILE}`], { cwd: REPO, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
        main = crypto.createHash('sha256').update(buf).digest('hex');
    } catch (e) { main = null; }   // a shallow clone has no b19aacf: the recorded hash stands in
    if (main) assert.equal(main, V22_MAIN_SHA256, 'the recorded hash is main\'s');
    assert.equal(here, main || V22_MAIN_SHA256);
});

test('the two V2.3 labels and the markup placeholders are present', () => {
    assert.ok(HTML.indexOf('<div class="loading-text">VALORANT 3D FPS // V2.3 RADIANT EDITION</div>') >= 0, 'loading screen label');
    assert.ok(HTML.indexOf('<div class="mm-sub">V2.3 RADIANT EDITION</div>') >= 0, 'main menu label');
    assert.ok(!/V2\.2 RADIANT EDITION/.test(HTML), 'no V2.2 label left');
    for (const sel of ['id="agent-stage"', 'id="mm-stage"', 'class="mvp-pose"', 'id="ult-cue"']) assert.equal(HTML.split(sel).length - 1, 1, sel);
    const css = CSSB.blocks.map((b) => STYLE.slice(b.start, b.end)).join('\n');
    assert.match(css, /#agent-stage, #mm-stage \{ display: none; \}/);
    assert.match(css, /#ult-cue \{ display: none;/);
    assert.match(css, /\.mvp-pose \{ display: none; \}/);
});

// ---- Math.random: the V2.2 call sites, in order -----------------------------------------------------------------------
// The indirections V2.3 puts in place of a Math.random() call (null by default: the same call), and the functions they
// may sit in (V23.CONTRACT.indirections)
const INDIRECTION = /\((?:this|fxKit)\._(?:rand|rng) \|\| Math\.random\)\(\)/g;
const INDIRECTION_FNS = {
    'fxKit._emit': 1, 'fxKit.burst': 11, 'fxKit.ring': 3, 'fxKit.smokeCloud': 4, 'fxKit.smokeShell': 4, 'fxKit.embers': 8,
    'abilityLook.spray': 7, 'soundFX.playNoise': 1, 'soundFX.noiseLayer': 1, 'soundFX.gunshot': 1
};
function randomSites(src, scan, skip) {
    const ls = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') ls.push(i + 1);
    const lineAt = (pos) => { let lo = 0, hi = ls.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ls[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
    const opens = scan.braces.filter((b) => b.label && b.label !== '=>').sort((a, b) => a.open - b.open);
    const chain = (pos) => opens.filter((b) => b.open < pos && (b.close < 0 || b.close > pos)).map((b) => b.label).join('.');
    const sites = [];
    const re = /\((?:this|fxKit)\._(?:rand|rng) \|\| Math\.random\)\(\)|Math\.random\(\)/g;
    let m;
    while ((m = re.exec(scan.codeOnly))) {
        if (skip && skip(m.index)) continue;
        const ln = lineAt(m.index);
        const text = scan.noComments.slice(ls[ln], (ls[ln + 1] || src.length + 1) - 1).replace(INDIRECTION, 'Math.random()').replace(/\s+/g, ' ').trim();
        sites.push({ key: chain(m.index) + ' | ' + text, indirect: m[0] !== 'Math.random()', fn: chain(m.index), pos: m.index });
    }
    return sites;
}

test('every V2.2 Math.random() call site is still there, in the same order (the indirections are null by default)', () => {
    const v22 = mainScript(fs.readFileSync(path.join(REPO, V22_FILE), 'utf8')).text;
    const a = randomSites(v22, scan(v22), null);
    const b = randomSites(SRC, SCAN, (pos) => !!blockAt(pos));
    assert.equal(a.length, 261, 'V2.2 (frozen) has 261 Math.random() call sites');
    assert.equal(b.length, a.length, 'V2.3 has as many, outside its blocks (indirections included)');
    // the same sequence of (enclosing function chain, line) with each indirection read as Math.random()
    const n = Math.max(a.length, b.length);
    let first = -1;
    for (let i = 0; i < n; i++) if (!a[i] || !b[i] || a[i].key !== b[i].key) { first = i; break; }
    assert.equal(first, -1, first < 0 ? '' : `site ${first} differs:\n  V2.2: ${a[first] && a[first].key}\n  V2.3: ${b[first] && b[first].key} (line ${b[first] ? htmlLine(b[first].pos) : '-'})`);
    // the indirections sit only where V23.CONTRACT.indirections says, as many as there are draws there
    const got = {};
    for (const s of b) if (s.indirect) {
        const parts = s.fn.split('.');
        const k = parts[0] + '.' + parts[parts.length - 1];
        got[k] = (got[k] || 0) + 1;
    }
    assert.deepEqual(got, INDIRECTION_FNS);
    assert.equal((SCAN.codeOnly.match(INDIRECTION) || []).length, 41, 'the 41 indirections');
    // and each indirection's field starts null, inside its own object literal
    const objAt = (name) => SCAN.braces.find((x) => x.kind === 'obj' && x.label === name && x.depth === 0);
    for (const [obj, field] of [['fxKit', '_rng'], ['soundFX', '_rand'], ['soundFX', '_out']]) {
        const o = objAt(obj);
        assert.ok(o, `${obj} literal`);
        const re = new RegExp('(?:^|\\n)\\s*' + field + ': null,', 'g');
        const body = SRC.slice(o.open, o.close);
        let m, n = 0;
        while ((m = re.exec(body))) {
            const pos = o.open + m.index + m[0].indexOf(field);
            const inner = chainAt(pos);
            if (inner[inner.length - 1] === o) n++;
        }
        assert.equal(n, 1, `${obj}.${field} starts null in the ${obj} literal`);
    }
});
