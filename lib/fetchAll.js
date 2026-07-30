// /lib/fetchAll.js
// PostgREST caps every select at the project's "Max rows" setting — 1000 by default
// on Supabase. Both leaderboards aggregated a plain .select() with no range, so on
// any server with more than 1000 spins in the window they were quietly built from
// only the first 1000 rows: wrong totals, wrong ranking, missing users, and results
// that changed shape as the table grew. This pages through everything instead.
//
// buildQuery() must return a NEW query each call and must apply a stable .order(),
// otherwise paging can repeat or skip rows.
export async function selectAllRows(buildQuery, { pageSize = 1000, maxRows = 500000 } = {}) {
  const out = [];
  let truncated = false;

  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) return { data: null, error, truncated: false };
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
    if (out.length >= maxRows) {
      truncated = true;
      break;
    }
  }

  return { data: out, error: null, truncated };
}
