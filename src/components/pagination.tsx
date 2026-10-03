import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/** "Showing 51–100 of 240" with Previous / Next links that keep the current filters. */
export function Pagination({
  path,
  params,
  page,
  pageCount,
  pageSize,
  total,
  noun,
}: {
  path: string;
  /** The filters currently in the address, so the links keep them. */
  params: Record<string, string>;
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  /** What is being listed, in the plural: "products", "entries". */
  noun: string;
}) {
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  function href(target: number): string {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== ""));
    if (target > 1) query.set("page", String(target));
    const text = query.toString();
    return text ? `${path}?${text}` : path;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground" data-testid="pagination">
      <span>
        {first > total ? `No more ${noun}.` : `Showing ${first.toLocaleString("en-NG")}–${last.toLocaleString("en-NG")} of ${total.toLocaleString("en-NG")} ${noun}`}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={href(page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })} scroll={false}>
              <ChevronLeft className="size-4" aria-hidden /> Previous
            </Link>
          ) : (
            <span className={buttonVariants({ variant: "outline", size: "sm", className: "pointer-events-none opacity-40" })}>
              <ChevronLeft className="size-4" aria-hidden /> Previous
            </span>
          )}
          <span className="px-1 text-foreground">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link href={href(page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })} scroll={false}>
              Next <ChevronRight className="size-4" aria-hidden />
            </Link>
          ) : (
            <span className={buttonVariants({ variant: "outline", size: "sm", className: "pointer-events-none opacity-40" })}>
              Next <ChevronRight className="size-4" aria-hidden />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
