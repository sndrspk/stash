/**
 * Archives one bookmark. See `src/lib/bookmark-action.ts` for why there is no
 * batch equivalent.
 */
import { handleBookmarkAction } from '../src/lib/bookmark-action.js';

export function POST(request: Request): Promise<Response> {
  return handleBookmarkAction(request, 'archive');
}
