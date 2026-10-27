/* Import @icons0/bi through shadcn; ship only selected SVG paths to the vanilla client. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const workspace = path.join(root, 'runtime/icons0');
const sourceArg = process.argv.indexOf('--source');
const sourceRoot = sourceArg >= 0 ? path.resolve(process.argv[sourceArg + 1]) : workspace;
const registry = 'https://icons0.dev/r/{name}.json';

if (sourceArg < 0) {
  fs.mkdirSync(workspace, { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(workspace, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  write('package.json', { name: 'vidcreator-icon-source', private: true, registries: { '@icons0': registry } });
  write('tsconfig.json', { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } });
  write('styles.css', '/* Registry import workspace; not part of the application. */\n');
  write('components.json', {
    $schema: 'https://ui.shadcn.com/schema.json', style: 'new-york', rsc: false, tsx: true,
    tailwind: { config: '', css: 'styles.css', baseColor: 'neutral', cssVariables: true },
    aliases: { components: '@/components', utils: '@/lib/utils', ui: '@/components/ui', lib: '@/lib', hooks: '@/hooks' },
    registries: { '@icons0': registry },
  });
  const args = ['--yes', 'shadcn@latest', 'add', '@icons0/bi', '--yes', '--overwrite', '--silent', '--cwd', workspace];
  if (process.platform === 'win32') {
    const quote = value => "'" + value.replace(/'/g, "''") + "'";
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& npx ${args.map(quote).join(' ')}`], { stdio: 'inherit', windowsHide: true });
  } else execFileSync('npx', args, { stdio: 'inherit' });
}

const names = require('./icons0-bi.json');
const symbols = names.map(name => {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid icon name');
  const content = fs.readFileSync(path.join(sourceRoot, 'components/icons/bi', name + '.tsx'), 'utf8');
  const match = content.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/);
  if (!match) throw new Error(`Missing SVG: ${name}`);
  const body = match[1].replace(/\b(fillRule|clipRule|strokeWidth|strokeLinecap|strokeLinejoin|clipPath)\b/g, attribute => attribute.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()));
  if (/<(?:script|foreignObject|image|use)\b|\bon\w+=|\{/.test(body)) throw new Error(`Unexpected SVG content: ${name}`);
  // Bootstrap Icons use a native 16×16 grid; the registry wrapper defaults to 24×24.
  return `<symbol id="bi-${name}" viewBox="0 0 16 16">${body}</symbol>`;
});
const output = path.join(root, 'public/icons');
fs.mkdirSync(output, { recursive: true });
const sprite = `<!-- Bootstrap Icons via icons0.dev / @icons0/bi. MIT. See LICENSE-bootstrap-icons.txt. -->\n<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join('\n')}\n</svg>\n`;
fs.writeFileSync(path.join(output, 'bi.svg'), sprite);
fs.writeFileSync(path.join(output, 'bi-manifest.json'), JSON.stringify({ registry, collection: '@icons0/bi', license: 'MIT', nativeViewBox: '0 0 16 16', sha256: crypto.createHash('sha256').update(sprite).digest('hex'), names }, null, 2) + '\n');
console.log(`Built ${names.length} local icons (${Buffer.byteLength(sprite)} bytes).`);
