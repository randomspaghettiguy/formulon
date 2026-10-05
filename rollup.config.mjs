import terser from '@rollup/plugin-terser';

export default {
  input: 'src/formulon.js',
  output: [
    // Bundlers (Vite, webpack) and modern Node
    { file: 'lib/formulon.mjs', format: 'esm' },
    // require()
    { file: 'lib/formulon.cjs', format: 'cjs', exports: 'named' },
    // Minified ES module: size budget, and Salesforce LWC static resources
    { file: 'lib/formulon.min.mjs', format: 'esm', plugins: [terser({ module: true, ecma: 2020, compress: { passes: 3 } })] },
  ],
};
