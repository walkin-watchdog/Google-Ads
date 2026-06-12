import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const clientRoot = path.join(root, 'client');
const nodeModules = path.join(root, 'node_modules');
const vendorDir = path.join(clientRoot, 'vendor');
const fontsDir = path.join(clientRoot, 'fonts');

function ensureFile(filePath: string): void {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`Required client asset source is missing: ${filePath}`);
    }
}

function copyFile(source: string, destination: string): void {
    ensureFile(source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

function copyScript(source: string, destination: string): void {
    ensureFile(source);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const contents = fs.readFileSync(source, 'utf8')
        .replace(/^\/\/[#@]\s*sourceMappingURL=.*(?:\r?\n|$)/gm, '');
    fs.writeFileSync(destination, contents);
}

function cleanDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
}

function moduleFile(...parts: string[]): string {
    return path.join(nodeModules, ...parts);
}

function copyFont(family: 'inter' | 'outfit', weight: number): string {
    const file = `${family}-latin-${weight}-normal.woff2`;
    copyFile(moduleFile('@fontsource', family, 'files', file), path.join(fontsDir, file));
    return file;
}

cleanDir(vendorDir);
cleanDir(fontsDir);

copyScript(moduleFile('jquery', 'dist', 'jquery.min.js'), path.join(vendorDir, 'jquery.min.js'));
copyScript(moduleFile('moment', 'min', 'moment.min.js'), path.join(vendorDir, 'moment.min.js'));
copyScript(moduleFile('daterangepicker', 'daterangepicker.js'), path.join(vendorDir, 'daterangepicker.js'));
copyFile(moduleFile('daterangepicker', 'daterangepicker.css'), path.join(vendorDir, 'daterangepicker.css'));
copyScript(moduleFile('chart.js', 'dist', 'chart.umd.min.js'), path.join(vendorDir, 'chart.umd.min.js'));
copyScript(moduleFile('chartjs-chart-sankey', 'dist', 'chartjs-chart-sankey.min.js'), path.join(vendorDir, 'chartjs-chart-sankey.min.js'));
copyScript(moduleFile('ag-grid-community', 'dist', 'ag-grid-community.min.js'), path.join(vendorDir, 'ag-grid-community.min.js'));
copyScript(moduleFile('idb', 'build', 'umd.js'), path.join(vendorDir, 'idb.umd.js'));

const fontFaces: string[] = [];
for (const weight of [300, 400, 500, 600, 700]) {
    const file = copyFont('inter', weight);
    fontFaces.push(`@font-face{font-family:Inter;font-style:normal;font-weight:${weight};font-display:swap;src:url('./${file}') format('woff2');}`);
}
for (const weight of [400, 500, 600, 700]) {
    const file = copyFont('outfit', weight);
    fontFaces.push(`@font-face{font-family:Outfit;font-style:normal;font-weight:${weight};font-display:swap;src:url('./${file}') format('woff2');}`);
}
fs.writeFileSync(path.join(fontsDir, 'fonts.css'), `${fontFaces.join('\n')}\n`);

console.log(`[client-assets] copied vendor and font assets into ${clientRoot}`);
