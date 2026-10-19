const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
module.exports = {
  chromium,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || (() => {
    if (process.platform !== 'win32') return undefined;
    const edge = path.join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
    return fs.existsSync(edge) ? edge : undefined;
  })(),
};
