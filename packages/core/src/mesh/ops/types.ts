import type { MeshData } from '../types';
import type { MeshSelection } from '../selection';

/** Result of an edit-mode mesh operation. */
export interface MeshOpResult {
  mesh: MeshData;
  selection: MeshSelection;
}
