/**
 * The column arithmetic, with no DOM in it.
 *
 * This is the fix at the centre of the reading view, and the spec is emphatic about
 * why it exists, so it is worth restating rather than trusting to memory:
 *
 * > A CSS multi-column box only ever sizes its own border box to fit as many columns
 * > as fit its **first** screen-width viewport. Any columns beyond that render as
 * > pure visual overflow past that edge — completely outside where the box's own
 * > `padding-right` applies.
 *
 * The consequence is not cosmetic. On any article long enough to need a second
 * screenful of columns, no amount of trailing padding produces whitespace at the end
 * of the article: the text runs flush to the edge, mid-word, and nothing you do to
 * the padding changes it, because the padding is on a box whose formal edge is in
 * the wrong place.
 *
 * The fix is to stop the browser auto-fitting: measure the article's natural height
 * as a single column, divide to get the exact number of columns it needs, and give
 * the box an explicit width for that many. Then the box's own edge lands where the
 * content actually ends and the padding is real.
 *
 * Kept pure so the arithmetic can be tested at a hundred sizes without a browser —
 * the DOM half lives in `useColumnLayout`, and the 0px check that proves the whole
 * approach is a browser assertion in the Phase 6 run.
 */

export interface ColumnInputs {
  /** Height of the content rendered as one column, in px. */
  naturalHeight: number;
  /** Height available for a column: the viewport minus vertical padding, in px. */
  availableHeight: number;
  /** The reader's chosen column width, resolved to px. */
  columnWidth: number;
  /** The gutter between columns, in px. */
  gap: number;
  /** Left plus right padding of the box, in px. */
  horizontalPadding: number;
}

export interface ColumnLayout {
  columnCount: number;
  /** The explicit border-box width to set, in px. */
  width: number;
}

/**
 * How many columns the article needs, and how wide the box must be to hold exactly
 * that many.
 *
 * `ceil`, because a remainder of one line still needs a whole column to put it in.
 * At least one column, because an empty article still has a box — and because
 * `ceil(0 / h)` is 0, which would produce a negative width once the gap is
 * subtracted.
 */
export function computeColumns({
  naturalHeight,
  availableHeight,
  columnWidth,
  gap,
  horizontalPadding,
}: ColumnInputs): ColumnLayout {
  // A viewport of zero height happens in practice — a hidden tab, a measurement
  // taken before layout — and dividing by it would ask for Infinity columns.
  const usableHeight = availableHeight > 0 ? availableHeight : 1;
  const columnCount = Math.max(1, Math.ceil(naturalHeight / usableHeight));

  // n columns have n-1 gaps between them; the padding sits outside the columns.
  const width = columnCount * (columnWidth + gap) - gap + horizontalPadding;

  return { columnCount, width };
}

export interface RenderedBox {
  /** The box's own `clientWidth`: content plus padding, as laid out. */
  clientWidth: number;
  /** Left plus right padding, in px. */
  horizontalPadding: number;
  /** The `column-count` the box is actually rendering with. */
  columnCount: number;
  /** The rendered `column-gap`, in px. */
  gap: number;
}

/**
 * The distance from one column's left edge to the next, from the rendered box.
 *
 * The spec insists this be measured rather than assumed, and gives the reason:
 * columns are browser-balanced, so the width a column ends up with can differ from
 * the `column-width` that was asked for — and snapping to the requested value leaves
 * the view stopped between real columns, with words cut in half at both edges.
 *
 * That reasoning is about a layout the browser is fitting for itself. This one is
 * not: the column count and the box width are both set explicitly, from a
 * measurement, so the rendered column width is determined rather than negotiated.
 * What is read back here is still the **laid-out box** — its `clientWidth`, its
 * padding and the `column-count` it is actually rendering with — and never the
 * reader's preference, which is the thing the spec warns against trusting. If the
 * browser declined to honour the width for some reason, this reflects that.
 *
 * An earlier attempt did sample text positions with `Range.getClientRects()` and
 * infer the stride from where lines began. It does not work: a range yields one rect
 * per inline *fragment*, not per line, so a paragraph containing links or emphasis
 * contributes rects starting at arbitrary offsets. On the long fixture that gave 102
 * distinct "column starts" for a 24-column article, and a stride wrong enough that
 * page turns moved a few pixels.
 */
export function strideFromBox({
  clientWidth,
  horizontalPadding,
  columnCount,
  gap,
}: RenderedBox): number | null {
  if (!Number.isFinite(columnCount) || columnCount < 1) return null;
  const content = clientWidth - horizontalPadding;
  if (!Number.isFinite(content) || content <= 0) return null;

  // n columns and n-1 gaps span the content box, so one column plus one gap is
  // (content + gap) / n.
  return (content + gap) / columnCount;
}

/**
 * Where to land after a scroll settles.
 *
 * Both ends of the article are special cases, and for the same reason: they are the
 * two places where the padding is the point.
 *
 * The **first** column returns to exactly 0 rather than to a computed boundary, so
 * the article's opening keeps the intro padding it was laid out with. Rounding it to
 * "column 0's boundary" would shave that off and the article would begin flush
 * against the edge.
 *
 * The **last** does the mirror image, and it is easy to get wrong. Rounding to the
 * nearest boundary near the end lands a little short of the true end, which puts the
 * viewport's right edge *inside* the final column and cuts it — the article's closing
 * lines truncated mid-word, with the trailing whitespace the explicit width was built
 * to produce sitting just off screen. So anything within half a stride of the end
 * goes to the end.
 */
export function snapTarget(
  scrollLeft: number,
  stride: number,
  maxScrollLeft: number,
  padding = 0,
): number {
  if (stride <= 0) return scrollLeft;
  if (scrollLeft <= stride / 2) return 0;
  if (maxScrollLeft - scrollLeft <= stride / 2) return maxScrollLeft;

  const index = Math.round((scrollLeft - padding) / stride);
  const target = index * stride + padding;
  return Math.max(0, Math.min(target, maxScrollLeft));
}

/**
 * How far one page turn moves.
 *
 * A page is what the reader can see, rounded down to whole columns — turning by one
 * column on a wide desktop window would move a three-column view by a third of a
 * screen, which reads as a jitter rather than as a page. Never less than one column,
 * or a narrow window would not turn at all.
 */
export function pageStride(viewportWidth: number, stride: number): number {
  if (stride <= 0) return viewportWidth;
  return Math.max(1, Math.floor(viewportWidth / stride)) * stride;
}
