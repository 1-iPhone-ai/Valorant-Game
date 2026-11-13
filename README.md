# Valorant-Game

A single-file browser FPS built on Three.js r128. Open the latest `(V1.x) valorant-fps.html` in a browser to play.

Earlier versions are kept as separate files.

## Controls

- **Keyboard and mouse:** press **P** in game for settings and keybinds.
- **Controller (PS4 / PS5 / Xbox):** connect it and press any button. The full layout is in **Settings → Controls → Controller**.

## Regression tests

The `tests/` folder holds headless browser tests. They need no GPU, because Chromium renders WebGL in software. They check:

- **Load:** the game loads without errors.
- **Shader compiles:** none happen after warm-up, including when switching quality.
- **Abilities:** every agent's abilities and ultimate cast, and ground effects stay circular.
- **Maps and modes:** all 6 maps × 3 atmosphere modes.
- **Controller:** input works through a simulated gamepad.
- **Game modes:** Wave, Retake and the 30-bot Range play through planting, defusing, detonation, round changes and the range scorecard.
- **HUD and settings:** the HUD has no overlapping panels at common window sizes, and settings survive a reload (and the opt-out sticks).
- **Audio and hit feedback:** 3D enemy audio and hit feedback work.
- **Cinematic quality:** the level above Ultra is never picked by Auto; its post-processing (AO, bloom, sun shafts, grading, FXAA) compiles in the warm-up, adds no shader programs when switched on, keeps the overall exposure, and turns on both High Detail settings.
- **Match mode and death recap:** buy-phase lock, round wins and losses with economy, no respawn mid-round, plant/detonate and bot plant/defuse, halftime swap, bots routing to a site on their own, victory screen, and the death recap in Match and Wave modes.
- **Music, ambience and HUD size:** music and ambience are off by default, play per map when switched on and fade out when switched off; HUD Size 80–130% scales every panel with no overlaps at 1280×720, 1920×1080 and 1024×600.
- **Accessibility and bot skill:** Reduce Flashes softens washes and flashbangs and stops the low-health pulse; the cyan colour-blind option recolours bots; bot tactics scale with Bot Skill (Iron never flanks, Radiant peeks pre-aimed).
- **Bot tactics:** every map has cover spots; hurt bots take cover out of sight, peek to shoot and never fire while running; pairs flank, and a bot whose partner dies takes cover.
- **Bot colours and animation:** bots spawn in their archetype colours, they walk, flinch, recoil and topple over when killed, and their hitboxes stay fixed.
- **High detail characters and guns:** the setting is off by default; when on, bots, wingmen, guns and hands are drawn with rounded, detailed shapes while hitboxes, weapon skins and shaders stay unchanged.
- **High detail maps:** the setting is off by default; when on, it adds textures and props on all 6 maps without new shader compiles or a brightness shift, and the Low profile turns it off.

```bash
cd tests
npm ci
npx playwright install chromium
npm test
```

GitHub Actions runs these tests on every pull request and on pushes to `main`. To test a different file, set `GAME_FILE` (a path relative to the repo root).
