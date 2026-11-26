'use strict';
// V2.2: High Fidelity looks, Controllers (their role block in the game file; HIFI-CONTRACT.md). Add each
// converted ability with the key>renderer pairs it binds; roleTest checks it and the role's budget.
// key>absorb: a ring the look claims (tagged in the ability's own code, or carried by its detonation)
require('./hifi-kit').roleTest('Controllers', {
    'omen.c': ['omen.c>groundZone', 'omen.c>beam', 'omen.c>self'],
    'omen.q': ['omen.q>projectile'],
    'omen.x': ['omen.x>groundZone', 'omen.x>beam', 'omen.x>self'],
    'brimstone.c': ['brimstone.c>deployable', 'brimstone.c>groundZone', 'brimstone.c>absorb', 'brimstone.c>self'],
    'brimstone.q': ['brimstone.q>projectile', 'brimstone.q>groundZone'],
    'brimstone.e': ['brimstone.e>projectile', 'brimstone.e>smoke'],
    'brimstone.x': ['brimstone.x>beam', 'brimstone.x>groundZone'],
    'viper.c': ['viper.c>projectile', 'viper.c>groundZone'],
    'viper.q': ['viper.q>projectile', 'viper.q>smoke'],
    'viper.e': ['viper.e>wall', 'viper.e>groundZone'],
    'viper.x': ['viper.x>smoke', 'viper.x>groundZone'],
    'clove.c': ['clove.c>flash', 'clove.c>absorb', 'clove.c>self'],
    'clove.q': ['clove.q>projectile', 'clove.q>blast', 'clove.q>absorb'],
    'clove.e': ['clove.e>smoke', 'clove.e>absorb'],
    'clove.x': ['clove.x>flash', 'clove.x>absorb', 'clove.x>self'],
    'harbor.c': ['harbor.c>wall', 'harbor.c>blast'],
    'harbor.q': ['harbor.q>projectile', 'harbor.q>blast', 'harbor.q>smoke'],
    'harbor.e': ['harbor.e>wall', 'harbor.e>groundZone', 'harbor.e>absorb'],
    'harbor.x': ['harbor.x>groundZone', 'harbor.x>deployable', 'harbor.x>absorb', 'harbor.x>blast'],
    'astra.c': ['astra.c>groundZone', 'astra.c>flash', 'astra.c>absorb', 'astra.c>blast'],
    'astra.q': ['astra.q>flash', 'astra.q>groundZone', 'astra.q>absorb', 'astra.q>blast'],
    'astra.e': ['astra.e>smoke', 'astra.e>absorb'],
    'astra.x': ['astra.x>groundZone', 'astra.x>wall', 'astra.x>flash', 'astra.x>absorb'],
    'miks.c': ['miks.c>projectile', 'miks.c>blast', 'miks.c>absorb', 'miks.c>pulse', 'miks.c>deployable'],
    'miks.q': ['miks.q>self', 'miks.q>absorb'],
    'miks.e': ['miks.e>smoke', 'miks.e>absorb'],
    'miks.x': ['miks.x>groundZone', 'miks.x>pulse', 'miks.x>absorb', 'miks.x>blast']
}, {
    recipes: {
        'harbor.c': { again: 1200 },       // C again anchors the wave: its splash
        'harbor.x': { target: [0, 14] }    // a bot in the pool's path: its geysers
    }
});
