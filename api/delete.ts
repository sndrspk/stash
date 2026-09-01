/**
 * Deletes one bookmark.
 *
 * Irreversible at Instapaper — there is no undo on their side, only ours before the
 * request is sent. That is the sharpest reason this endpoint takes a single id.
 */
import { handleBookmarkAction } from '../src/lib/bookmark-action.js';

export function POST(request: Request): Promise<Response> {
  return handleBookmarkAction(request, 'delete');
}
