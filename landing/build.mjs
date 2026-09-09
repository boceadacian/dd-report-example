import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { transform } from 'lightningcss';
import { minify } from 'terser';

// Output layout mirrors the public URL: the landing is the root of raportcf.ro.
const OUT = 'dist';
const HTML = ['index.html', 'cerere.html', 'multumim.html', 'raport.html', 'confidentialitate.html', 'termeni.html', 'nota-ai.html'];
const CSS = ['styles.css', 'landing.css'];
const ASSETS = ['favicon.svg', 'apple-touch-icon.png'];
const LINKS = '<link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="landing.css">';

// docker-compose.local.yml bind-mounts dist/: empty it in place, never delete the directory itself,
// or the running Caddy container keeps a stale mount.
await mkdir(OUT, { recursive: true });
for (const entry of await readdir(OUT)) {
    await rm(`${OUT}/${entry}`, { recursive: true, force: true });
}

const source = await readFile('app.js', 'utf-8');
const js = await minify(source, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
if (js.code == null) {
    throw new Error('terser produced no output');
}
await writeFile(`${OUT}/app.js`, js.code);

// Minify both stylesheets and inline them into every page: two small render-blocking CSS
// requests off the critical path (the styles.css -> landing.css chain Lighthouse flags) become
// one <style> block shipped with the HTML, so first paint needs no extra round trips.
const cssSizes = [];
let inlined = '';
for (const file of CSS) {
    const code = await readFile(file);
    const result = transform({ filename: file, code, minify: true });
    inlined += result.code.toString();
    cssSizes.push(`${file} ${code.length} -> ${result.code.length}`);
}
const styleTag = `<style>${inlined}</style>`;

for (const file of HTML) {
    const html = await readFile(file, 'utf-8');
    if (!html.includes(LINKS)) {
        throw new Error(`stylesheet links not found in ${file}; extractor output changed`);
    }
    await writeFile(`${OUT}/${file}`, html.replace(LINKS, styleTag));
}

for (const file of ASSETS) {
    await copyFile(file, `${OUT}/${file}`);
}

console.log(`app.js ${source.length} -> ${js.code.length}; css inlined (${cssSizes.join(', ')}); ${HTML.length} html + ${ASSETS.length} icons -> ${OUT}/`);
