'use strict';
// V2.2: High Fidelity looks, Controllers (their role block in the game file; HIFI-CONTRACT.md). Add each
// converted ability with the key>renderer pairs it binds; roleTest checks it and the role's budget.
require('./hifi-kit').roleTest('Controllers', {
    'viper.q': ['viper.q>projectile', 'viper.q>smoke'],
    'brimstone.x': ['brimstone.x>beam', 'brimstone.x>groundZone']
});
