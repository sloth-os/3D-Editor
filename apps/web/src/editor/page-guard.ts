/*
 * What the page around the editor refuses to run, apart from the operators' own polls. The editor
 * (index.html) refuses nothing here. The embeddable desk (desk.html) guards the operator registry
 * (embed/guards.ts): its poll refuses the operators of the chrome the desk hides and, in a read-only
 * open, every operator that changes the scene, and the guard sets `refusal` to the same answer.
 *
 * The registry's poll is what refuses an operator; this is for the UI that acts before an operator
 * runs, or that cannot tell a refusal of the page from an operator's own: menus grey out the UI
 * operators the page refuses (they keep the others enabled whatever their poll says), a slider drag
 * writes no live value that the operator at its release would refuse (ui/properties/prop-edit.ts),
 * and a model file dropped on the viewport is not even read when its import is refused
 * (io/import-export.ts).
 */

/** Why the page refuses operator `id` (null: it does not; the operator's own poll still applies). */
export const pageGuard: { refusal: (id: string) => string | null } = {
  refusal: () => null,
};
