/** Registers all built-in modifier types (idempotent). Modifier modules are added here. */
let registered = false;

export function registerBuiltinModifiers(): void {
  if (registered) return;
  registered = true;
}
