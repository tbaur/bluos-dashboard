import '@testing-library/jest-dom/vitest';

// jsdom has no layout engine; without this, route changes print "Not implemented".
Object.defineProperty(window, 'scrollTo', {
  value: () => undefined,
  writable: true,
});
