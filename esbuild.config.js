const esbuild = require('esbuild');
const fs = require('fs');
const isWatch = process.argv.includes('--watch');

const buildOptions = {
  bundle: true,
  platform: 'browser',
  target: 'es6',
  logLevel: 'info',
};

function inlineUiJs() {
  const js = fs.readFileSync('ui.js', 'utf8');
  let html = fs.readFileSync('ui.html', 'utf8');
  // Handle both: initial src ref and already-inlined script (for watch rebuilds)
  html = html.replace(
    /<script src="ui\.js"><\/script>|<script>\n[\s\S]*?\n<\/script>/,
    `<script>\n${js}\n</script>`
  );
  fs.writeFileSync('ui.html', html, 'utf8');
}

async function build() {
  if (isWatch) {
    const mainCtx = await esbuild.context({
      ...buildOptions,
      entryPoints: ['src/code.ts'],
      outfile: 'code.js',
    });
    const uiCtx = await esbuild.context({
      ...buildOptions,
      entryPoints: ['src/ui.ts'],
      outfile: 'ui.js',
      plugins: [{
        name: 'inline-ui',
        setup(build) {
          build.onEnd(() => inlineUiJs());
        },
      }],
    });
    await Promise.all([mainCtx.watch(), uiCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    esbuild.buildSync({ ...buildOptions, entryPoints: ['src/code.ts'], outfile: 'code.js' });
    esbuild.buildSync({ ...buildOptions, entryPoints: ['src/ui.ts'], outfile: 'ui.js' });
    inlineUiJs();
    console.log('Build complete.');
  }
}

build().catch(console.error);
