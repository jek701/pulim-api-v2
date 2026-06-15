import { asyncHandler } from '../utils/asyncHandler';
import type { SortOption, UserScopedRepo } from '../repositories/base.repository';

interface CrudOptions {
  sort?: SortOption;
  /** Fields force-merged into every create (e.g. { savedAmount: 0 }). */
  createDefaults?: Record<string, unknown>;
}

/**
 * Express handlers for a user-scoped resource. Request bodies are assumed to have
 * already been validated by the `validate(...)` middleware on the route.
 */
export function crudControllers(repo: UserScopedRepo, opts: CrudOptions = {}) {
  return {
    list: asyncHandler(async (req, res) => {
      res.json(await repo.list(req.uid, opts.sort));
    }),
    get: asyncHandler(async (req, res) => {
      res.json(await repo.get(req.uid, String(req.params.id)));
    }),
    create: asyncHandler(async (req, res) => {
      res.status(201).json(await repo.create(req.uid, req.body, opts.createDefaults));
    }),
    update: asyncHandler(async (req, res) => {
      res.json(await repo.update(req.uid, String(req.params.id), req.body));
    }),
    remove: asyncHandler(async (req, res) => {
      await repo.remove(req.uid, String(req.params.id));
      res.status(204).end();
    }),
  };
}
