module.exports = {
  testEnvironment: 'node',
  // Lambda handlers import the layer as /opt/nodejs/...; map it to this folder so they can be tested.
  moduleNameMapper: { '^/opt/nodejs/(.*)$': '<rootDir>/$1' },
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'db/**/*.js',
    'utils/**/*.js',
    'middleware/**/*.js',
    'services/**/*.js',
    '!**/node_modules/**',
  ],
};
