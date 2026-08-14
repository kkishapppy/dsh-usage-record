/** dsh-usage-record 双 half 构建：Node（esm）+ 官方 client bundle（cjs，__ModuleLoader__ 契约）。 */
export default [
  {
    entry: ['src/index.mjs'],
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    outDir: 'lib',
    clean: true,
  },
  {
    name: 'dsh-usage-record/client',
    entry: { client: 'src/client/usage-record.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    external: [/@deepseek-ai\/dsh-client-/, 'react', 'react-dom'],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-usage-record", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
