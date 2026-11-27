'use strict';
// V2.2: High Fidelity looks, Initiators (their role block in the game file; the API is in abilityLook's header). Add each
// converted ability with the key>renderer pairs it binds; roleTest checks it and the role's budget.
// 'absorb': a Classic piece another renderer draws (a blast's or a pulse's ring), so it is routed too.
require('./hifi-kit').roleTest('Initiators', {
    'sova.e': ['sova.e>projectile', 'sova.e>pulse', 'sova.e>deployable'],
    'kayo.c': ['kayo.c>projectile', 'kayo.c>groundZone', 'kayo.c>blast'],
    'breach.q': ['breach.q>projectile', 'breach.q>flash'],
    'sova.c': ['sova.c>projectile', 'sova.c>smoke'],
    'kayo.q': ['kayo.q>projectile', 'kayo.q>flash'],
    'kayo.e': ['kayo.e>projectile', 'kayo.e>deployable', 'kayo.e>pulse', 'kayo.e>absorb'],
    'kayo.x': ['kayo.x>self', 'kayo.x>pulse', 'kayo.x>absorb'],
    'skye.c': ['skye.c>self', 'skye.c>pulse'],
    'skye.q': ['skye.q>deployable', 'skye.q>blast', 'skye.q>absorb'],
    'skye.e': ['skye.e>projectile', 'skye.e>flash', 'skye.e>absorb'],
    'skye.x': ['skye.x>deployable', 'skye.x>flash', 'skye.x>absorb'],
    'fade.c': ['fade.c>deployable', 'fade.c>flash', 'fade.c>absorb'],
    'fade.q': ['fade.q>projectile', 'fade.q>groundZone', 'fade.q>absorb'],
    'fade.e': ['fade.e>projectile', 'fade.e>deployable', 'fade.e>pulse', 'fade.e>absorb'],
    'fade.x': ['fade.x>wall', 'fade.x>pulse'],
    'breach.c': ['breach.c>groundZone', 'breach.c>blast', 'breach.c>absorb'],
    'breach.x': ['breach.x>pulse', 'breach.x>absorb'],
    'gekko.c': ['gekko.c>projectile', 'gekko.c>groundZone', 'gekko.c>blast', 'gekko.c>absorb'],
    'gekko.q': ['gekko.q>deployable', 'gekko.q>blast', 'gekko.q>absorb', 'gekko.q>projectile'],
    'gekko.e': ['gekko.e>deployable', 'gekko.e>flash', 'gekko.e>projectile'],
    'gekko.x': ['gekko.x>deployable', 'gekko.x>blast', 'gekko.x>absorb', 'gekko.x>projectile'],
    'tejo.c': ['tejo.c>deployable', 'tejo.c>pulse', 'tejo.c>absorb'],
    'tejo.q': ['tejo.q>projectile', 'tejo.q>blast', 'tejo.q>absorb'],
    'tejo.e': ['tejo.e>groundZone', 'tejo.e>blast', 'tejo.e>absorb'],
    'tejo.x': ['tejo.x>groundZone', 'tejo.x>blast', 'tejo.x>absorb']
});
