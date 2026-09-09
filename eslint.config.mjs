// Catches exactly the class of bug that shipped: a name used but never imported.
export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        browser: 'readonly', chrome: 'readonly', console: 'readonly',
        document: 'readonly', window: 'readonly', navigator: 'readonly',
        fetch: 'readonly', crypto: 'readonly', indexedDB: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', DOMParser: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly',
        btoa: 'readonly', atob: 'readonly', structuredClone: 'readonly',
        Intl: 'readonly', location: 'readonly', queueMicrotask: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error'
    }
  }
];
