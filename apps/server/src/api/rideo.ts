import type { FastifyInstance } from 'fastify';
import type { ServerServices } from '../services';

/*
 * REST routes of the rideo bridge (SPEC §11, phase 2): POST /api/rideo/previs. Registered by
 * app.ts with the server's services; nothing yet.
 */

export function registerRideoRoutes(_app: FastifyInstance, _services: ServerServices): void {
  // phase 2: POST /api/rideo/previs
}
