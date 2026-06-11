'use strict';

// electron-builder only uses its pure-JS NSIS uninstaller extractor on macOS
// Catalina+ (where 32-bit wine died); on Linux it shells out to `wine` to run
// the 32-bit NSIS stub, which fails on wine builds without wine32. The JS
// extractor works everywhere, so force it before the NSIS target loads.
if (process.platform === 'linux') {
    const macosVersion = require('app-builder-lib/out/util/macosVersion');
    macosVersion.isMacOsCatalina = () => true;
}

const builder = require('electron-builder');

builder.build({ targets: builder.Platform.WINDOWS.createTarget() })
    .then(artifacts => { for (const a of artifacts) console.log('built:', a); })
    .catch(err => { console.error(err); process.exit(1); });
