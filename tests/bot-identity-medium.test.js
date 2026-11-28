'use strict';
// V2.3 (WP6): tests/bot-identity.test.js on the Medium content tier (the design's budget tier, section 15: four bots, the
// rounded figure with its weapon part, the 1,026-vertex kit superset, rim weight 0.18), forced through the saved
// contentTierMode whatever the machine's own tier is. One boot, at most 4 minutes.
process.env.BOT_IDENTITY_TIER = 'medium';
require('./bot-identity.test.js');
