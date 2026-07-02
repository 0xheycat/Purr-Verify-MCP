/**
 * Shimmer loading skeletons for the verify dashboard.
 *
 * Each skeleton pairs a base `animate-pulse` tint with the `.shimmer-bg`
 * overlay (defined in globals.css) to produce a polished amber gradient sweep.
 */

function ShimmerBar({ className }: { className?: string }) {
  return (
    <div
      className={`shimmer-bg animate-pulse rounded-md bg-muted/50 ${className ?? ""}`}
    />
  );
}

/** A single stat card skeleton (label + value block). */
export function StatCardSkeleton() {
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5">
      <ShimmerBar className="h-2.5 w-16" />
      <ShimmerBar className="mt-2 h-4 w-24" />
    </div>
  );
}

/**
 * Skeleton matching the JobsTable column layout:
 * Job · Repo/Ref · Status · Exit · Duration · Started · Actions.
 * Six shimmer rows render inside the same table structure so the
 * skeleton hugs the real column widths.
 */
export function JobsTableSkeleton() {
  const rows = Array.from({ length: 6 }, (_, i) => i);
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="max-h-[28rem] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2.5 text-left font-medium">Job</th>
              <th className="px-3 py-2.5 text-left font-medium">Repo / Ref</th>
              <th className="px-3 py-2.5 text-left font-medium">Status</th>
              <th className="px-3 py-2.5 text-left font-medium">Exit</th>
              <th className="px-3 py-2.5 text-left font-medium">Duration</th>
              <th className="px-3 py-2.5 text-left font-medium">Started</th>
              <th className="px-3 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((i) => (
              <tr key={i} className={i % 2 === 1 ? "bg-muted/10" : ""}>
                <td className="px-3 py-2.5">
                  <ShimmerBar className="h-3 w-16" />
                  <ShimmerBar className="mt-1.5 h-2 w-10" />
                </td>
                <td className="px-3 py-2.5">
                  <ShimmerBar className="h-3 w-32" />
                  <ShimmerBar className="mt-1.5 h-2 w-24" />
                </td>
                <td className="px-3 py-2.5">
                  <ShimmerBar className="h-5 w-20 rounded-full" />
                </td>
                <td className="px-3 py-2.5">
                  <ShimmerBar className="h-3 w-6" />
                </td>
                <td className="px-3 py-2.5">
                  <ShimmerBar className="h-3 w-12" />
                </td>
                <td className="px-3 py-2.5">
                  <ShimmerBar className="h-3 w-28" />
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex justify-end">
                    <ShimmerBar className="h-6 w-16" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Skeleton mimicking the JobDetail summary header —
 * the title row + 4 stat cards + 3 command accordion rows.
 */
export function JobDetailSkeleton() {
  return (
    <div className="space-y-5">
      {/* Toolbar placeholder (Back + actions) */}
      <div className="flex items-center justify-between">
        <ShimmerBar className="h-8 w-36" />
        <div className="flex gap-2">
          <ShimmerBar className="h-8 w-36" />
          <ShimmerBar className="h-8 w-24" />
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <ShimmerBar className="h-3 w-32" />
          <ShimmerBar className="h-3 w-8" />
        </div>
        <ShimmerBar className="h-1.5 w-full" />
      </div>

      {/* Summary header card */}
      <div className="relative rounded-xl p-[1px] bg-gradient-to-r from-amber-500/30 via-orange-500/20 to-amber-500/30">
        <div className="rounded-[11px] bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <ShimmerBar className="h-5 w-24" />
                <ShimmerBar className="h-5 w-20 rounded-full" />
              </div>
              <ShimmerBar className="h-3 w-56" />
            </div>
            <div className="space-y-1.5 text-right">
              <ShimmerBar className="h-3 w-40" />
              <ShimmerBar className="h-3 w-40" />
              <ShimmerBar className="h-3 w-40" />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </div>
        </div>
      </div>

      {/* Commands card */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <ShimmerBar className="h-4 w-4 rounded-full" />
          <ShimmerBar className="h-3 w-28" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <ShimmerBar className="h-4 w-4 rounded-full" />
              <ShimmerBar className="h-3 flex-1" />
              <ShimmerBar className="h-3 w-12" />
              <ShimmerBar className="h-3 w-10" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
