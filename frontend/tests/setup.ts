import '@testing-library/jest-dom/vitest';

// jsdom has no layout engine; without this, route changes print "Not implemented".
Object.defineProperty(window, 'scrollTo', {
  value: () => undefined,
  writable: true,
});

// jsdom does not implement the dialog top layer.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}
